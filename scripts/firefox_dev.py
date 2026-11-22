#!/usr/bin/env python3
"""Reactivate Browser Bridge with Firefox's official temporary-add-on debugger API.

Only the managed, dedicated profile is permitted. Firefox signing stays enabled.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path, PurePosixPath

from distribution import (
    DistributionError, FileTransaction, GECKO_ID, MAX_JSON, PROJECT, atomic_write, find_firefox,
    json_bytes, local_path, native_name, no_links, parse_json, read_file, read_state,
    sha256, smoke_native, verify_package,
)

LEGACY_PREFERENCES = (
    '// Browser Bridge development profile only. Signing requirements are unchanged.\n'
    'user_pref("devtools.debugger.remote-enabled", true);\n'
    'user_pref("devtools.debugger.force-local", true);\n'
    'user_pref("devtools.debugger.prompt-connection", false);\n'
).encode("utf-8")
PREFERENCES = LEGACY_PREFERENCES + b'user_pref("devtools.chrome.enabled", true);\n'


class FirefoxDebugger:
    def __init__(self, connection: socket.socket):
        self.connection = connection
        self.buffer = bytearray()

    def receive(self) -> dict:
        while b":" not in self.buffer:
            if len(self.buffer) > 10:
                raise DistributionError("Firefox debugger sent an invalid frame length.")
            self._read()
        delimiter = self.buffer.index(ord(":"))
        header = bytes(self.buffer[:delimiter])
        if not header or not header.isdigit() or len(header) > 9:
            raise DistributionError("Firefox debugger frame length is invalid.")
        size = int(header)
        if not 0 < size <= MAX_JSON:
            raise DistributionError("Firefox debugger frame exceeds the bounded message limit.")
        while len(self.buffer) < delimiter + 1 + size:
            self._read()
        data = bytes(self.buffer[delimiter + 1:delimiter + 1 + size])
        del self.buffer[:delimiter + 1 + size]
        return parse_json(data, "Firefox debugger response")

    def _read(self) -> None:
        block = self.connection.recv(65536)
        if not block:
            raise DistributionError("Firefox closed its local debugger connection.")
        self.buffer.extend(block)
        if len(self.buffer) > MAX_JSON + 65536:
            raise DistributionError("Firefox debugger buffered too much data.")

    def request(self, actor: str, message_type: str, **fields) -> dict:
        data = json.dumps({"to": actor, "type": message_type, **fields}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.connection.sendall(str(len(data)).encode("ascii") + b":" + data)
        for _ in range(128):
            response = self.receive()
            if response.get("from") == actor:
                if "error" in response:
                    raise DistributionError(f"Firefox temporary-add-on API rejected {message_type}: {response['error']}")
                return response
        raise DistributionError("Firefox debugger did not return the requested actor response.")

    def install_temporary_addon(self, archive: Path) -> str:
        greeting = self.receive()
        if greeting.get("from") != "root" or greeting.get("applicationType") != "browser":
            raise DistributionError("The selected loopback listener is not a Firefox browser debugger.")
        root = self.request("root", "getRoot")
        actor = root.get("addonsActor")
        if not isinstance(actor, str) or not actor:
            raise DistributionError("This Firefox does not expose the official temporary-add-on debugging API.")
        result = self.request(actor, "installTemporaryAddon", addonPath=str(archive))
        addon = result.get("addon")
        if not isinstance(addon, dict) or addon.get("id") != GECKO_ID:
            raise DistributionError("Firefox installed an unexpected add-on ID.")
        return addon["id"]


def prepare_profile(root: Path) -> Path:
    profile = root / "firefox-development" / "profile"
    no_links(profile)
    marker = profile / ".browser-bridge-development-profile.json"
    expected = {
        "schemaVersion": 1, "project": PROJECT, "installRoot": str(root),
        "dedicatedProfile": str(profile), "preferencesSha256": sha256(PREFERENCES),
    }
    if profile.exists():
        if not marker.is_file():
            raise DistributionError(
                "The dedicated Firefox profile path already exists without a Browser Bridge marker. "
                "Refusing to reuse, copy, or clear an unknown profile."
            )
        actual = parse_json(read_file(marker, MAX_JSON), "dedicated Firefox profile marker")
        preferences = read_file(profile / "user.js", MAX_JSON)
        legacy = {**expected, "preferencesSha256": sha256(LEGACY_PREFERENCES)}
        if actual == legacy and preferences == LEGACY_PREFERENCES:
            with FileTransaction(root) as transaction:
                transaction.replace_file(profile / "user.js", PREFERENCES)
                transaction.replace_file(marker, json_bytes(expected))
        elif actual != expected:
            raise DistributionError("The dedicated Firefox profile marker does not match this installation.")
        elif preferences != PREFERENCES:
            raise DistributionError("The dedicated profile debugger preferences changed. Refusing to overwrite them or expose a non-local debugger.")
    else:
        profile.mkdir(parents=True, mode=0o700)
        atomic_write(marker, json_bytes(expected))
        atomic_write(profile / "user.js", PREFERENCES)
    return profile


def launch_inputs(root: Path) -> tuple[dict, Path, Path, Path]:
    state = read_state(root)
    if not state:
        raise DistributionError("Install a verified Browser Bridge package first.")
    development = state.get("firefoxDevelopment")
    if not isinstance(development, dict) or development.get("enabled") is not True:
        raise DistributionError("The dedicated Firefox development launcher was not explicitly enabled during installation.")
    expected_profile = root / "firefox-development" / "profile"
    if development.get("profile") != str(expected_profile):
        raise DistributionError("A development launcher cannot use a custom or user Firefox profile.")
    firefox = find_firefox(local_path(development.get("executable", ""), file=True))
    package = verify_package(
        read_file(root.joinpath(*PurePosixPath(state["packageFile"]).parts)),
        expected_sha256=state["packageSha256"], expected_manifest_sha256=state["manifestSha256"],
        target=state["target"], version=state["version"],
    )
    archive_name = f"extension/artifacts/browser-bridge-firefox-{state['version']}.xpi"
    archive = root.joinpath(*PurePosixPath(archive_name).parts)
    if read_file(archive) != package.files[archive_name]:
        raise DistributionError("The installed Firefox XPI changed. Refusing temporary activation.")
    executable = root.joinpath(*PurePosixPath(state["releaseDirectory"]).parts) / "app" / native_name(state["target"])
    if read_file(executable) != package.files[f"app/{native_name(state['target'])}"]:
        raise DistributionError("The installed native executable changed. Refusing temporary activation.")
    smoke_native(executable, state["version"])
    return state, firefox, archive, expected_profile


def firefox_arguments(profile: Path, port: int, headless: bool = False) -> list[str]:
    if not profile.is_absolute() or not 1024 <= port <= 65535:
        raise DistributionError("Firefox requires the fixed absolute profile and a valid unprivileged loopback port.")
    args = ["--no-remote", "--new-instance", "--profile", str(profile), "--start-debugger-server", str(port)]
    if headless:
        args.append("--headless")
    return [*args, "about:blank"]


def activate(firefox: Path, archive: Path, profile: Path, timeout: int, headless: bool = False) -> tuple[subprocess.Popen, int]:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    process = subprocess.Popen(
        [str(firefox), *firefox_arguments(profile, port, headless)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    activated = False
    try:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise DistributionError(f"Dedicated Firefox exited before add-on activation (exit {process.returncode}).")
            try:
                connection = socket.create_connection(("127.0.0.1", port), timeout=min(3, max(0.1, deadline - time.monotonic())))
            except (ConnectionRefusedError, TimeoutError, OSError):
                time.sleep(0.2)
                continue
            with connection:
                connection.settimeout(min(15, max(0.1, deadline - time.monotonic())))
                FirefoxDebugger(connection).install_temporary_addon(archive)
            activated = True
            return process, port
        raise DistributionError("Dedicated Firefox did not expose its loopback debugger before the activation timeout.")
    finally:
        if not activated and process.poll() is None:
            # This is only the process this launcher created, never another Firefox/user app.
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired as error:
                raise DistributionError(f"Owned Firefox PID {process.pid} did not exit after failed activation; close that dedicated window.") from error


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-root", required=True)
    parser.add_argument("--startup-timeout", type=int, default=45)
    parser.add_argument("--headless", action="store_true", help="For explicit launcher validation; normal launches stay visible.")
    args = parser.parse_args(argv)
    process = None
    lock = None
    try:
        if not 5 <= args.startup_timeout <= 120:
            raise DistributionError("Startup timeout must be between 5 and 120 seconds.")
        root = local_path(args.install_root)
        state, firefox, archive, _ = launch_inputs(root)
        folder = root / "firefox-development"
        no_links(folder)
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock_path = folder / ".launcher.lock"
        no_links(lock_path)
        try:
            descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError as error:
            raise DistributionError(
                f"The dedicated launcher is already active or has a stale lock: {lock_path}. "
                "Close its window first. Never clear a lock while its recorded Firefox PID is running."
            ) from error
        lock = lock_path
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(json_bytes({"project": PROJECT, "launcherPid": os.getpid()}))
        profile = prepare_profile(root)
        process, port = activate(firefox, archive, profile, args.startup_timeout, args.headless)
        atomic_write(lock, json_bytes({"project": PROJECT, "launcherPid": os.getpid(), "browserPid": process.pid}))
        print(json.dumps({
            "ready": True, "browserPid": process.pid, "profile": str(profile),
            "addonId": GECKO_ID, "extensionVersion": state["version"],
            "temporary": True, "debugger": f"127.0.0.1:{port}",
        }), flush=True)
        print(
            "Browser Bridge is active only for this Firefox session. "
            "Use this launcher after each restart. The dedicated profile persists; signing remains enabled.",
            flush=True,
        )
        return process.wait()
    except (DistributionError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Launcher interrupted. The dedicated Firefox may remain open; close that window before another launch.", file=sys.stderr)
        return 130
    finally:
        if lock is not None and (process is None or process.poll() is not None):
            lock.unlink()


if __name__ == "__main__":
    raise SystemExit(main())
