from __future__ import annotations

import base64
import collections
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import http.client
import json
import math
import os
import queue
import re
import select
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator


class BridgeError(RuntimeError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{message} [{code}]")


class BridgeTimeoutError(BridgeError):
    pass


def _timeout(value: float) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or not 0 < value <= 600_000:
        raise ValueError("timeout must be a finite number of milliseconds from 1 to 600000")
    return value


def _host_path(explicit: str | os.PathLike[str] | None) -> str:
    configured = explicit or os.environ.get("BROWSER_BRIDGE_HOST")
    if configured:
        path = Path(configured).expanduser()
        if not path.is_file():
            raise BridgeError("not_installed", f"Browser Bridge executable not found: {path}")
        return str(path)
    if os.name == "nt":
        home = Path(os.environ.get("LOCALAPPDATA", Path.home().joinpath("AppData", "Local")))
        installed = home.joinpath("BrowserBridge", "app", "BrowserBridge.exe")
    else:
        installed = Path.home().joinpath(".browser-bridge", "app", "BrowserBridge")
    if installed.is_file():
        return str(installed)
    executable = shutil.which("BrowserBridge")
    if executable:
        return executable
    raise BridgeError("not_installed", "Install Browser Bridge with scripts\\install.ps1 and load its browser extension. No Playwright browser installation is needed.")


class _Transport:
    def __init__(self, host: str):
        self.process = subprocess.Popen(
            [host, "rpc"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        self._responses: queue.Queue[dict[str, Any] | Exception] = queue.Queue()
        self._stderr: collections.deque[str] = collections.deque(maxlen=32)
        self._lock = threading.Lock()
        self._next_id = 1
        self._closed = False
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        try:
            assert self.process.stdout is not None
            for line in self.process.stdout:
                try:
                    response = json.loads(line)
                except json.JSONDecodeError as error:
                    self._responses.put(BridgeError("protocol_error", f"Invalid RPC JSON: {error}"))
                    return
                if not isinstance(response, dict):
                    self._responses.put(BridgeError("protocol_error", "RPC response is not an object."))
                    return
                self._responses.put(response)
        except (OSError, ValueError) as error:
            self._responses.put(BridgeError("connection_lost", str(error)))
        finally:
            self._responses.put(BridgeError("connection_lost", "Browser Bridge RPC exited. " + "".join(self._stderr)[-2000:]))

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        try:
            for line in self.process.stderr:
                self._stderr.append(line)
        except (OSError, ValueError):
            if not self._closed:
                self._responses.put(BridgeError("connection_lost", "Could not read the host's diagnostic stream."))

    def call(self, method: str, parameters: dict[str, Any], timeout: float, browser: str | None = None) -> Any:
        _timeout(timeout)
        with self._lock:
            if self._closed:
                raise BridgeError("closed", "The Browser Bridge connection is closed.")
            request_id = self._next_id
            self._next_id += 1
            message = {"id": request_id, "method": method, "params": parameters, "timeoutMs": timeout}
            if browser is not None:
                message["browser"] = browser
            encoded = json.dumps(message, ensure_ascii=False, allow_nan=False)
            if len(encoded.encode("utf-8")) > 900_000:
                raise BridgeError("request_too_large", "Request exceeds the native messaging envelope. Upload large data through a page-supported transfer API.")
            try:
                assert self.process.stdin is not None
                self.process.stdin.write(encoded + "\n")
                self.process.stdin.flush()
            except (OSError, ValueError) as error:
                raise BridgeError("connection_lost", f"Could not send request; it will not be replayed: {error}") from error
            try:
                response = self._responses.get(timeout=timeout / 1000 + 5)
            except queue.Empty as error:
                self.close()
                raise BridgeTimeoutError("timeout", "The host did not respond. The operation may have completed; inspect before retrying.") from error
            if isinstance(response, Exception):
                raise response
            if response.get("id") != request_id:
                self.close()
                raise BridgeError("protocol_error", "RPC response id does not match the request.")
            if response.get("ok") is not True:
                details = response.get("error")
                if not isinstance(details, dict) or not isinstance(details.get("message"), str):
                    raise BridgeError("protocol_error", "RPC failure is missing its error details.")
                code = details.get("code", "error")
                exception = BridgeTimeoutError if code == "timeout" else BridgeError
                raise exception(code, details["message"])
            if "result" not in response:
                raise BridgeError("protocol_error", "RPC success is missing its result.")
            return response["result"]

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self.process.stdin is not None:
            try:
                self.process.stdin.close()
            except (OSError, ValueError):
                if self.process.poll() is None:
                    self.process.terminate()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        for stream in (self.process.stdout, self.process.stderr):
            if stream is not None:
                stream.close()


class _IpcPeer:
    """Single-thread chunked JSON-line IPC peer using PeekNamedPipe (Windows) and select (Unix) for non-deadlocking timeouts."""

    _MAX_FRAME_BYTES = 68 * 1024 * 1024
    _peek_pipe: Any = None

    @classmethod
    def _init_peek_pipe(cls) -> Any:
        if cls._peek_pipe is None:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.PeekNamedPipe.argtypes = [
                wintypes.HANDLE,
                ctypes.c_void_p,
                wintypes.DWORD,
                ctypes.POINTER(wintypes.DWORD),
                ctypes.POINTER(wintypes.DWORD),
                ctypes.POINTER(wintypes.DWORD),
            ]
            kernel32.PeekNamedPipe.restype = wintypes.BOOL
            cls._peek_pipe = kernel32.PeekNamedPipe
        return cls._peek_pipe

    def __init__(self, stream: Any, sock: socket.socket | None):
        self.stream = stream
        self.sock = sock
        self._buf = bytearray()
        self._closed = False
        self.tabs_dirty = False
        self._win_handle: int | None = None
        if self.sock is not None:
            self.sock.setblocking(False)
        elif os.name == "nt" and self.stream is not None and hasattr(self.stream, "fileno"):
            try:
                import msvcrt
                self._win_handle = msvcrt.get_osfhandle(self.stream.fileno())
                self._init_peek_pipe()
            except (OSError, AttributeError, ValueError):
                self._win_handle = None

    def send_line(self, text: str) -> None:
        data = (text + "\n").encode("utf-8")
        if self.sock is not None:
            view = memoryview(data)
            sent = 0
            while sent < len(data):
                _, writable, _ = select.select([], [self.sock], [], 10.0)
                if not writable:
                    raise TimeoutError("IPC write timed out.")
                sent += self.sock.send(view[sent:])
        else:
            self.stream.write(data)
            self.stream.flush()

    def _read_chunk(self, deadline: float) -> bytes:
        if self.sock is not None:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("IPC read timed out.")
                ready, _, _ = select.select([self.sock], [], [], remaining)
                if not ready:
                    raise TimeoutError("IPC read timed out.")
                try:
                    return self.sock.recv(65536)
                except BlockingIOError:
                    continue

        if self._win_handle is not None:
            peek = self._init_peek_pipe()
            avail = wintypes.DWORD(0)
            started = time.monotonic()
            while True:
                if not peek(self._win_handle, None, 0, None, ctypes.byref(avail), None):
                    return b""
                if avail.value > 0:
                    return self.stream.read(min(int(avail.value), 65536)) or b""
                now = time.monotonic()
                remaining = deadline - now
                if remaining <= 0:
                    raise TimeoutError("IPC read timed out.")
                elapsed = now - started
                step = 0.0005 if elapsed < 0.002 else (0.002 if elapsed < 0.02 else 0.01)
                time.sleep(min(step, remaining))

        if getattr(self.stream, "_accepts_deadline", False):
            return self.stream.read(65536, deadline)
        return self.stream.read(65536) or b""

    def recv_message(self, timeout_s: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        try:
            while not self._closed:
                while True:
                    nl = self._buf.find(b"\n")
                    if nl < 0:
                        if len(self._buf) > self._MAX_FRAME_BYTES:
                            self.close()
                            raise BridgeError("protocol_error", "IPC message exceeds maximum frame size.")
                        break
                    raw = bytes(self._buf[:nl])
                    del self._buf[: nl + 1]
                    if not raw.strip():
                        continue
                    msg = json.loads(raw.decode("utf-8"))
                    if isinstance(msg, dict) and msg.get("type") == "event":
                        if msg.get("event") == "tabs.changed":
                            self.tabs_dirty = True
                        continue
                    if not isinstance(msg, dict):
                        self.close()
                        raise BridgeError("protocol_error", "IPC response must be a JSON object.")
                    return msg

                chunk = self._read_chunk(deadline)
                if not chunk:
                    self.close()
                    raise BridgeError("connection_lost", "The browser disconnected.")
                self._buf.extend(chunk)
        except TimeoutError as err:
            self.close()
            raise BridgeTimeoutError("timeout", "The host did not respond. The operation may have completed; inspect before retrying.") from err
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            self.close()
            raise BridgeError("protocol_error", f"Invalid response JSON: {err}") from err
        except BridgeError:
            raise
        except OSError as err:
            self.close()
            raise BridgeError("connection_lost", f"The browser disconnected ({err}).") from err
        raise BridgeError("closed", "The Browser Bridge connection is closed.")

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._win_handle = None
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
        if self.stream is not None:
            try:
                self.stream.close()
            except OSError:
                pass


def _normalize_label_slug(value: str) -> str:
    collapsed = re.sub(r"[\s\-_\[\]]+", "-", value.strip().lower()).strip("-")
    return collapsed


def _label_matches(actual: str, query: str) -> bool:
    if not actual or not query:
        return False
    if actual.lower() == query.lower():
        return True
    s_act = _normalize_label_slug(actual)
    s_qry = _normalize_label_slug(query)
    return bool(s_act) and s_act == s_qry


def _is_hex_prefix(value: str) -> bool:
    return 4 <= len(value) <= 12 and bool(re.fullmatch(r"[0-9a-fA-F]{4,12}", value))


def _choose_endpoint_candidates(
    endpoints: list[tuple[str, str, str]],
    selector: str,
    labels: dict[str, str],
) -> list[tuple[str, str, str]]:
    sel = selector.strip()
    if not sel:
        return []
    if ":" in sel:
        b_raw, q_raw = sel.split(":", 1)
        b = b_raw.strip().lower()
        q = q_raw.strip()
        if not b or not q:
            return []
        pool = [ep for ep in endpoints if ep[1].lower() == b]
        if not pool and b == "chrome":
            pool = [ep for ep in endpoints if ep[1] == "chromium"]
        if not pool:
            return []
        exact_id = [ep for ep in pool if ep[2].lower() == q.lower()]
        if exact_id:
            return exact_id
        by_lbl = [ep for ep in pool if _label_matches(labels.get(ep[0], ""), q)]
        if by_lbl:
            return by_lbl
        if _is_hex_prefix(q):
            q_low = q.lower()
            by_pref = [ep for ep in pool if ep[2].startswith(q_low)]
            if by_pref:
                return by_pref
        return []

    exact_id = [ep for ep in endpoints if ep[2].lower() == sel.lower()]
    if exact_id:
        return exact_id
    by_lbl = [ep for ep in endpoints if _label_matches(labels.get(ep[0], ""), sel)]
    if by_lbl:
        return by_lbl
    by_browser = [ep for ep in endpoints if ep[1].lower() == sel.lower()]
    if by_browser:
        return by_browser
    if sel.lower() == "chrome":
        by_chromium = [ep for ep in endpoints if ep[1] == "chromium"]
        if by_chromium:
            return by_chromium
    if _is_hex_prefix(sel):
        low = sel.lower()
        by_pref = [ep for ep in endpoints if ep[2].startswith(low)]
        if by_pref:
            return by_pref
    return []


class _DirectTransport:
    """Connects directly to the browser native-host pipe or Unix socket without spawning an rpc process."""

    _PRIORITY = ("edge", "chrome", "chromium", "firefox", "unknown")
    _CACHED_USER_KEY: str | None = None
    _ENDPOINT_CACHE_TTL_S = 0.25

    def __init__(self, selector: str | None = None):
        self._selector = selector
        self._lock = threading.Lock()
        self._next_id = 1
        self._closed = False
        self._peer: _IpcPeer | None = None
        self._active_pipe: str | None = None
        self._multi_enabled = False
        self._peers: dict[str, tuple[tuple[str, str, str], _IpcPeer, dict[str, Any]]] = {}
        self._tab_owners: dict[int, list[dict[str, Any]]] = {}
        self._controllable_counts: dict[str, int] = {}
        self._endpoint_cache: tuple[float, tuple[str, ...], list[tuple[str, str, str]]] | None = None
        self._synced_pipe_sig: tuple[str, ...] | None = None
        self.info: dict[str, Any] = {}

    @classmethod
    def _current_user_key(cls) -> str:
        if cls._CACHED_USER_KEY is not None:
            return cls._CACHED_USER_KEY
        resolved: str | None = None
        if os.name == "nt":
            try:
                advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
                kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel32.GetCurrentProcess.restype = wintypes.HANDLE
                advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
                advapi32.OpenProcessToken.restype = wintypes.BOOL
                advapi32.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
                advapi32.GetTokenInformation.restype = wintypes.BOOL
                advapi32.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
                advapi32.ConvertSidToStringSidW.restype = wintypes.BOOL
                kernel32.LocalFree.argtypes = [ctypes.c_void_p]
                kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

                token = wintypes.HANDLE()
                if advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
                    try:
                        needed = wintypes.DWORD(0)
                        advapi32.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
                        if needed.value:
                            buf = ctypes.create_string_buffer(needed.value)
                            if advapi32.GetTokenInformation(token, 1, buf, needed, ctypes.byref(needed)):
                                sid_ptr = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
                                str_ptr = wintypes.LPWSTR()
                                if advapi32.ConvertSidToStringSidW(sid_ptr, ctypes.byref(str_ptr)):
                                    try:
                                        resolved = str(str_ptr.value)
                                    finally:
                                        kernel32.LocalFree(str_ptr)
                    finally:
                        kernel32.CloseHandle(token)
            except OSError:
                pass
            if not resolved:
                resolved = re.sub(r"[^A-Za-z0-9-]", "-", os.environ.get("USERNAME", "user")) or "user"
        else:
            resolved = re.sub(r"[^A-Za-z0-9-]", "-", os.environ.get("USER", "user")) or "user"
        cls._CACHED_USER_KEY = resolved
        return resolved

    @staticmethod
    def _unix_socket_dir() -> Path:
        xdg = os.environ.get("XDG_RUNTIME_DIR")
        if xdg and len(xdg) <= 40:
            xdg_path = Path(xdg)
            if xdg_path.is_dir():
                return xdg_path / "browser-bridge"
        uid = os.geteuid() if hasattr(os, "geteuid") else 0
        tmp = Path(tempfile.gettempdir())
        if len(str(tmp)) <= 32:
            return tmp / f"bb-{uid}"
        slash_tmp = Path("/tmp")
        return (slash_tmp if slash_tmp.is_dir() else tmp) / f"bb-{uid}"

    @classmethod
    def _discover(cls) -> list[tuple[str, str, str]]:
        user_key = re.sub(r"[^A-Za-z0-9-]", "-", cls._current_user_key()) or "user"
        browsers = {"edge", "chrome", "chromium", "firefox", "unknown"}
        names: list[str] = []
        if os.name == "nt":
            try:
                names = [n for n in os.listdir(r"\\.\pipe\\") if n.startswith("browser-bridge.")]
            except OSError:
                names = []
        else:
            sock_dir = cls._unix_socket_dir()
            try:
                st = os.lstat(sock_dir)
                if hasattr(os, "geteuid") and (st.st_uid != os.geteuid() or (st.st_mode & 0o077) != 0):
                    names = []
                else:
                    names = [n for n in os.listdir(sock_dir) if n.startswith("browser-bridge.")]
            except OSError:
                names = []
        endpoints: list[tuple[str, str, str]] = []
        for name in names:
            parts = name.split(".")
            if len(parts) == 4 and parts[0] == "browser-bridge" and parts[1] == user_key and parts[2] in browsers and re.fullmatch(r"[0-9a-f]{12}", parts[3]):
                endpoints.append((name, parts[2], parts[3]))
        return endpoints

    def _discover_cached(self, force: bool = False) -> tuple[list[tuple[str, str, str]], tuple[str, ...]]:
        now = time.monotonic()
        any_dirty = any(entry[1].tabs_dirty or entry[1]._closed for entry in self._peers.values())
        if (
            not force
            and not any_dirty
            and self._endpoint_cache is not None
            and self._endpoint_cache[2]
            and (now - self._endpoint_cache[0]) < self._ENDPOINT_CACHE_TTL_S
        ):
            return list(self._endpoint_cache[2]), self._endpoint_cache[1]
        eps = self._discover()
        sig = tuple(sorted(e[0] for e in eps))
        self._endpoint_cache = (now, sig, eps)
        return list(eps), sig

    @classmethod
    def _open_pipe(cls, pipe_name: str, timeout_s: float = 5.0) -> _IpcPeer:
        if os.name == "nt":
            path = rf"\\.\pipe\{pipe_name}"
            deadline = time.monotonic() + timeout_s
            while True:
                try:
                    return _IpcPeer(open(path, "r+b", buffering=0), None)
                except OSError as err:
                    if getattr(err, "winerror", None) == 231 and time.monotonic() < deadline:
                        time.sleep(0.025)
                        continue
                    raise
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(timeout_s)
            sock.connect(str(cls._unix_socket_dir() / pipe_name))
        except BaseException:
            sock.close()
            raise
        return _IpcPeer(None, sock)

    @classmethod
    def _handshake(cls, pipe_name: str, subscribe_events: bool = True) -> tuple[_IpcPeer, dict[str, Any]]:
        peer = cls._open_pipe(pipe_name)
        try:
            hello = json.dumps(
                {"type": "hello", "client": "python-sdk", "pid": os.getpid(), "events": subscribe_events},
                ensure_ascii=False,
            )
            peer.send_line(hello)
            return peer, peer.recv_message(5.0)
        except BaseException:
            peer.close()
            raise

    def _ensure_peers_parallel(self, endpoints: list[tuple[str, str, str]]) -> None:
        live_names = {ep[0] for ep in endpoints}
        for name in list(self._peers.keys()):
            if name not in live_names or self._peers[name][1]._closed:
                _, dead_peer, _ = self._peers.pop(name)
                dead_peer.close()
        missing = [ep for ep in endpoints if ep[0] not in self._peers]
        if not missing:
            return
        if len(missing) == 1:
            ep = missing[0]
            try:
                peer, info = self._handshake(ep[0], True)
                self._peers[ep[0]] = (ep, peer, info)
            except (OSError, ValueError, BridgeError):
                pass
            return

        results: dict[str, tuple[tuple[str, str, str], _IpcPeer, dict[str, Any]]] = {}
        res_lock = threading.Lock()

        def _worker(ep: tuple[str, str, str]) -> None:
            try:
                peer, info = self._handshake(ep[0], True)
                with res_lock:
                    results[ep[0]] = (ep, peer, info)
            except (OSError, ValueError, BridgeError):
                pass

        threads = [threading.Thread(target=_worker, args=(ep,), daemon=True) for ep in missing]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5.5)
        self._peers.update(results)

    def _raw_peer_call(self, peer: _IpcPeer, method: str, parameters: dict[str, Any], timeout_ms: float) -> Any:
        request_id = self._next_id
        self._next_id += 1
        encoded = json.dumps({"id": request_id, "method": method, "params": parameters}, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode("utf-8")) > 900_000:
            raise BridgeError("request_too_large", "Request exceeds the native messaging envelope. Upload large data through a page-supported transfer API.")
        peer.send_line(encoded)
        response = peer.recv_message(timeout_ms / 1000.0 + 5.0)
        if response.get("id") != request_id:
            peer.close()
            raise BridgeError("protocol_error", "Response id does not match the request.")
        if response.get("ok") is not True:
            details = response.get("error")
            if not isinstance(details, dict) or not isinstance(details.get("message"), str):
                raise BridgeError("protocol_error", "Response failure is missing error details.")
            code = details.get("code", "error")
            exception = BridgeTimeoutError if code == "timeout" else BridgeError
            raise exception(code, details["message"])
        return response.get("result")

    def _sync_inventory(self, endpoints: list[tuple[str, str, str]], sig: tuple[str, ...]) -> None:
        self._ensure_peers_parallel(endpoints)
        inv_results: dict[str, dict[str, Any]] = {}
        inv_lock = threading.Lock()

        def _fetch_inv(pipe_name: str, entry: tuple[tuple[str, str, str], _IpcPeer, dict[str, Any]]) -> None:
            _, peer, _ = entry
            try:
                peer.tabs_dirty = False
                res = self._raw_peer_call(peer, "tabs.inventory", {"_noLearn": True}, 1500.0)
                if isinstance(res, dict):
                    with inv_lock:
                        inv_results[pipe_name] = res
            except (OSError, ValueError, BridgeError):
                pass

        items = list(self._peers.items())
        if len(items) <= 1:
            for k, v in items:
                _fetch_inv(k, v)
        else:
            # Assign distinct request ids safely before parallel send/recv on separate pipes
            req_frames: list[tuple[str, _IpcPeer, int, str]] = []
            for pipe_name, (_, peer, _) in items:
                peer.tabs_dirty = False
                rid = self._next_id
                self._next_id += 1
                frame = json.dumps({"id": rid, "method": "tabs.inventory", "params": {"_noLearn": True}}, ensure_ascii=False)
                req_frames.append((pipe_name, peer, rid, frame))

            def _parallel_inv(p_name: str, p_peer: _IpcPeer, rid: int, frame: str) -> None:
                try:
                    p_peer.send_line(frame)
                    resp = p_peer.recv_message(2.0)
                    if resp.get("id") == rid and resp.get("ok") is True and isinstance(resp.get("result"), dict):
                        with inv_lock:
                            inv_results[p_name] = resp["result"]
                except (OSError, ValueError, BridgeError):
                    pass

            threads = [threading.Thread(target=_parallel_inv, args=rf, daemon=True) for rf in req_frames]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=2.5)

        tab_owners: dict[int, list[dict[str, Any]]] = {}
        ctrl_counts: dict[str, int] = {}
        for pipe_name, (ep, _, info) in self._peers.items():
            inv = inv_results.get(pipe_name, {})
            tabs = inv.get("tabs") if isinstance(inv, dict) else None
            label = str(info.get("label") or "")
            ctrl = 0
            for tab in tabs or []:
                if not isinstance(tab, dict) or not isinstance(tab.get("tabId"), int):
                    continue
                tid = int(tab["tabId"])
                controllable = bool(tab.get("controllable", True))
                if controllable:
                    ctrl += 1
                tab_owners.setdefault(tid, []).append({
                    "pipe_name": pipe_name,
                    "browser": ep[1],
                    "instance_id": ep[2],
                    "label": label,
                    "url": str(tab.get("url") or ""),
                    "controllable": controllable,
                })
            ctrl_counts[pipe_name] = ctrl

        self._tab_owners = tab_owners
        self._controllable_counts = ctrl_counts
        self._synced_pipe_sig = sig

    def _ensure_inventory_fresh(self, endpoints: list[tuple[str, str, str]], sig: tuple[str, ...], force: bool = False) -> None:
        if len(endpoints) < 2:
            return
        any_dirty = any(entry[1].tabs_dirty or entry[1]._closed for entry in self._peers.values())
        if force or any_dirty or self._synced_pipe_sig != sig:
            self._sync_inventory(endpoints, sig)

    def _select_active(self, pipe_name: str) -> tuple[_IpcPeer, dict[str, Any]]:
        _, peer, info = self._peers[pipe_name]
        self._active_pipe = pipe_name
        self._peer = peer
        self.info = info
        return peer, info

    def connect(self) -> dict[str, Any]:
        endpoints, sig = self._discover_cached(force=True)
        if not endpoints:
            raise BridgeError("unavailable", "No browser is connected to Browser Bridge. Make sure Edge, Chrome or Firefox is running with the Browser Bridge extension loaded (toolbar icon shows a green dot) and that the native host is installed.")
        sel = (self._selector or "").strip()
        if sel:
            # Fast single-pipe shortcut when selector uniquely matches instanceId or sole browser without needing label handshake
            direct = _choose_endpoint_candidates(endpoints, sel, {}) if ":" not in sel else []
            if len(direct) == 1:
                chosen = direct[0]
                peer, browser_info = self._handshake(chosen[0], True)
                self._peers[chosen[0]] = (chosen, peer, browser_info)
                self._select_active(chosen[0])
            else:
                self._ensure_peers_parallel(endpoints)
                labels = {k: str(v[2].get("label") or "") for k, v in self._peers.items()}
                live_eps = [v[0] for v in self._peers.values()]
                matches = _choose_endpoint_candidates(live_eps, sel, labels)
                if not matches:
                    raise BridgeError("unavailable", f'No connected browser matches "{sel}".')
                if len(matches) > 1:
                    choices = [
                        f"{m[1]}:{labels[m[0]]} ({m[2]})" if labels.get(m[0]) else f"{m[1]}:{m[2]}"
                        for m in matches
                    ]
                    for m in list(self._peers.keys()):
                        self._peers.pop(m)[1].close()
                    raise BridgeError(
                        "ambiguous_browser",
                        f'Multiple connected browsers match "{sel}": {", ".join(choices)}. Pass "{matches[0][1]}:{matches[0][2][:4]}" or browser:label to disambiguate.',
                    )
                chosen = matches[0]
                for pipe_name in list(self._peers.keys()):
                    if pipe_name != chosen[0]:
                        self._peers.pop(pipe_name)[1].close()
                _, _, browser_info = self._peers[chosen[0]]
                self._select_active(chosen[0])
        else:
            self._multi_enabled = True
            endpoints.sort(key=lambda e: self._PRIORITY.index(e[1]) if e[1] in self._PRIORITY else 99)
            if len(endpoints) == 1:
                chosen = endpoints[0]
                peer, browser_info = self._handshake(chosen[0], True)
                self._peers[chosen[0]] = (chosen, peer, browser_info)
                self._select_active(chosen[0])
            else:
                self._sync_inventory(endpoints, sig)
                live_eps = [ep for ep in endpoints if ep[0] in self._peers]
                if not live_eps:
                    raise BridgeError("unavailable", "Could not connect to any discovered Browser Bridge endpoint.")
                with_tabs = [ep for ep in live_eps if self._controllable_counts.get(ep[0], 0) > 0]
                chosen = with_tabs[0] if len(with_tabs) == 1 else live_eps[0]
                _, browser_info = self._select_active(chosen[0])

        status = self.call("status", {}, 30_000)
        return {
            "protocol": 1,
            "hostVersion": browser_info.get("hostVersion", ""),
            "browser": browser_info,
            "status": status,
        }

    @staticmethod
    def _anonymous_fetch(parameters: dict[str, Any], timeout_ms: float) -> dict[str, Any]:
        url = parameters.get("url")
        if not isinstance(url, str):
            raise BridgeError("bad_request", "Requests require an absolute HTTP(S) URL without embedded credentials.")
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
            raise BridgeError("bad_request", "Requests require an absolute HTTP(S) URL without embedded credentials.")
        max_bytes = parameters.get("maxBytes", 20 * 1024 * 1024)
        if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or not 1 <= max_bytes <= 32 * 1024 * 1024:
            raise BridgeError("bad_request", "maxBytes must be between 1 and 33554432.")
        method = str(parameters.get("method", "GET")).upper()
        headers = parameters.get("headers") or {}
        if not isinstance(headers, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in headers.items()):
            raise BridgeError("bad_request", "headers must be an object of strings.")
        body_raw = parameters.get("body")
        data = body_raw.encode("utf-8") if isinstance(body_raw, str) else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        opener = urllib.request.build_opener(urllib.request.HTTPHandler(), urllib.request.HTTPSHandler())
        try:
            resp = opener.open(req, timeout=timeout_ms / 1000.0)
            status = resp.status
            resp_url = resp.geturl()
            resp_headers = resp.headers
        except urllib.error.HTTPError as err:
            resp = err
            status = err.code
            resp_url = err.geturl()
            resp_headers = err.headers
        except (urllib.error.URLError, OSError, http.client.HTTPException) as err:
            raise BridgeError("request_failed", str(err)) from err

        try:
            declared = resp_headers.get("Content-Length")
            if declared is not None and int(declared) > max_bytes:
                raise BridgeError("body_too_large", f"Response exceeds the {max_bytes}-byte limit.")
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise BridgeError("body_too_large", f"Response exceeds the {max_bytes}-byte limit.")
                chunks.append(chunk)
            payload = b"".join(chunks)
        finally:
            resp.close()

        out_headers = {k.lower(): v for k, v in resp_headers.items() if k.lower() != "set-cookie"}
        return {
            "status": status,
            "url": resp_url,
            "headers": out_headers,
            "data": base64.b64encode(payload).decode("ascii"),
            "byteLength": len(payload),
        }

    def _route_multi_browser_tab(self, method: str, parameters: dict[str, Any]) -> None:
        if not self._multi_enabled or self._selector:
            return
        tid = parameters.get("tabId")
        if not isinstance(tid, int) or isinstance(tid, bool):
            return
        endpoints, sig = self._discover_cached(force=False)
        if len(endpoints) < 2:
            return
        self._ensure_inventory_fresh(endpoints, sig, force=False)
        live_names = {e[0] for e in endpoints}
        owners = [o for o in self._tab_owners.get(tid, []) if o["pipe_name"] in live_names]
        if not owners:
            self._ensure_inventory_fresh(endpoints, sig, force=True)
            owners = [o for o in self._tab_owners.get(tid, []) if o["pipe_name"] in live_names]
        if len(owners) == 1:
            owner_pipe = owners[0]["pipe_name"]
            if owner_pipe in self._peers and owner_pipe != self._active_pipe:
                self._select_active(owner_pipe)
        elif len(owners) >= 2:
            tags = [
                f"{o['browser']}:{_normalize_label_slug(o['label'])}" if o["label"] else f"{o['browser']}:{o['instance_id'][:4]}"
                for o in owners
            ]
            raise BridgeError(
                "ambiguous_tab",
                f'Tab {tid} is shared in multiple connected browsers ({", ".join(tags)}). Instantiate BrowserBridge(browser="{tags[0]}") to disambiguate.',
            )

    def _record_response_tabs(self, method: str, parameters: dict[str, Any], result: Any) -> None:
        if not self._multi_enabled or not self._active_pipe or self._active_pipe not in self._peers or not isinstance(result, dict):
            return
        pipe_name = self._active_pipe
        if method == "tabs.close":
            closed_id = result.get("closed")
            if isinstance(closed_id, int) and closed_id in self._tab_owners:
                self._tab_owners[closed_id] = [o for o in self._tab_owners[closed_id] if o["pipe_name"] != pipe_name]
            for cid in result.get("closedTabs") or []:
                if isinstance(cid, int) and cid in self._tab_owners:
                    self._tab_owners[cid] = [o for o in self._tab_owners[cid] if o["pipe_name"] != pipe_name]
            return
        tid = result.get("tabId") if isinstance(result.get("tabId"), int) else parameters.get("tabId")
        if isinstance(tid, int) and not isinstance(tid, bool):
            ep, _, info = self._peers[pipe_name]
            owners = self._tab_owners.setdefault(tid, [])
            if not any(o["pipe_name"] == pipe_name for o in owners):
                owners.append({
                    "pipe_name": pipe_name,
                    "browser": ep[1],
                    "instance_id": ep[2],
                    "label": str(info.get("label") or ""),
                    "url": str(result.get("url") or ""),
                    "controllable": True,
                })

    def call(self, method: str, parameters: dict[str, Any], timeout: float, browser: str | None = None) -> Any:
        _timeout(timeout)
        if method == "request.fetch":
            res = self._anonymous_fetch(parameters, timeout)
            status = res.get("status")
            if self._peer is not None and not self._closed and isinstance(status, int) and (status in {401, 403, 429, 503} or 200 <= status < 300):
                try:
                    self.call("site.recordHttp", {"url": str(parameters.get("url", "")), "status": status}, 3_000)
                except BridgeError:
                    pass
            return res
        with self._lock:
            if self._closed or self._peer is None:
                raise BridgeError("closed", "The Browser Bridge connection is closed.")
            if method == "bridge.connect":
                return self.connect()
            self._route_multi_browser_tab(method, parameters)
            assert self._peer is not None
            try:
                result = self._raw_peer_call(self._peer, method, parameters, timeout)
            except BridgeError as err:
                if err.code in {"connection_lost", "closed", "protocol_error", "timeout"}:
                    self.close()
                raise
            except (OSError, ValueError) as err:
                self.close()
                raise BridgeError("connection_lost", f"The browser disconnected ({err}).") from err
            self._record_response_tabs(method, parameters, result)
            return result

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for _, peer, _ in list(self._peers.values()):
            peer.close()
        self._peers.clear()
        if self._peer is not None:
            self._peer.close()
            self._peer = None


class BrowserBridge:
    """Owns a Bridge IPC connection and its new tabs, never the user's browser process."""

    _READ_SAFE_METHODS = frozenset({
        "status",
        "tabs.list",
        "tabs.inventory",
        "page.snapshot",
        "page.text",
        "page.info",
        "page.locate",
        "page.query",
        "page.queryAll",
        "page.media",
        "page.waitFor",
        "page.screenshot",
        "page.network",
        "page.console",
        "page.webmcp.list",
        "page.webmcp.call",
        "routine.list",
        "routine.run",
        "site.profile",
        "request.fetch",
        "page.styles",
        "page.layout",
        "page.domBaseline",
        "page.performance",
        "page.har",
        "page.debugger",
    })

    @classmethod
    def _is_read_safe(cls, method: str, payload: dict[str, Any]) -> bool:
        if method in {"page.patch", "page.intercept"}:
            return payload.get("action", "list") == "list"
        return method in cls._READ_SAFE_METHODS and (
            method != "page.fetch" or str(payload.get("method", "GET")).upper() in {"GET", "HEAD"}
        )

    def __init__(
        self,
        *,
        browser: str | None = None,
        host: str | os.PathLike[str] | None = None,
        timeout: float = 30_000,
        read_only: bool = False,
    ):
        self._selector = browser or os.environ.get("BROWSER_BRIDGE_BROWSER")
        self._host = host or os.environ.get("BROWSER_BRIDGE_HOST")
        self.timeout = _timeout(timeout)
        env_ro = os.environ.get("BROWSER_BRIDGE_READ_ONLY", "").strip().lower() in {"1", "true", "yes"}
        self.read_only = bool(read_only or env_ro)
        self._transport: _Transport | _DirectTransport | None = None
        self._owned_pages: dict[int, Page] = {}
        self.info: dict[str, Any] = {}
        self.request = RequestContext(self)

    def start(self) -> BrowserBridge:
        if self._transport is not None:
            return self
        if self._host is not None:
            transport: _Transport | _DirectTransport = _Transport(_host_path(self._host))
            try:
                info = transport.call("bridge.connect", {}, 30_000, self._selector)
            except BaseException:
                transport.close()
                raise
        else:
            transport = _DirectTransport(self._selector)
            try:
                info = transport.connect()
            except BaseException:
                transport.close()
                raise
        if info.get("protocol") != 1 or info.get("status", {}).get("managedApi") != 1:
            transport.close()
            raise BridgeError("update_required", "The connected extension does not provide the managed API. Run scripts\\install.ps1 and reload the Browser Bridge extension.")
        self.info = info
        self._transport = transport
        return self

    def __enter__(self) -> BrowserBridge:
        return self.start()

    def __exit__(self, exc_type: Any, exc: BaseException | None, traceback: Any) -> None:
        try:
            self.close()
        except BridgeError as cleanup:
            if exc is None:
                raise
            if hasattr(exc, "add_note"):
                exc.add_note(f"Browser Bridge cleanup also failed: {cleanup}")
            else:
                warnings.warn(f"Browser Bridge cleanup also failed: {cleanup}", RuntimeWarning)

    def call(self, method: str, params: dict[str, Any] | None = None, *, timeout: float | None = None) -> Any:
        """Call any Bridge API method directly; enforces read_only when enabled."""
        payload = dict(params or {})
        if self.read_only:
            if not self._is_read_safe(method, payload):
                raise BridgeError("read_only", f"Read-only BrowserBridge client cannot perform '{method}'.")
            if method != "request.fetch":
                payload["readOnly"] = True
        self.start()
        assert self._transport is not None
        return self._transport.call(method, payload, self.timeout + 10_000 if timeout is None else timeout)

    def new_page(
        self,
        url: str | None = None,
        *,
        active: bool = False,
        name: str | None = None,
        group: str | None = None,
        allowed_origins: list[str] | None = None,
    ) -> Page:
        params: dict[str, Any] = {"active": bool(active)}
        if name is not None:
            params["name"] = name
        if group is not None:
            params["group"] = group
        if allowed_origins is not None:
            params["allowedOrigins"] = list(allowed_origins)
        result = self.call("tabs.new", params)
        page = self._owned_pages.get(result["tabId"]) or Page(self, result["tabId"])
        if not name:
            self._owned_pages[page.tab_id] = page
        if url is not None and not (result.get("reused") and result.get("url") and result.get("url") != "about:blank"):
            page.goto(url)
        return page

    def allowlist(
        self,
        origins: list[str] | None = None,
        *,
        tab_id: int | None = None,
        clear: bool = False,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if origins is not None:
            params["origins"] = list(origins)
        if tab_id is not None:
            params["tabId"] = tab_id
        if clear:
            params["clear"] = True
        return self.call("session.allowlist", params)

    @property
    def pages(self) -> list[Page]:
        return [Page(self, tab["tabId"]) for tab in self.call("tabs.list")["tabs"]]

    def page(self, tab_id: int) -> Page:
        self.call("page.info", {"tabId": tab_id})
        return self._owned_pages.get(tab_id) or Page(self, tab_id)

    def site_profile(self, domain_or_url: str) -> dict[str, Any]:
        """Returns the learned SitePlaybook (including accessProfile, pitfalls, and routines) for a domain or URL."""
        self.start()
        if isinstance(self._transport, _Transport):
            return self.call("routine.list", {"domain": domain_or_url})
        return self.call("site.profile", {"domain": domain_or_url})

    def smart_fetch(
        self,
        url: str,
        *,
        page: Page | None = None,
        method: str = "GET",
        headers: dict[str, str] | None = None,
        data: str | None = None,
        timeout: float = 30_000,
        max_bytes: int = 20 * 1024 * 1024,
    ) -> Response:
        """Fetches via fast direct HTTP first, automatically learning 401/403/429 WAF blocks and routing through browser session."""
        prof = self.site_profile(url).get("accessProfile") or {}
        if not prof.get("directHttpBlocked"):
            resp = self.request.fetch(url, method=method, headers=headers, data=data, timeout=timeout, max_bytes=max_bytes)
            if resp.status not in {401, 403, 429, 503}:
                return resp

        if page is not None:
            return page.request.fetch(url, method=method, headers=headers, data=data, timeout=timeout, max_bytes=max_bytes)

        parsed = urllib.parse.urlsplit(url)
        origin = f"{parsed.scheme}://{parsed.netloc}/"
        temp_page = self.new_page(origin)
        try:
            return temp_page.request.fetch(url, method=method, headers=headers, data=data, timeout=timeout, max_bytes=max_bytes)
        finally:
            temp_page.close()

    def close(self) -> None:
        if self._transport is None:
            return
        errors: list[str] = []
        try:
            for page in list(self._owned_pages.values()):
                try:
                    page.close()
                except BridgeError as error:
                    if error.code != "no_tab":
                        errors.append(str(error))
        finally:
            self._owned_pages.clear()
            self._transport.close()
            self._transport = None
        if errors:
            raise BridgeError("cleanup_failed", "; ".join(errors))


@dataclass(frozen=True)
class NavigationResponse:
    url: str
    status: int | None

    @property
    def ok(self) -> bool:
        return self.status is not None and 200 <= self.status < 300


class Response:
    def __init__(self, result: dict[str, Any]):
        self.status: int = result["status"]
        self.url: str = result["url"]
        self.headers: dict[str, str] = result["headers"]
        try:
            self._body = base64.b64decode(result["data"], validate=True)
        except (ValueError, TypeError) as error:
            raise BridgeError("protocol_error", "Response body is not valid base64.") from error
        if len(self._body) != result["byteLength"]:
            raise BridgeError("protocol_error", "Response byte length does not match the body.")

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def body(self) -> bytes:
        return self._body

    def text(self, encoding: str = "utf-8") -> str:
        return self._body.decode(encoding)

    def json(self) -> Any:
        return json.loads(self._body)

    def raise_for_status(self) -> None:
        if not self.ok:
            raise BridgeError("http_error", f"HTTP {self.status} from {self.url}")


class RequestContext:
    def __init__(self, browser: BrowserBridge, page: Page | None = None):
        self._browser = browser
        self._page = page

    def fetch(self, url: str, *, method: str = "GET", headers: dict[str, str] | None = None, data: str | None = None, timeout: float = 30_000, max_bytes: int = 20 * 1024 * 1024) -> Response:
        _timeout(timeout)
        params: dict[str, Any] = {"url": url, "method": method, "timeoutMs": timeout, "maxBytes": max_bytes}
        if headers is not None:
            params["headers"] = headers
        if data is not None:
            params["body"] = data
        if self._page is not None:
            params["tabId"] = self._page.tab_id
        result = self._browser.call("page.fetch" if self._page is not None else "request.fetch", params, timeout=timeout + 5000)
        return Response(result)

    def get(self, url: str, **options: Any) -> Response:
        return self.fetch(url, method="GET", **options)

    def post(self, url: str, **options: Any) -> Response:
        return self.fetch(url, method="POST", **options)


class _FinderScope:
    _page: Page
    _steps: list[dict[str, Any]]
    _frame_id: int | None

    def _find(self, kind: str, value: str, **options: Any) -> Locator:
        step = {"kind": kind, "value": value}
        step.update({key: value for key, value in options.items() if value is not None})
        return Locator(self._page, self._steps + [step], self._frame_id)

    def locator(self, selector: str) -> Locator:
        return self._find("css", selector)

    def get_by_role(self, role: str, *, name: str | None = None, exact: bool | None = None, include_hidden: bool | None = None) -> Locator:
        return self._find("role", role, name=name, exact=exact, includeHidden=include_hidden)

    def get_by_text(self, text: str, *, exact: bool | None = None) -> Locator:
        return self._find("text", text, exact=exact)

    def get_by_label(self, text: str, *, exact: bool | None = None) -> Locator:
        return self._find("label", text, exact=exact)

    def get_by_placeholder(self, text: str, *, exact: bool | None = None) -> Locator:
        return self._find("placeholder", text, exact=exact)

    def get_by_test_id(self, test_id: str) -> Locator:
        return self._find("testId", test_id)

    def get_by_alt_text(self, text: str, *, exact: bool | None = None) -> Locator:
        return self._find("altText", text, exact=exact)

    def get_by_title(self, text: str, *, exact: bool | None = None) -> Locator:
        return self._find("title", text, exact=exact)


class Page(_FinderScope):
    _STEP_METHODS = {
        "click": "page.click", "doubleClick": "page.click", "dblclick": "page.click",
        "drag": "page.drag", "hover": "page.hover", "type": "page.type", "fill": "page.fill",
        "select": "page.select", "check": "page.check", "press": "page.press", "scroll": "page.scroll",
        "waitFor": "page.waitFor", "wait_for": "page.waitFor", "locate": "page.locate",
        "query": "page.query", "get_element": "page.query", "queryAll": "page.queryAll",
        "media": "page.media", "snapshot": "page.snapshot", "text": "page.text", "screenshot": "page.screenshot",
        "fetch": "page.fetch", "navigate": "page.navigate", "goto": "page.navigate", "history": "page.history",
        "dialog": "page.dialog", "webmcp.list": "page.webmcp.list", "webmcp.call": "page.webmcp.call",
        "styles": "page.styles", "layout": "page.layout", "domBaseline": "page.domBaseline",
        "dom_baseline": "page.domBaseline", "patch": "page.patch", "performance": "page.performance",
        "har": "page.har", "debugger": "page.debugger", "intercept": "page.intercept",
        "network": "page.network", "console": "page.console",
    }

    @classmethod
    def _validate_debug_routine_steps(cls, steps: list[dict[str, Any]]) -> None:
        def live_reference(value: Any) -> bool:
            if isinstance(value, dict):
                return any(
                    key not in {"styles", "attributes"} and (
                        key in {"id", "documentId", "ref"} and isinstance(item, str) and "{{" not in item
                        or live_reference(item)
                    )
                    for key, item in value.items()
                )
            return isinstance(value, list) and any(live_reference(item) for item in value)

        for index, step in enumerate(steps):
            method = cls._STEP_METHODS.get(step.get("op", ""), step.get("op", ""))
            if method in {"page.domBaseline", "page.patch"} and live_reference(step.get("params") or {}):
                raise BridgeError("bad_request", f"Diagnostic routine step {index + 1} contains a live document handle/ref. Use a locator and runtime binding such as {{{{baseline.id}}}}.")

    def __init__(self, browser: BrowserBridge, tab_id: int):
        self.browser = browser
        self.tab_id = tab_id
        self._page = self
        self._steps = []
        self._frame_id = None
        self.request = RequestContext(browser, self)
        self._closed = False

    def _call(self, method: str, params: dict[str, Any] | None = None, *, timeout: float | None = None) -> Any:
        if self._closed:
            raise BridgeError("closed", "The tab is closed.")
        return self.browser.call(method, {**(params or {}), "tabId": self.tab_id}, timeout=timeout)

    def _debug_call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        result = self._call(method, params)
        if not isinstance(result, dict):
            raise BridgeError("protocol_error", "The diagnostic operation did not return an object.")
        return result

    def _debug_target(
        self, ref: str | None = None, locator: Locator | dict[str, Any] | None = None,
        frame_id: int | None = None,
    ) -> dict[str, Any]:
        if ref is not None and locator is not None:
            raise ValueError("Provide ref or locator, not both.")
        params: dict[str, Any] = {}
        if ref is not None:
            if not isinstance(ref, str) or not ref:
                raise ValueError("ref must be a non-empty element ref")
            params["ref"] = ref
        if isinstance(locator, Locator):
            if locator._page is not self:
                raise ValueError("The locator belongs to another Page instance.")
            params.update(locator._target())
        elif locator is not None:
            if not isinstance(locator, dict):
                raise ValueError("locator must be a Locator or structured locator object")
            params["locator"] = locator
        if frame_id is not None:
            if isinstance(frame_id, bool) or not isinstance(frame_id, int) or not 0 <= frame_id <= 9_007_199_254_740_991:
                raise ValueError("frame_id must be a non-negative safe integer")
            params["frameId"] = frame_id
        return params

    def computed_styles(
        self, *, ref: str | None = None, locator: Locator | dict[str, Any] | None = None,
        properties: list[str] | None = None, pseudo: str | None = None, frame_id: int | None = None,
    ) -> dict[str, Any]:
        params = self._debug_target(ref, locator, frame_id)
        params["action"] = "computed"
        if properties is not None:
            params["properties"] = properties
        if pseudo is not None:
            params["pseudo"] = pseudo
        return self._debug_call("page.styles", params)

    def style_context(
        self, *, ref: str | None = None, locator: Locator | dict[str, Any] | None = None,
        frame_id: int | None = None,
    ) -> dict[str, Any]:
        return self._debug_call("page.styles", {**self._debug_target(ref, locator, frame_id), "action": "context"})

    def box_model(
        self, *, ref: str | None = None, locator: Locator | dict[str, Any] | None = None,
        frame_id: int | None = None,
    ) -> dict[str, Any]:
        return self._debug_call("page.layout", {**self._debug_target(ref, locator, frame_id), "action": "box"})

    def hit_test(self, x: float, y: float, *, frame_id: int | None = None) -> dict[str, Any]:
        return self._debug_call("page.layout", {**self._debug_target(frame_id=frame_id), "action": "hitTest", "x": x, "y": y})

    def create_dom_baseline(
        self, *, ref: str | None = None, locator: Locator | dict[str, Any] | None = None,
        max_nodes: int | None = None, max_text: int | None = None, frame_id: int | None = None,
    ) -> dict[str, Any]:
        params = {**self._debug_target(ref, locator, frame_id), "action": "create"}
        if max_nodes is not None:
            params["maxNodes"] = max_nodes
        if max_text is not None:
            params["maxText"] = max_text
        return self._debug_call("page.domBaseline", params)

    def compare_dom_baseline(self, baseline_id: str, *, max_changes: int | None = None, frame_id: int | None = None) -> dict[str, Any]:
        params = {**self._debug_target(frame_id=frame_id), "action": "compare", "id": baseline_id}
        if max_changes is not None:
            params["maxChanges"] = max_changes
        return self._debug_call("page.domBaseline", params)

    def describe_dom_baseline(self, baseline_id: str, *, frame_id: int | None = None) -> dict[str, Any]:
        return self._debug_call("page.domBaseline", {**self._debug_target(frame_id=frame_id), "action": "describe", "id": baseline_id})

    def release_dom_baseline(self, baseline_id: str, *, frame_id: int | None = None) -> dict[str, Any]:
        return self._debug_call("page.domBaseline", {**self._debug_target(frame_id=frame_id), "action": "release", "id": baseline_id})

    def apply_patch(
        self, changes: list[dict[str, Any]], *, label: str | None = None,
        ttl_ms: int | None = None, frame_id: int | None = None,
    ) -> dict[str, Any]:
        if not isinstance(changes, list) or not 1 <= len(changes) <= 50:
            raise ValueError("changes must contain from 1 to 50 patch changes")
        normalized = []
        for change in changes:
            if not isinstance(change, dict):
                raise ValueError("Each patch change must be an object.")
            target = change.get("target")
            if isinstance(target, Locator):
                target = self._debug_target(locator=target)
            elif isinstance(target, dict) and isinstance(target.get("locator"), Locator):
                target = {**target, **self._debug_target(locator=target["locator"])}
            normalized.append({**change, "target": target})
        params = {**self._debug_target(frame_id=frame_id), "action": "apply", "changes": normalized}
        if label is not None:
            params["label"] = label
        if ttl_ms is not None:
            params["ttlMs"] = ttl_ms
        return self._debug_call("page.patch", params)

    def patches(self, *, frame_id: int | None = None) -> dict[str, Any]:
        return self._debug_call("page.patch", {**self._debug_target(frame_id=frame_id), "action": "list"})

    def rollback_patch(self, patch_id: str | None = None, *, frame_id: int | None = None) -> dict[str, Any]:
        params = {**self._debug_target(frame_id=frame_id), "action": "rollback"}
        if patch_id is not None:
            params["id"] = patch_id
        return self._debug_call("page.patch", params)

    def commit_patch(self, patch_id: str, *, frame_id: int | None = None) -> dict[str, Any]:
        return self._debug_call("page.patch", {**self._debug_target(frame_id=frame_id), "action": "commit", "id": patch_id})

    @contextmanager
    def temporary_patch(self, changes: list[dict[str, Any]], **options: Any) -> Iterator[dict[str, Any]]:
        handle = self.apply_patch(changes, **options)
        try:
            yield handle
        finally:
            self.rollback_patch(handle["id"], frame_id=handle.get("frameId", 0))

    def performance(self, *, include_resources: bool = False, max_entries: int = 50, frame_id: int | None = None) -> dict[str, Any]:
        return self._debug_call("page.performance", {
            **self._debug_target(frame_id=frame_id), "includeResources": include_resources, "maxEntries": max_entries,
        })

    def export_har(self, *, limit: int = 200, only_failures: bool = False) -> dict[str, Any]:
        result = self._debug_call("page.har", {"limit": limit, "onlyFailures": only_failures})
        if not isinstance(result.get("log"), dict) or result["log"].get("version") != "1.2":
            raise BridgeError("protocol_error", "The host did not return HAR 1.2 evidence.")
        return result

    def debugger_metrics(self) -> dict[str, Any]:
        return self._debug_call("page.debugger", {"action": "metrics"})

    def interception(self) -> dict[str, Any]:
        return self._debug_call("page.intercept", {"action": "list"})

    def set_interception(self, rules: list[dict[str, Any]]) -> dict[str, Any]:
        return self._debug_call("page.intercept", {"action": "set", "rules": rules})

    def clear_interception(self) -> dict[str, Any]:
        return self._debug_call("page.intercept", {"action": "clear"})

    @property
    def url(self) -> str:
        return self._call("page.info")["url"]

    @property
    def user_agent(self) -> str:
        return self._call("page.info", {"document": True})["userAgent"]

    def title(self) -> str:
        return self._call("page.info")["title"]

    def goto(self, url: str, *, wait_until: str | None = None, timeout: float | None = None) -> NavigationResponse | None:
        budget = _timeout(self.browser.timeout if timeout is None else timeout)
        nav_params: dict[str, Any] = {"url": url, "timeoutMs": budget}
        if wait_until is not None:
            nav_params["waitUntil"] = wait_until
        result = self._call("page.navigate", nav_params, timeout=budget + 5000)
        if result.get("loaded") is not True:
            raise BridgeTimeoutError("timeout", "Navigation started but did not reach the requested load state.")
        if result["url"] == "about:blank":
            return None
        return NavigationResponse(result["url"], result.get("status"))

    def go_back(self) -> None:
        self._call("page.history", {"action": "back"})

    def go_forward(self) -> None:
        self._call("page.history", {"action": "forward"})

    def reload(self) -> None:
        self._call("page.history", {"action": "reload"})

    def bring_to_front(self) -> None:
        self._call("page.activate")

    def wait_for_load_state(self, state: str = "load", *, timeout: float | None = None) -> None:
        budget = _timeout(self.browser.timeout if timeout is None else timeout)
        self._call("page.waitFor", {"loadState": state, "timeoutSeconds": budget / 1000}, timeout=budget + 5000)

    def wait_for_url(self, url: str, *, timeout: float | None = None) -> None:
        budget = _timeout(self.browser.timeout if timeout is None else timeout)
        self._call("page.waitFor", {"url": url, "timeoutSeconds": budget / 1000}, timeout=budget + 5000)

    def wait_for_timeout(self, milliseconds: float) -> None:
        if not math.isfinite(milliseconds) or milliseconds < 0:
            raise ValueError("milliseconds must be finite and non-negative")
        time.sleep(milliseconds / 1000)

    def evaluate(self, expression: str, arg: Any = None, *, timeout: float | None = None) -> Any:
        """Evaluate ordinary page JavaScript only when the user has allowed page scripts."""
        budget = self.browser.timeout if timeout is None else _timeout(timeout)
        result = self._call("page.evaluate", {"expression": expression, "arg": arg, "invoke": True, "timeoutMs": budget}, timeout=budget + 5000)
        return json.loads(result["result"])

    def wait_for_function(self, expression: str, arg: Any = None, *, timeout: float | None = None, polling: float = 100) -> Any:
        budget = _timeout(self.browser.timeout if timeout is None else timeout)
        _timeout(polling)
        deadline = time.monotonic() + budget / 1000
        while True:
            remaining = max(1, (deadline - time.monotonic()) * 1000)
            value = self.evaluate(expression, arg, timeout=remaining)
            if value:
                return value
            if time.monotonic() >= deadline:
                raise BridgeTimeoutError("timeout", "The page function did not become truthy.")
            time.sleep(min(polling / 1000, max(0, deadline - time.monotonic())))

    def screenshot(
        self,
        path: str | os.PathLike[str] | None = None,
        *,
        type: str | None = None,
        quality: int = 80,
        max_width: int = 4096,
        full_page: bool = False,
    ) -> bytes:
        fmt = type
        if fmt is None:
            suffix = Path(path).suffix.lower() if path is not None else ""
            fmt = "jpeg" if suffix in {".jpg", ".jpeg"} else "png"
        if fmt not in {"png", "jpeg"}:
            raise ValueError("type must be png or jpeg")
        params: dict[str, Any] = {"format": fmt, "quality": quality, "maxWidth": max_width}
        if full_page:
            params["fullPage"] = True
        budget = 45_000 if full_page else None
        result = self._call("page.screenshot", params, timeout=budget)
        data = base64.b64decode(result["data"], validate=True)
        if path is not None:
            Path(path).write_bytes(data)
        return data

    def in_frame(self, frame_id: int) -> Locator:
        """Return a finder scope for a browser frame id obtained from snapshot/locate."""
        return Locator(self, [], frame_id)

    def snapshot(self, *, max_chars: int = 20_000) -> str:
        return self._call("page.snapshot", {"maxChars": max_chars})["text"]

    def media(self, *, include_audio: bool = True, scroll_into_view: bool = True) -> dict[str, Any]:
        """Discovers <video>/<audio> elements, DRM state, and ranked downloadable stream/file URLs on this tab."""
        return self._call(
            "page.media",
            {"includeAudio": bool(include_audio), "scrollIntoView": bool(scroll_into_view)},
        )

    def download_media(
        self,
        path: str | os.PathLike[str] | None = None,
        *,
        url: str | None = None,
        prefer_quality: str = "best",
        max_bytes: int = 200 * 1024 * 1024,
        frame_id: int | None = None,
    ) -> dict[str, Any]:
        """Downloads a progressive video/audio file or assembles an HLS .m3u8 (fMP4 / TS) stream through this browser tab."""
        if max_bytes < 64 * 1024 or max_bytes > 512 * 1024 * 1024:
            raise BridgeError("bad_request", "max_bytes must be between 65536 and 536870912.")
        if isinstance(self.browser._transport, _Transport):
            payload: dict[str, Any] = {
                "tabId": self.tab_id,
                "preferQuality": prefer_quality,
                "maxBytes": int(max_bytes),
            }
            if url:
                payload["url"] = url
            if path is not None:
                payload["path"] = str(path)
            if frame_id is not None:
                payload["frameId"] = int(frame_id)
            return self.browser.call("page.download", payload, timeout=180_000)

        t0 = time.perf_counter()
        candidates: list[tuple[str, int | None, int | None, int | None]] = []
        page_title = ""
        if url and url.strip():
            candidates.append((url.strip(), frame_id, None, None))
            page_title = self.title()
        else:
            rep = self.media(scroll_into_view=True)
            page_title = rep.get("title") or ""
            raw_cands = list(rep.get("candidates") or [])
            if prefer_quality.lower() == "lowest" and len(raw_cands) > 1:
                raw_cands.reverse()
            for c in raw_cands:
                if c.get("kind") == "dash":
                    continue
                cu = (c.get("url") or "").strip()
                if cu:
                    candidates.append((cu, c.get("frameId"), c.get("width"), c.get("height")))
            if not candidates:
                if rep.get("drmDetected"):
                    raise BridgeError("drm_protected", "Media on this page uses encrypted EME/DRM (MediaKeys) and cannot be downloaded.")
                raise BridgeError("not_found", "No downloadable video or audio stream was found on this tab.")

        def _fetch_raw(target_u: str, fid: int | None, limit: int) -> tuple[str, str, bytes]:
            req_p: dict[str, Any] = {
                "url": target_u,
                "method": "GET",
                "credentials": "auto",
                "maxBytes": max(1024, min(int(limit), 32 * 1024 * 1024)),
                "timeoutMs": 45_000,
                "_noLearn": True,
            }
            if fid and fid > 0:
                req_p["frameId"] = int(fid)
            res = self._call("page.fetch", req_p, timeout=55_000)
            st = int(res.get("status") or 0)
            if not (200 <= st < 300):
                raise BridgeError("request_failed", f"HTTP {st} fetching {target_u}.")
            headers_map = {str(k).lower(): str(v) for k, v in (res.get("headers") or {}).items()}
            return str(res.get("url") or target_u), headers_map.get("content-type", ""), base64.b64decode(res["data"])

        def _resolve_dest(stem_hint: str, ext: str) -> Path:
            import re as _re
            safe_stem = _re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", stem_hint).strip(" ._")[:72] or "video"
            if path is not None:
                p_obj = Path(path)
                if p_obj.is_dir() or str(path).endswith(("/", "\\")):
                    p_obj.mkdir(parents=True, exist_ok=True)
                    dest = p_obj / f"{safe_stem}.{ext}"
                    idx = 2
                    while dest.exists():
                        dest = p_obj / f"{safe_stem} ({idx}).{ext}"
                        idx += 1
                    return dest
                p_obj.parent.mkdir(parents=True, exist_ok=True)
                return p_obj
            dl_dir = Path(os.environ.get("USERPROFILE") or os.path.expanduser("~")) / "Downloads"
            dl_dir.mkdir(parents=True, exist_ok=True)
            dest = dl_dir / f"{safe_stem}.{ext}"
            idx = 2
            while dest.exists():
                dest = dl_dir / f"{safe_stem} ({idx}).{ext}"
                idx += 1
            return dest

        last_exc: Exception | None = None
        for cand_u, cand_fid, cand_w, cand_h in candidates:
            budget = int(max_bytes)
            try:
                final_u, ct, body = _fetch_raw(cand_u, cand_fid, budget)
            except BridgeError as exc:
                last_exc = exc
                continue

            clean_u = final_u.split("?", 1)[0].split("#", 1)[0].lower()
            is_m3u8 = "mpegurl" in ct.lower() or clean_u.endswith(".m3u8") or body.startswith(b"#EXTM3U")
            if not is_m3u8:
                ext = "webm" if ("webm" in ct.lower() or clean_u.endswith(".webm")) else ("m4a" if clean_u.endswith(".m4a") else "mp4")
                out_file = _resolve_dest(page_title or "video", ext)
                out_file.write_bytes(body)
                valid_mp4 = len(body) >= 12 and body[4:8] in {b"ftyp", b"styp", b"moof"} if ext == "mp4" else None
                return {
                    "tabId": self.tab_id,
                    "path": str(out_file),
                    "bytes": len(body),
                    "delivery": "progressive",
                    "container": ext,
                    "mimeType": ct or f"video/{ext}",
                    "sourceUrl": final_u,
                    "width": cand_w,
                    "height": cand_h,
                    "validMp4Header": valid_mp4,
                    "elapsedMs": round((time.perf_counter() - t0) * 1000),
                }

            import re as _re
            m3u8_txt = body.decode("utf-8", errors="replace")
            if _re.search(r"#EXT-X-(?:SESSION-)?KEY:[^\n]*METHOD=(?!NONE)[A-Z0-9-]+", m3u8_txt, _re.IGNORECASE):
                raise BridgeError("drm_protected", "HLS stream is encrypted (#EXT-X-KEY) and cannot be downloaded.")

            variants: list[tuple[int, int, int | None, int | None, str]] = []
            lines = [ln.strip() for ln in m3u8_txt.splitlines() if ln.strip()]
            idx_l = 0
            while idx_l < len(lines):
                ln = lines[idx_l]
                if ln.startswith("#EXT-X-STREAM-INF:"):
                    bw_m = _re.search(r"BANDWIDTH=(\d+)", ln)
                    res_m = _re.search(r"RESOLUTION=(\d+)x(\d+)", ln, _re.IGNORECASE)
                    bw = int(bw_m.group(1)) if bw_m else 0
                    vw = int(res_m.group(1)) if res_m else None
                    vh = int(res_m.group(2)) if res_m else None
                    idx_l += 1
                    while idx_l < len(lines) and lines[idx_l].startswith("#"):
                        idx_l += 1
                    if idx_l < len(lines):
                        variants.append(((vw or 0) * (vh or 0), bw, vw, vh, urllib.parse.urljoin(final_u, lines[idx_l])))
                idx_l += 1

            chosen_w, chosen_h = cand_w, cand_h
            variant_u: str | None = None
            if variants:
                variants.sort(key=lambda t: (t[0], t[1]))
                picked = variants[0] if prefer_quality.lower() == "lowest" else variants[-1]
                _, _, chosen_w, chosen_h, variant_u = picked
                v_final_u, _, v_body = _fetch_raw(variant_u, cand_fid, budget)
                media_base = v_final_u
                media_txt = v_body.decode("utf-8", errors="replace")
            else:
                media_base = final_u
                media_txt = m3u8_txt

            if _re.search(r"#EXT-X-(?:SESSION-)?KEY:[^\n]*METHOD=(?!NONE)[A-Z0-9-]+", media_txt, _re.IGNORECASE):
                raise BridgeError("drm_protected", "HLS media playlist is encrypted (#EXT-X-KEY) and cannot be downloaded.")

            init_map: str | None = None
            seg_urls: list[str] = []
            dur_s = 0.0
            for ln in media_txt.splitlines():
                s = ln.strip()
                if not s:
                    continue
                if s.startswith("#EXT-X-MAP:"):
                    um = _re.search(r'URI="([^"]+)"', s)
                    if um:
                        init_map = urllib.parse.urljoin(media_base, um.group(1))
                elif s.startswith("#EXTINF:"):
                    dm = _re.match(r"#EXTINF:([0-9.]+)", s)
                    if dm:
                        dur_s += float(dm.group(1))
                elif not s.startswith("#"):
                    seg_urls.append(urllib.parse.urljoin(media_base, s))

            is_fmp4 = init_map is not None or (bool(seg_urls) and seg_urls[0].split("?", 1)[0].endswith(".m4s"))
            ext = "mp4" if is_fmp4 else "ts"
            out_file = _resolve_dest(page_title or "video", ext)
            total_written = 0
            with open(out_file, "wb") as fh:
                if init_map:
                    _, _, ib = _fetch_raw(init_map, cand_fid, budget - total_written)
                    total_written += len(ib)
                    fh.write(ib)
                for su in seg_urls:
                    if total_written >= budget:
                        raise BridgeError("body_too_large", "Stream exceeds max_bytes limit.")
                    _, _, sb = _fetch_raw(su, cand_fid, budget - total_written)
                    total_written += len(sb)
                    fh.write(sb)
            head_bytes = out_file.read_bytes()[:16]
            valid_mp4 = len(head_bytes) >= 12 and head_bytes[4:8] in {b"ftyp", b"styp", b"moof"} if ext == "mp4" else None
            return {
                "tabId": self.tab_id,
                "path": str(out_file),
                "bytes": total_written,
                "delivery": "hls_fmp4" if is_fmp4 else "hls_ts",
                "container": ext,
                "mimeType": "video/mp4" if is_fmp4 else "video/mp2t",
                "sourceUrl": final_u,
                "variantUrl": variant_u,
                "width": chosen_w,
                "height": chosen_h,
                "durationSeconds": round(dur_s, 2),
                "segmentsDownloaded": len(seg_urls),
                "validMp4Header": valid_mp4,
                "elapsedMs": round((time.perf_counter() - t0) * 1000),
            }

        if last_exc is not None:
            raise last_exc
        raise BridgeError("request_failed", "Could not download media stream.")

    def webmcp_tools(self) -> list[dict[str, Any]]:
        """Discover WebMCP tools registered on the page (Imperative modelContext and Declarative <form toolname=...>)."""
        return self._call("page.webmcp.list")["tools"]

    def call_webmcp(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        *,
        submit: bool | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"name": name, "arguments": arguments or {}}
        if submit is not None:
            params["submit"] = submit
        budget = None if timeout is None else _timeout(timeout) + 5000
        return self._call("page.webmcp.call", params, timeout=budget)

    def handle_dialog(self, *, accept: bool = True, prompt_text: str | None = None, arm_next: bool = False) -> dict[str, Any]:
        params: dict[str, Any] = {"accept": accept, "armNext": arm_next}
        if prompt_text is not None:
            params["promptText"] = prompt_text
        return self._call("page.dialog", params)

    def drag(
        self,
        from_x: float,
        from_y: float,
        to_x: float,
        to_y: float,
        *,
        steps: int = 10,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        budget = _timeout(self.browser.timeout if timeout is None else timeout)
        return self._call(
            "page.drag",
            {"fromX": from_x, "fromY": from_y, "toX": to_x, "toY": to_y, "steps": steps, "timeoutMs": budget},
            timeout=budget + 10_000,
        )

    @staticmethod
    def _interpolate_step(template: Any, variables: dict[str, Any]) -> Any:
        missing = object()

        def lookup(key: str) -> Any:
            if key in variables:
                return variables[key]
            parts = key.split(".")
            value = variables.get(parts[0], missing)
            for part in parts[1:]:
                if isinstance(value, dict):
                    value = value.get(part, missing)
                elif isinstance(value, list) and part.isdecimal() and int(part) < len(value):
                    value = value[int(part)]
                else:
                    return missing
            return value

        if isinstance(template, str):
            exact = re.fullmatch(r"\{\{([^{}:]+)\}\}", template)
            if exact:
                value = lookup(exact[1].strip())
                if value is not missing:
                    return value

            def replace(match: re.Match[str]) -> str:
                key = match[1].strip()
                encoded = key.endswith(":urlencode")
                value = lookup(key[:-10] if encoded else key)
                if value is missing:
                    return match[0]
                text = "" if value is None else (value if isinstance(value, str) else json.dumps(value))
                return urllib.parse.quote(text, safe="") if encoded else text

            return re.sub(r"\{\{([^{}]+)\}\}", replace, template)
        if isinstance(template, list):
            return [Page._interpolate_step(x, variables) for x in template]
        if isinstance(template, dict):
            return {k: Page._interpolate_step(v, variables) for k, v in template.items()}
        return template

    def routines(self, *, domain: str | None = None, flush_auto: bool = False) -> dict[str, Any]:
        self.browser.start()
        if isinstance(self.browser._transport, _Transport):
            target_domain = domain or urllib.parse.urlsplit(self.url).hostname or ""
            return self.browser.call("routine.list", {"domain": target_domain, "flushAutoRoutines": bool(flush_auto)})
        params: dict[str, Any] = {"tabId": self.tab_id}
        if domain:
            params["domain"] = domain
        if flush_auto:
            params["flushAutoRoutines"] = True
        return self.browser.call("site.profile", params)

    def access_profile(self, *, domain: str | None = None) -> dict[str, Any]:
        """Returns the learned error/performance access profile for this page's domain."""
        return self.routines(domain=domain).get("accessProfile") or {}

    def run_routine(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        *,
        domain: str | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        merged_args: dict[str, Any] = {**(arguments or {}), **kwargs}
        arguments = merged_args
        if isinstance(self.browser._transport, _Transport):
            params: dict[str, Any] = {"tabId": self.tab_id, "name": name, "arguments": arguments}
            if domain:
                params["domain"] = domain
            return self.browser.call("routine.run", params)

        pb = self.routines(domain=domain)
        routine = (pb.get("routines") or {}).get(name)
        if not routine:
            raise BridgeError("not_found", f"Routine '{name}' not found for '{pb.get('domain', '')}'.")
        if self.browser.read_only and not routine.get("readOnly"):
            raise BridgeError("read_only", f"Routine '{name}' modifies page state and cannot run in read-only mode.")

        op_map = self._STEP_METHODS
        variables: dict[str, Any] = {}
        needs_url_vars = any(
            isinstance((spec or {}).get("default"), str) and "{{url." in spec["default"]
            for spec in (routine.get("params") or {}).values()
        ) or "{{url." in json.dumps(routine.get("steps") or [])
        if needs_url_vars:
            cur_url = self.url
            parsed_u = urllib.parse.urlsplit(cur_url)
            variables["url.href"] = cur_url
            if parsed_u.scheme and parsed_u.netloc:
                variables["url.origin"] = f"{parsed_u.scheme}://{parsed_u.netloc}"
                variables["url.cleanPath"] = f"{parsed_u.scheme}://{parsed_u.netloc}{parsed_u.path.rstrip('/')}"
            segs = [s for s in parsed_u.path.split("/") if s]
            if "d" in segs:
                d_idx = segs.index("d")
                if d_idx + 1 < len(segs):
                    variables["url.docId"] = segs[d_idx + 1]
            if parsed_u.hostname and parsed_u.hostname.lower().endswith("arxiv.org") and len(segs) >= 2 and segs[0] in {"abs", "pdf", "html"}:
                arxiv_id = "/".join(segs[1:])
                if arxiv_id.endswith(".pdf"):
                    arxiv_id = arxiv_id[:-4]
                variables["url.arxivId"] = arxiv_id
            if parsed_u.hostname and parsed_u.hostname.lower() == "github.com" and len(segs) >= 2:
                variables["url.repo"] = f"{segs[0]}/{segs[1]}"
            gid_val = "0"
            for raw_q in (parsed_u.query, parsed_u.fragment):
                qmap = urllib.parse.parse_qs(raw_q)
                if qmap.get("gid"):
                    gid_val = qmap["gid"][0]
            variables["url.gid"] = gid_val

        for p_name, spec in (routine.get("params") or {}).items():
            if arguments and p_name in arguments:
                variables[p_name] = arguments[p_name]
            elif "default" in spec and spec["default"] is not None:
                variables[p_name] = self._interpolate_step(spec["default"], variables)
            elif spec.get("required"):
                raise BridgeError("bad_request", f"Missing required routine argument '{p_name}'.")
        if arguments:
            for k, v in arguments.items():
                variables.setdefault(k, v)

        t0 = time.perf_counter()
        outputs: dict[str, Any] = {}
        steps_run = 0
        for step in routine.get("steps") or []:
            op = step["op"]
            method = op_map.get(op, op)
            step_params = dict(self._interpolate_step(step.get("params") or {}, variables))
            strip_html = bool(step_params.pop("stripHtml", False)) if method == "page.fetch" else False
            if op in {"doubleClick", "dblclick"}:
                step_params["doubleClick"] = True
            if method == "page.type" and step.get("optional") and step_params.get("text") == "":
                continue
            step_params["_fromRoutine"] = True
            try:
                res = self._call(method, step_params)
                steps_run += 1
                save_as = step.get("saveAs")
                if save_as:
                    if method == "page.fetch" and isinstance(res, dict) and isinstance(res.get("data"), str):
                        raw_txt = base64.b64decode(res["data"]).decode("utf-8", errors="replace")
                        if strip_html:
                            import html as _html
                            import re as _re
                            no_scripts = _re.sub(r"(?is)<(?:script|style|head)\b.*?</(?:script|style|head)>", "", raw_txt)
                            with_breaks = _re.sub(r"(?i)</?(?:p|div|br|li|tr|h[1-6]|table)\b[^>]*>", "\n", no_scripts)
                            no_tags = _re.sub(r"<[^>]+>", "", with_breaks)
                            lines_clean = [ln.strip() for ln in _html.unescape(no_tags).splitlines()]
                            val: Any = _re.sub(r"\n{3,}", "\n\n", "\n".join(lines_clean)).strip()
                        else:
                            val = raw_txt
                    else:
                        val = res["value"] if isinstance(res, dict) and "value" in res else (res["text"] if isinstance(res, dict) and "text" in res else res)
                    outputs[save_as] = val
                    variables[save_as] = val
            except BridgeError:
                if not step.get("optional"):
                    raise
        return {
            "routine": name,
            "tabId": self.tab_id,
            "elapsedMs": round((time.perf_counter() - t0) * 1000),
            "stepsExecuted": steps_run,
            "outputs": outputs,
        }

    def batch(
        self,
        steps: list[dict[str, Any]],
        *,
        variables: dict[str, Any] | None = None,
        stop_on_error: bool = True,
        save_as_routine: str | None = None,
        description: str = "",
    ) -> dict[str, Any]:
        """Executes an ordered multi-step sequence inside this page's active session lease in a single loop."""
        if not steps:
            raise BridgeError("bad_request", "steps must contain at least 1 step.")
        if len(steps) > 100:
            raise BridgeError("bad_request", "steps must contain at most 100 steps per batch.")
        if save_as_routine:
            self._validate_debug_routine_steps(steps)
        if isinstance(self.browser._transport, _Transport):
            payload: dict[str, Any] = {
                "tabId": self.tab_id,
                "steps": steps,
                "variables": variables or {},
                "stopOnError": bool(stop_on_error),
            }
            if save_as_routine:
                payload["saveAsRoutine"] = save_as_routine
                payload["description"] = description
            if self.browser.read_only:
                payload["readOnly"] = True
            return self.browser.call("page.batch", payload)

        op_map = self._STEP_METHODS
        all_read_safe = True
        for idx, st in enumerate(steps):
            op = st.get("op", "")
            method = op_map.get(op, op)
            step_ro = BrowserBridge._is_read_safe(method, self._interpolate_step(st.get("params") or {}, variables or {}))
            all_read_safe = all_read_safe and step_ro
            if self.browser.read_only and not step_ro:
                raise BridgeError("read_only", f"Batch step {idx + 1} ({method}) is not allowed in read-only mode.")

        vars_map: dict[str, Any] = dict(variables or {})
        if "{{url." in json.dumps(steps) or save_as_routine:
            cur_url = self.url
            parsed_u = urllib.parse.urlsplit(cur_url)
            vars_map.setdefault("url.href", cur_url)
            if parsed_u.scheme and parsed_u.netloc:
                vars_map.setdefault("url.origin", f"{parsed_u.scheme}://{parsed_u.netloc}")
                vars_map.setdefault("url.cleanPath", f"{parsed_u.scheme}://{parsed_u.netloc}{parsed_u.path.rstrip('/')}")
            segs = [s for s in parsed_u.path.split("/") if s]
            if "d" in segs:
                d_idx = segs.index("d")
                if d_idx + 1 < len(segs):
                    vars_map.setdefault("url.docId", segs[d_idx + 1])
            if parsed_u.hostname and parsed_u.hostname.lower().endswith("arxiv.org") and len(segs) >= 2 and segs[0] in {"abs", "pdf", "html"}:
                arxiv_id = "/".join(segs[1:])
                if arxiv_id.endswith(".pdf"):
                    arxiv_id = arxiv_id[:-4]
                vars_map.setdefault("url.arxivId", arxiv_id)
            if parsed_u.hostname and parsed_u.hostname.lower() == "github.com" and len(segs) >= 2:
                vars_map.setdefault("url.repo", f"{segs[0]}/{segs[1]}")

        t0 = time.perf_counter()
        outputs: dict[str, Any] = {}
        step_log: list[dict[str, Any]] = []
        succeeded = 0
        failed = 0
        for idx, step in enumerate(steps):
            op = step["op"]
            method = op_map.get(op, op)
            step_params = dict(self._interpolate_step(step.get("params") or {}, vars_map))
            if self.browser.read_only and not BrowserBridge._is_read_safe(method, step_params):
                raise BridgeError("read_only", f"Batch step {idx + 1} ({method}) is not allowed in read-only mode.")
            strip_html = bool(step_params.pop("stripHtml", False)) if method == "page.fetch" else False
            if op in {"doubleClick", "dblclick"}:
                step_params["doubleClick"] = True
            if method == "page.type" and step.get("optional") and step_params.get("text") == "":
                step_log.append({"step": idx + 1, "op": op, "skipped": True})
                continue
            if save_as_routine:
                step_params["_fromRoutine"] = True
            s0 = time.perf_counter()
            try:
                res = self._call(method, step_params)
                succeeded += 1
                save_key = step.get("saveAs")
                if save_key:
                    if method == "page.fetch" and isinstance(res, dict) and isinstance(res.get("data"), str):
                        raw_txt = base64.b64decode(res["data"]).decode("utf-8", errors="replace")
                        if strip_html:
                            import html as _html
                            import re as _re
                            no_scripts = _re.sub(r"(?is)<(?:script|style|head)\b.*?</(?:script|style|head)>", "", raw_txt)
                            with_breaks = _re.sub(r"(?i)</?(?:p|div|br|li|tr|h[1-6]|table)\b[^>]*>", "\n", no_scripts)
                            no_tags = _re.sub(r"<[^>]+>", "", with_breaks)
                            lines_clean = [ln.strip() for ln in _html.unescape(no_tags).splitlines()]
                            val: Any = _re.sub(r"\n{3,}", "\n\n", "\n".join(lines_clean)).strip()
                        else:
                            val = raw_txt
                    else:
                        val = res["value"] if isinstance(res, dict) and "value" in res else (res["text"] if isinstance(res, dict) and "text" in res else res)
                    outputs[save_key] = val
                    vars_map[save_key] = val
                step_log.append({"step": idx + 1, "op": op, "ok": True, "ms": round((time.perf_counter() - s0) * 1000)})
            except BridgeError as exc:
                if step.get("optional"):
                    step_log.append({"step": idx + 1, "op": op, "ok": False, "optionalIgnored": True, "error": str(exc)})
                else:
                    failed += 1
                    step_log.append({"step": idx + 1, "op": op, "ok": False, "ms": round((time.perf_counter() - s0) * 1000), "error": str(exc)})
                    if stop_on_error:
                        raise
        saved_name: str | None = None
        if failed == 0 and save_as_routine and save_as_routine.strip():
            r_name = save_as_routine.strip()
            self.save_routine(
                routine={
                    "name": r_name,
                    "description": description.strip() or f"Saved {len(steps)}-step batch routine.",
                    "readOnly": all_read_safe,
                    "source": "batch_saved",
                    "params": {},
                    "steps": steps,
                }
            )
            saved_name = r_name
        return {
            "tabId": self.tab_id,
            "elapsedMs": round((time.perf_counter() - t0) * 1000),
            "stepsExecuted": len(step_log),
            "succeeded": succeeded,
            "failed": failed,
            "steps": step_log,
            "outputs": outputs,
            "savedRoutine": saved_name,
        }

    def save_routine(
        self,
        *,
        routine: dict[str, Any] | None = None,
        note: str | None = None,
        delete_routine: str | None = None,
        reset_access_profile: bool = False,
        domain: str | None = None,
    ) -> dict[str, Any]:
        if routine is not None:
            defaults = {
                name: spec["default"]
                for name, spec in (routine.get("params") or {}).items()
                if isinstance(spec, dict) and "default" in spec
            }
            resolved_steps = [
                {**step, "params": self._interpolate_step(step.get("params") or {}, defaults)}
                for step in routine.get("steps") or []
            ]
            self._validate_debug_routine_steps(resolved_steps)
        self.browser.start()
        params: dict[str, Any] = {"tabId": self.tab_id}
        if domain:
            params["domain"] = domain
        elif isinstance(self.browser._transport, _Transport):
            params["domain"] = urllib.parse.urlsplit(self.url).hostname or ""
        if routine is not None:
            params["routine"] = routine
        if note is not None:
            params["note"] = note
        if delete_routine is not None:
            params["deleteRoutine"] = delete_routine
        if reset_access_profile:
            params["resetAccessProfile"] = True
        if isinstance(self.browser._transport, _Transport):
            return self.browser.call("routine.save", params)
        return self.browser.call("site.save", params)

    def handoff(
        self,
        message: str | None = None,
        *,
        bring_to_front: bool = True,
        timeout: float = 300_000,
    ) -> dict[str, Any]:
        """Hands the tab to the user with a floating Continue card and WAIT badge, resuming when Continue is clicked."""
        budget = _timeout(timeout)
        params: dict[str, Any] = {"bringToFront": bool(bring_to_front), "timeoutMs": budget}
        if message:
            params["message"] = message
        return self._call("page.handoff", params, timeout=budget + 10_000)

    def resolve_handoff(self, action: str = "continue") -> dict[str, Any]:
        return self._call("page.handoff", {"action": action})

    def demonstrate(
        self,
        instruction: str | None = None,
        *,
        save_as: str | None = None,
        description: str = "",
        bring_to_front: bool = True,
        timeout: float = 300_000,
    ) -> dict[str, Any]:
        """Records user-demonstrated steps on the page (never passwords/OTPs) and optionally saves as a Site Routine."""
        budget = _timeout(timeout)
        params: dict[str, Any] = {"bringToFront": bool(bring_to_front), "timeoutMs": budget}
        if instruction:
            params["instruction"] = instruction
        out = self._call("page.demonstrate", params, timeout=budget + 10_000)
        if out.get("completed") and save_as and out.get("steps"):
            steps = out["steps"]
            self.save_routine(
                routine={
                    "name": save_as,
                    "description": description or f"User-demonstrated workflow ({len(steps)} steps).",
                    "readOnly": False,
                    "params": {},
                    "steps": steps,
                }
            )
            out["savedRoutine"] = save_as
        return out

    def finish_demonstration(self, action: str = "finish") -> dict[str, Any]:
        return self._call("page.demonstrate", {"action": action})

    def start_network_capture(
        self,
        *,
        max_entries: int = 200,
        url_include: str | None = None,
        clear: bool = True,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"action": "start", "maxEntries": max_entries, "clear": clear}
        if url_include:
            params["urlInclude"] = url_include
        return self._call("page.network", params)

    def network_exchanges(self, *, only_failures: bool = False, limit: int = 100) -> list[dict[str, Any]]:
        return self._call("page.network", {"action": "status", "onlyFailures": only_failures, "limit": limit}).get("exchanges") or []

    def stop_network_capture(self, *, only_failures: bool = False, limit: int = 100) -> list[dict[str, Any]]:
        return self._call("page.network", {"action": "stop", "onlyFailures": only_failures, "limit": limit}).get("exchanges") or []

    def console_messages(self, *, level: str = "all", limit: int = 100, clear: bool = False) -> list[dict[str, Any]]:
        return self._call("page.console", {"action": "read", "level": level, "limit": limit, "clear": clear}).get("entries") or []

    def clear_console(self) -> int:
        return int(self._call("page.console", {"action": "clear"}).get("cleared", 0))

    def close(self) -> None:
        if self._closed:
            return
        self._call("tabs.close")
        self._closed = True
        self.browser._owned_pages.pop(self.tab_id, None)


class Locator(_FinderScope):
    def __init__(self, page: Page, steps: list[dict[str, Any]], frame_id: int | None = None):
        self._page = page
        self._steps = steps
        self._frame_id = frame_id

    def _target(self) -> dict[str, Any]:
        locator: dict[str, Any] = {"steps": self._steps}
        if self._frame_id is not None:
            locator["frameId"] = self._frame_id
        return {"locator": locator}

    def nth(self, index: int) -> Locator:
        return Locator(self._page, self._steps + [{"kind": "nth", "index": index}], self._frame_id)

    @property
    def first(self) -> Locator:
        return self.nth(0)

    @property
    def last(self) -> Locator:
        return self.nth(-1)

    def filter(self, *, has_text: str) -> Locator:
        return Locator(self._page, self._steps + [{"kind": "filter", "value": has_text}], self._frame_id)

    def _action(self, method: str, parameters: dict[str, Any] | None = None, timeout: float | None = None) -> dict[str, Any]:
        budget = _timeout(self._page.browser.timeout if timeout is None else timeout)
        return self._page._call(method, {**self._target(), **(parameters or {}), "timeoutMs": budget}, timeout=budget + 20_000)

    def click(self, *, button: str = "left", modifiers: list[str] | None = None, timeout: float | None = None) -> None:
        self._action("page.click", {"button": button, "modifiers": modifiers or []}, timeout)

    def dblclick(self, *, button: str = "left", timeout: float | None = None) -> None:
        self._action("page.click", {"button": button, "doubleClick": True}, timeout)

    def hover(self, *, timeout: float | None = None) -> None:
        self._action("page.hover", timeout=timeout)

    def drag_to(
        self,
        target: Locator,
        *,
        steps: int = 10,
        source_offset: tuple[float, float] = (0, 0),
        target_offset: tuple[float, float] = (0, 0),
        timeout: float | None = None,
    ) -> dict[str, Any]:
        budget = _timeout(self._page.browser.timeout if timeout is None else timeout)
        from_loc: dict[str, Any] = {"steps": self._steps}
        if self._frame_id is not None:
            from_loc["frameId"] = self._frame_id
        to_loc: dict[str, Any] = {"steps": target._steps}
        if target._frame_id is not None:
            to_loc["frameId"] = target._frame_id
        return self._page._call(
            "page.drag",
            {
                "fromLocator": from_loc,
                "toLocator": to_loc,
                "fromOffsetX": source_offset[0],
                "fromOffsetY": source_offset[1],
                "toOffsetX": target_offset[0],
                "toOffsetY": target_offset[1],
                "steps": steps,
                "timeoutMs": budget,
            },
            timeout=budget + 20_000,
        )

    def fill(self, value: str, *, timeout: float | None = None) -> None:
        self._action("page.type", {"text": value, "clear": True}, timeout)

    def clear(self, *, timeout: float | None = None) -> None:
        self.fill("", timeout=timeout)

    def type(self, text: str, *, timeout: float | None = None) -> None:
        self._action("page.type", {"text": text, "clear": False, "slowly": True}, timeout)

    press_sequentially = type

    def press(self, key: str, *, timeout: float | None = None) -> None:
        self._action("page.press", {"key": key}, timeout)

    def select_option(self, values: str | list[str], *, timeout: float | None = None) -> list[str]:
        return self._action("page.select", {"values": [values] if isinstance(values, str) else values}, timeout)["selected"]

    def set_checked(self, checked: bool, *, timeout: float | None = None) -> None:
        self._action("page.check", {"checked": checked}, timeout)

    def check(self, *, timeout: float | None = None) -> None:
        self.set_checked(True, timeout=timeout)

    def uncheck(self, *, timeout: float | None = None) -> None:
        self.set_checked(False, timeout=timeout)

    def scroll_into_view_if_needed(self, *, timeout: float | None = None) -> None:
        self._action("page.scroll", timeout=timeout)

    def set_input_files(
        self,
        files: str | os.PathLike[str] | list[str | os.PathLike[str]],
        *,
        timeout: float | None = None,
    ) -> list[str]:
        import mimetypes

        file_list = [files] if isinstance(files, (str, os.PathLike)) else list(files)
        if not file_list:
            raise ValueError("files must not be empty")
        chunk_raw = 384 * 1024  # multiple of 3 for unpadded Base64 concatenation
        upload_id = f"py-up-{os.getpid()}-{id(self)}"
        total = 0
        paths = [Path(f) for f in file_list]
        for p in paths:
            if not p.is_file():
                raise FileNotFoundError(f"Upload file not found: {p}")
            total += p.stat().st_size
            if total > 20 * 1024 * 1024:
                raise BridgeError("body_too_large", "Total upload payload exceeds the 20 MiB limit.")

        last_res: dict[str, Any] = {}
        for f_idx, p in enumerate(paths):
            raw = p.read_bytes()
            mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
            chunks = [raw[i : i + chunk_raw] for i in range(0, len(raw), chunk_raw)] or [b""]
            for c_idx, chunk in enumerate(chunks):
                is_last = (f_idx + 1 == len(paths)) and (c_idx + 1 == len(chunks))
                params: dict[str, Any] = {
                    "uploadId": upload_id,
                    "fileName": p.name,
                    "mimeType": mime,
                    "chunkBase64": base64.b64encode(chunk).decode("ascii"),
                    "append": c_idx > 0,
                    "commit": is_last,
                }
                if f_idx == 0 and c_idx == 0:
                    params["reset"] = True
                if is_last:
                    last_res = self._action("page.upload", params, timeout)
                else:
                    self._page._call("page.upload", params)
        return last_res.get("files", [])

    def screenshot(
        self,
        path: str | os.PathLike[str] | None = None,
        *,
        type: str | None = None,
        quality: int = 80,
        max_width: int = 4096,
        timeout: float | None = None,
    ) -> bytes:
        fmt = type
        if fmt is None:
            suffix = Path(path).suffix.lower() if path is not None else ""
            fmt = "jpeg" if suffix in {".jpg", ".jpeg"} else "png"
        if fmt not in {"png", "jpeg"}:
            raise ValueError("type must be png or jpeg")
        result = self._action("page.screenshot", {"format": fmt, "quality": quality, "maxWidth": max_width}, timeout)
        data = base64.b64decode(result["data"], validate=True)
        if path is not None:
            Path(path).write_bytes(data)
        return data

    def wait_for(self, *, state: str = "visible", timeout: float | None = None) -> None:
        budget = _timeout(self._page.browser.timeout if timeout is None else timeout)
        self._page._call("page.waitFor", {**self._target(), "state": state, "timeoutSeconds": budget / 1000}, timeout=budget + 5000)

    def _read(self, operation: str, *, timeout: float | None = None, **options: Any) -> Any:
        if operation not in {"count", "isVisible", "isHidden"}:
            self.wait_for(state="attached", timeout=timeout)
        result = self._page._call("page.query", {**self._target(), "operation": operation, **options})
        if result.get("truncated"):
            raise BridgeError("truncated", "Element content exceeds the read limit. Narrow the locator or increase max_chars.")
        return result["value"]

    def count(self) -> int:
        return self._read("count")

    def inner_text(self, *, timeout: float | None = None, max_chars: int = 100_000) -> str:
        return self._read("innerText", timeout=timeout, maxChars=max_chars)

    def text_content(self, *, timeout: float | None = None, max_chars: int = 100_000) -> str | None:
        return self._read("textContent", timeout=timeout, maxChars=max_chars)

    def input_value(self, *, timeout: float | None = None) -> str:
        return self._read("inputValue", timeout=timeout)

    def get_attribute(self, name: str, *, timeout: float | None = None) -> str | None:
        return self._read("getAttribute", timeout=timeout, attribute=name)

    def _read_all(self, operation: str, attribute: str | None = None) -> list[Any]:
        result = self._page._call("page.queryAll", {**self._target(), "operation": operation, "attribute": attribute})
        if result.get("truncated"):
            raise BridgeError("truncated", "Bulk read exceeded its result budget. Narrow the locator.")
        return result["values"]

    def all_text_contents(self) -> list[str]:
        return self._read_all("textContent")

    def all_inner_texts(self) -> list[str]:
        return self._read_all("innerText")

    def all_attributes(self, name: str) -> list[str | None]:
        return self._read_all("getAttribute", name)

    def is_visible(self) -> bool:
        return self._read("isVisible")

    def is_hidden(self) -> bool:
        return self._read("isHidden")

    def is_enabled(self, *, timeout: float | None = None) -> bool:
        return self._read("isEnabled", timeout=timeout)

    def is_disabled(self, *, timeout: float | None = None) -> bool:
        return self._read("isDisabled", timeout=timeout)

    def is_editable(self, *, timeout: float | None = None) -> bool:
        return self._read("isEditable", timeout=timeout)

    def is_checked(self, *, timeout: float | None = None) -> bool:
        return self._read("isChecked", timeout=timeout)
