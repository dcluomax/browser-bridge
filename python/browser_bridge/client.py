from __future__ import annotations

import base64
import collections
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
from typing import Any


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


class _DirectTransport:
    """Connects directly to the browser native-host pipe or Unix socket without spawning an rpc process."""

    _PRIORITY = ("edge", "chrome", "chromium", "firefox", "unknown")

    def __init__(self, selector: str | None = None):
        self._selector = selector
        self._lock = threading.Lock()
        self._next_id = 1
        self._closed = False
        self._peer: _IpcPeer | None = None
        self.info: dict[str, Any] = {}

    @staticmethod
    def _current_user_key() -> str:
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
                                        return str(str_ptr.value)
                                    finally:
                                        kernel32.LocalFree(str_ptr)
                    finally:
                        kernel32.CloseHandle(token)
            except OSError:
                pass
            return re.sub(r"[^A-Za-z0-9-]", "-", os.environ.get("USERNAME", "user")) or "user"
        return re.sub(r"[^A-Za-z0-9-]", "-", os.environ.get("USER", "user")) or "user"

    @staticmethod
    def _unix_socket_dir() -> Path:
        xdg = os.environ.get("XDG_RUNTIME_DIR")
        if xdg:
            xdg_path = Path(xdg)
            if xdg_path.is_dir():
                return xdg_path / "browser-bridge"
        uid = os.geteuid() if hasattr(os, "geteuid") else 0
        return Path(tempfile.gettempdir()) / f"bb-{uid}"

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
    def _handshake(cls, pipe_name: str) -> tuple[_IpcPeer, dict[str, Any]]:
        peer = cls._open_pipe(pipe_name)
        try:
            hello = json.dumps({"type": "hello", "client": "python-sdk", "pid": os.getpid(), "events": False}, ensure_ascii=False)
            peer.send_line(hello)
            return peer, peer.recv_message(5.0)
        except BaseException:
            peer.close()
            raise

    def connect(self) -> dict[str, Any]:
        endpoints = self._discover()
        if not endpoints:
            raise BridgeError("unavailable", "No browser is connected to Browser Bridge. Make sure Edge, Chrome or Firefox is running with the Browser Bridge extension loaded (toolbar icon shows a green dot) and that the native host is installed.")
        sel = (self._selector or "").strip()
        chosen: tuple[str, str, str] | None = None
        if sel:
            chosen = next((e for e in endpoints if e[2].lower() == sel.lower()), None)
            if chosen is None:
                connected: list[tuple[tuple[str, str, str], _IpcPeer, dict[str, Any]]] = []
                for ep in endpoints:
                    try:
                        peer, info = self._handshake(ep[0])
                        connected.append((ep, peer, info))
                    except (OSError, ValueError, BridgeError):
                        pass
                match = next((c for c in connected if (c[2].get("label") or "").lower() == sel.lower()), None)
                if match is None:
                    match = next((c for c in connected if c[0][1].lower() == sel.lower() or (sel.lower() == "chrome" and c[0][1] == "chromium")), None)
                for c in connected:
                    if c is not match:
                        c[1].close()
                if match is None:
                    raise BridgeError("unavailable", f'No connected browser matches "{sel}".')
                chosen, self._peer, browser_info = match
            else:
                self._peer, browser_info = self._handshake(chosen[0])
        else:
            endpoints.sort(key=lambda e: self._PRIORITY.index(e[1]) if e[1] in self._PRIORITY else 99)
            chosen = endpoints[0]
            self._peer, browser_info = self._handshake(chosen[0])

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
            request_id = self._next_id
            self._next_id += 1
            encoded = json.dumps({"id": request_id, "method": method, "params": parameters}, ensure_ascii=False, allow_nan=False)
            if len(encoded.encode("utf-8")) > 900_000:
                raise BridgeError("request_too_large", "Request exceeds the native messaging envelope. Upload large data through a page-supported transfer API.")
            try:
                self._peer.send_line(encoded)
                response = self._peer.recv_message(timeout / 1000.0 + 5.0)
            except BridgeError:
                self.close()
                raise
            except (OSError, ValueError) as err:
                self.close()
                raise BridgeError("connection_lost", f"The browser disconnected ({err}).") from err
            if response.get("id") != request_id:
                self.close()
                raise BridgeError("protocol_error", "Response id does not match the request.")
            if response.get("ok") is not True:
                details = response.get("error")
                if not isinstance(details, dict) or not isinstance(details.get("message"), str):
                    raise BridgeError("protocol_error", "Response failure is missing error details.")
                code = details.get("code", "error")
                exception = BridgeTimeoutError if code == "timeout" else BridgeError
                raise exception(code, details["message"])
            return response.get("result")

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
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
        "page.waitFor",
        "page.screenshot",
        "page.webmcp.list",
        "page.webmcp.call",
        "routine.list",
        "routine.run",
        "site.profile",
        "request.fetch",
    })

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
            if method == "page.fetch":
                if str(payload.get("method", "GET")).upper() not in {"GET", "HEAD"}:
                    raise BridgeError("read_only", f"Read-only BrowserBridge client cannot perform {method} with {payload.get('method')}.")
            elif method not in self._READ_SAFE_METHODS:
                raise BridgeError("read_only", f"Read-only BrowserBridge client cannot perform '{method}'.")
            if method != "request.fetch":
                payload["readOnly"] = True
        self.start()
        assert self._transport is not None
        return self._transport.call(method, payload, self.timeout + 10_000 if timeout is None else timeout)

    def new_page(self, url: str | None = None) -> Page:
        result = self.call("tabs.new")
        page = Page(self, result["tabId"])
        self._owned_pages[page.tab_id] = page
        if url is not None:
            page.goto(url)
        return page

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
        if isinstance(template, str):
            if template.startswith("{{") and template.endswith("}}"):
                key = template[2:-2].strip()
                if key in variables and "{" not in key and "}" not in key:
                    return variables[key]
            out = template
            for k, v in variables.items():
                tok = "{{" + k + "}}"
                if tok in out:
                    out = out.replace(tok, "" if v is None else (v if isinstance(v, str) else json.dumps(v)))
            return out
        if isinstance(template, list):
            return [Page._interpolate_step(x, variables) for x in template]
        if isinstance(template, dict):
            return {k: Page._interpolate_step(v, variables) for k, v in template.items()}
        return template

    def routines(self, *, domain: str | None = None) -> dict[str, Any]:
        self.browser.start()
        if isinstance(self.browser._transport, _Transport):
            target_domain = domain or urllib.parse.urlsplit(self.url).hostname or ""
            return self.browser.call("routine.list", {"domain": target_domain})
        params: dict[str, Any] = {"tabId": self.tab_id}
        if domain:
            params["domain"] = domain
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
    ) -> dict[str, Any]:
        if isinstance(self.browser._transport, _Transport):
            params: dict[str, Any] = {"tabId": self.tab_id, "name": name, "arguments": arguments or {}}
            if domain:
                params["domain"] = domain
            return self.browser.call("routine.run", params)

        pb = self.routines(domain=domain)
        routine = (pb.get("routines") or {}).get(name)
        if not routine:
            raise BridgeError("not_found", f"Routine '{name}' not found for '{pb.get('domain', '')}'.")
        if self.browser.read_only and not routine.get("readOnly"):
            raise BridgeError("read_only", f"Routine '{name}' modifies page state and cannot run in read-only mode.")

        op_map = {
            "click": "page.click", "doubleClick": "page.click", "dblclick": "page.click",
            "drag": "page.drag", "hover": "page.hover", "type": "page.type", "fill": "page.fill",
            "select": "page.select", "check": "page.check", "press": "page.press", "scroll": "page.scroll",
            "waitFor": "page.waitFor", "wait_for": "page.waitFor", "locate": "page.locate",
            "query": "page.query", "get_element": "page.query", "queryAll": "page.queryAll",
            "snapshot": "page.snapshot", "text": "page.text", "screenshot": "page.screenshot",
            "navigate": "page.navigate", "history": "page.history", "dialog": "page.dialog",
            "webmcp.list": "page.webmcp.list", "webmcp.call": "page.webmcp.call",
        }
        variables: dict[str, Any] = {}
        for p_name, spec in (routine.get("params") or {}).items():
            if arguments and p_name in arguments:
                variables[p_name] = arguments[p_name]
            elif "default" in spec and spec["default"] is not None:
                variables[p_name] = spec["default"]
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
            if op in {"doubleClick", "dblclick"}:
                step_params["doubleClick"] = True
            if method == "page.type" and step.get("optional") and step_params.get("text") == "":
                continue
            try:
                res = self._call(method, step_params)
                steps_run += 1
                save_as = step.get("saveAs")
                if save_as:
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

    def save_routine(
        self,
        *,
        routine: dict[str, Any] | None = None,
        note: str | None = None,
        delete_routine: str | None = None,
        reset_access_profile: bool = False,
        domain: str | None = None,
    ) -> dict[str, Any]:
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
