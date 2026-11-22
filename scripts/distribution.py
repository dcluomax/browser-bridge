#!/usr/bin/env python3
"""Verified Browser Bridge packages, transactional installs, and explicit updates.

Python 3.11+; no third-party packages or background jobs.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import io
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from agent_config import ConfigError, merge_codex_config, merge_json_config

PROJECT = "browser-bridge"
REPOSITORY = "https://github.com/dcluomax/browser-bridge"
ORIGIN = "https://github.com"
API_ORIGIN = "https://api.github.com"
API = API_ORIGIN + "/repos/dcluomax/browser-bridge"
CDN_HOSTS = frozenset({"objects.githubusercontent.com", "release-assets.githubusercontent.com"})
HOST_NAME = "io.github.dcluomax.browser_bridge"
CHROMIUM_ID = "ggkciaoahjoickdapninkfaceeadombm"
GECKO_ID = "browser-bridge@dcluomax.github.io"
PROTOCOL = 1
SAFE_AUTOMATIC_UPDATE_VERSION = 1
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_JSON = 1024 * 1024
MAX_FILES = 2048
TARGETS = {
    f"{system}-{arch}" for system in ("windows", "linux", "macos")
    for arch in ("x86_64", "aarch64")
}
BROWSERS = ("edge", "chrome", "chromium", "firefox")
BOOTSTRAP = (
    "scripts/distribution.py", "scripts/agent_config.py", "scripts/firefox_dev.py",
    "scripts/install.ps1", "scripts/install.sh", "docs/INSTALLATION.md",
)
OPTIONAL_BOOTSTRAP = ("scripts/auto-update.ps1",)
_SEMVER = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_ASSET = re.compile(
    r"^(?:manifest\.json|background\.js|content\.js|webmcp\.js|popup\.js|popup\.html|popup\.css"
    r"|icons/icon-(?:16|32|48|128)\.png|_locales/[A-Za-z0-9_-]+/messages\.json)$"
)


class DistributionError(ValueError):
    pass


class IdleUpdateSkipped(DistributionError):
    pass


def version_tuple(value: object) -> tuple[int, int, int]:
    if not isinstance(value, str) or not _SEMVER.fullmatch(value):
        raise DistributionError("Version must use canonical MAJOR.MINOR.PATCH without a prefix or prerelease.")
    result = tuple(map(int, value.split(".")))
    if any(part > 9007199254740991 for part in result):
        raise DistributionError("Version components exceed the supported numeric range.")
    return result


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def valid_digest(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise DistributionError("A checksum must contain 64 lowercase SHA256 hexadecimal characters.")
    return value


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n").encode("utf-8")


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise DistributionError(f"Duplicate JSON field: {key}")
        result[key] = value
    return result


def parse_json(data: bytes, description: str) -> dict:
    if len(data) > MAX_JSON:
        raise DistributionError(f"{description} exceeds the JSON size limit.")
    try:
        value = json.loads(data.decode("utf-8-sig"), object_pairs_hook=_unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DistributionError(f"{description} is not valid UTF-8 JSON.") from error
    if not isinstance(value, dict):
        raise DistributionError(f"{description} must be a JSON object.")
    return value


def safe_member(name: object) -> str:
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_./-]*", name):
        raise DistributionError(f"Unsafe archive member: {name!r}")
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise DistributionError(f"Archive traversal is not allowed: {name!r}")
    for part in parts:
        if part.endswith(".") or re.fullmatch(r"(?i)(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part):
            raise DistributionError(f"Archive member uses a reserved filename: {name!r}")
    return name


def no_links(path: Path, recursive: bool = False) -> None:
    for ancestor in reversed((path, *path.parents)):
        try:
            info = ancestor.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise DistributionError(f"Links and reparse points are not allowed here: {ancestor}")
    if recursive and path.is_dir():
        for entry in path.rglob("*"):
            info = entry.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise DistributionError(f"Links and reparse points are not allowed here: {entry}")
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise DistributionError(f"Only regular files and directories are allowed: {entry}")


def local_path(value: str | Path, *, file: bool = False) -> Path:
    text = str(value)
    if not text or any(ord(char) < 32 for char in text) or any(char in text for char in '*?"<>|'):
        raise DistributionError("A local path contains unsupported characters.")
    if text.startswith(("\\\\", "//")) or ".." in re.split(r"[/\\]", text):
        raise DistributionError("Network paths and parent traversal are not allowed.")
    if os.name == "nt":
        tail = text[2:] if re.match(r"^[A-Za-z]:", text) else text
        if ":" in tail:
            raise DistributionError("Alternate data streams are not allowed.")
        if any(part.endswith((" ", ".")) or re.fullmatch(r"(?i)(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part)
               for part in re.split(r"[/\\]", tail) if part and part != "."):
            raise DistributionError("Reserved/trailing Windows path names are not allowed.")
    elif "\\" in text or re.match(r"^[A-Za-z]:", text):
        raise DistributionError("Use a native absolute or relative filesystem path.")
    path = Path(text).absolute()
    no_links(path)
    if file and not path.is_file():
        raise DistributionError(f"Required file does not exist: {path}")
    return path


def read_file(path: Path, limit: int = MAX_ARCHIVE) -> bytes:
    no_links(path)
    if not path.is_file() or path.stat().st_size > limit:
        raise DistributionError(f"File is missing or exceeds its size limit: {path}")
    with path.open("rb") as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise DistributionError(f"File exceeds its size limit: {path}")
    return data


def atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    no_links(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    no_links(path.parent)
    pending = path.with_name(f".{path.name}.new-{uuid.uuid4().hex}")
    try:
        with pending.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        pending.chmod(mode)
        if os.name == "nt" and path.exists():
            import ctypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            replace = kernel.ReplaceFileW
            replace.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_wchar_p,
                               ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p]
            replace.restype = ctypes.c_int
            if not replace(str(path), str(pending), None, 0, None, None):
                raise ctypes.WinError(ctypes.get_last_error())
        else:
            os.replace(pending, path)
    finally:
        if pending.exists():
            pending.unlink()


def current_target() -> str:
    system = {"Windows": "windows", "Linux": "linux", "Darwin": "macos"}.get(platform.system())
    machine = platform.machine().lower()
    arch = {"amd64": "x86_64", "x86_64": "x86_64", "arm64": "aarch64", "aarch64": "aarch64"}.get(machine)
    result = f"{system}-{arch}"
    if result not in TARGETS:
        raise DistributionError(f"No supported package target for {platform.system()} {machine}.")
    return result


def native_name(target: str) -> str:
    return "BrowserBridge.exe" if target.startswith("windows-") else "BrowserBridge"


def check_identity(value: dict, target: str | None = None, version: str | None = None) -> None:
    expected = {
        "schemaVersion": 1, "project": PROJECT, "repository": REPOSITORY,
        "nativeHostName": HOST_NAME, "chromiumExtensionId": CHROMIUM_ID,
        "geckoId": GECKO_ID, "protocolVersion": PROTOCOL,
    }
    if any(type(value.get(key)) is not type(item) or value.get(key) != item for key, item in expected.items()):
        raise DistributionError("Package identity, extension IDs, or native protocol does not match Browser Bridge.")
    release = value.get("version")
    version_tuple(release)
    if value.get("nativeVersion") != release or value.get("extensionVersion") != release:
        raise DistributionError("Package, native, and extension versions must match exactly.")
    if value.get("target") not in TARGETS or (target is not None and value["target"] != target):
        raise DistributionError("Package platform/architecture does not match this installation.")
    if version is not None and release != version:
        raise DistributionError(f"Expected version {version}, not {release}.")


def chromium_id(key: object) -> str:
    if not isinstance(key, str):
        raise DistributionError("The Chromium manifest has no pinned public key.")
    try:
        binary = base64.b64decode(key, validate=True)
    except ValueError as error:
        raise DistributionError("The Chromium public key is not valid Base64.") from error
    digest = hashlib.sha256(binary).hexdigest()[:32]
    return "".join(chr(ord("a") + int(char, 16)) for char in digest)


def check_extension_manifest(data: bytes, browser: str, version: str) -> dict:
    manifest = parse_json(data, f"{browser} extension manifest")
    if manifest.get("version") != version:
        raise DistributionError(f"The {browser} extension version does not match the native package.")
    if browser == "chromium":
        if manifest.get("manifest_version") != 3 or chromium_id(manifest.get("key")) != CHROMIUM_ID:
            raise DistributionError("The Chromium extension ID or manifest format is incorrect.")
    else:
        settings = manifest.get("browser_specific_settings")
        if not isinstance(settings, dict):
            raise DistributionError("The Firefox manifest has no valid browser-specific settings.")
        gecko = settings.get("gecko", {})
        if manifest.get("manifest_version") != 2 or not isinstance(gecko, dict) or gecko.get("id") != GECKO_ID:
            raise DistributionError("The Firefox extension ID or manifest format is incorrect.")
    permissions = manifest.get("permissions")
    if not isinstance(permissions, list) or "nativeMessaging" not in permissions:
        raise DistributionError(f"The {browser} extension does not request native messaging.")
    return manifest


def zip_stamp() -> tuple[int, int, int, int, int, int]:
    raw = os.environ.get("SOURCE_DATE_EPOCH", "315532800")
    if not re.fullmatch(r"[0-9]+", raw):
        raise DistributionError("SOURCE_DATE_EPOCH must contain UTC epoch seconds.")
    try:
        stamp = time.gmtime(int(raw))[:6]
    except (OverflowError, OSError) as error:
        raise DistributionError("SOURCE_DATE_EPOCH is outside the supported ZIP range.") from error
    if not 1980 <= stamp[0] <= 2107:
        raise DistributionError("ZIP timestamps must be between 1980 and 2107.")
    return stamp


def make_zip(files: dict[str, bytes], executables: set[str] | None = None) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(files.items()):
            safe_member(name)
            entry = zipfile.ZipInfo(name, date_time=zip_stamp())
            entry.create_system = 3
            mode = 0o100755 if name in (executables or set()) else 0o100644
            entry.external_attr = mode << 16
            archive.writestr(entry, data)
    data = output.getvalue()
    if len(data) > MAX_ARCHIVE:
        raise DistributionError("The package exceeds the supported archive size.")
    return data


def zip_files(data: bytes, description: str, *, allow_directories: bool = False) -> dict[str, bytes]:
    if len(data) > MAX_ARCHIVE or not data.startswith(b"PK\x03\x04"):
        raise DistributionError(f"{description} must be an actual ZIP file with local entries, not TAR.")
    result = {}
    seen = set()
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if not entries or len(entries) > MAX_FILES or (archive.comment and not allow_directories):
                raise DistributionError(f"{description} has too many entries or an unexpected archive comment.")
            if sum(entry.file_size for entry in entries) > MAX_ARCHIVE:
                raise DistributionError(f"{description} exceeds the expanded size limit.")
            for entry in entries:
                name = safe_member(entry.filename.removesuffix("/") if entry.is_dir() else entry.filename)
                if name.lower() in seen:
                    raise DistributionError(f"Duplicate/case-colliding archive member: {name}")
                seen.add(name.lower())
                mode = entry.external_attr >> 16
                if entry.is_dir():
                    if (not allow_directories or entry.file_size != 0 or entry.flag_bits & 1
                            or stat.S_IFMT(mode) not in (0, stat.S_IFDIR)
                            or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                            or archive.read(entry) != b""):
                        raise DistributionError(f"Unsafe directory archive member: {name}")
                    continue
                if (stat.S_IFMT(mode) not in (0, stat.S_IFREG)) or entry.flag_bits & 1:
                    raise DistributionError(f"Encrypted, linked, or non-file archive member: {name}")
                if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise DistributionError(f"Unsupported archive compression: {name}")
                if entry.file_size > MAX_ARCHIVE:
                    raise DistributionError(f"Archive member exceeds the size limit: {name}")
                content = archive.read(entry)
                if len(content) != entry.file_size:
                    raise DistributionError(f"Archive member size mismatch: {name}")
                result[name] = content
    except (zipfile.BadZipFile, RuntimeError, EOFError, NotImplementedError) as error:
        raise DistributionError(f"{description} failed ZIP CRC/format validation.") from error
    return result


def check_native_format(data: bytes, target: str) -> None:
    architecture = target.rsplit("-", 1)[-1]
    if target.startswith("windows-"):
        offset = int.from_bytes(data[60:64], "little") if len(data) >= 64 else len(data)
        machine = 0x8664 if architecture == "x86_64" else 0xAA64
        good = (data.startswith(b"MZ") and offset >= 64 and offset + 6 <= len(data)
                and data[offset:offset + 4] == b"PE\0\0"
                and int.from_bytes(data[offset + 4:offset + 6], "little") == machine)
    elif target.startswith("linux-"):
        machine = 62 if architecture == "x86_64" else 183
        good = (len(data) >= 20 and data.startswith(b"\x7fELF") and data[4:6] == b"\x02\x01"
                and int.from_bytes(data[18:20], "little") == machine)
    else:
        cpu = 0x01000007 if architecture == "x86_64" else 0x0100000C
        if data[:4] in (b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf"):
            order = "little" if data[:4] == b"\xcf\xfa\xed\xfe" else "big"
            good = len(data) >= 8 and int.from_bytes(data[4:8], order) == cpu
        elif data[:4] in (b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"):
            order = "big" if data[:4] == b"\xca\xfe\xba\xbe" else "little"
            count = int.from_bytes(data[4:8], order)
            good = 0 < count <= 16 and len(data) >= 8 + count * 20 and any(
                int.from_bytes(data[8 + index * 20:12 + index * 20], order) == cpu for index in range(count)
            )
        else:
            good = False
    if not good:
        raise DistributionError("The native payload is not an executable for the stated package platform.")


def run_native(executable: Path, args: list[str], timeout: int = 15) -> str:
    try:
        result = subprocess.run(
            [str(executable), *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=timeout, check=False, encoding="utf-8",
        )
    except (OSError, subprocess.TimeoutExpired, UnicodeDecodeError) as error:
        raise DistributionError(f"Native validation did not complete for {executable.name}.") from error
    if result.returncode:
        raise DistributionError(f"{executable.name} {' '.join(args)} failed with exit code {result.returncode}.")
    if len(result.stdout) > MAX_JSON:
        raise DistributionError("Native validation output exceeds its size limit.")
    return result.stdout.strip()


def smoke_native(executable: Path, version: str, runner=run_native) -> None:
    actual = runner(executable, ["--version"])
    if actual != version:
        raise DistributionError(f"Native --version reported {actual!r}; expected {version}. No installation was changed.")


def source_version(root: Path) -> str:
    package = parse_json(read_file(root / "extension" / "package.json", MAX_JSON), "extension package")
    version = package.get("version")
    version_tuple(version)
    values = [
        tomllib.loads(read_file(root / "rust" / "Cargo.toml", MAX_JSON).decode())["workspace"]["package"]["version"],
        tomllib.loads(read_file(root / "python" / "pyproject.toml", MAX_JSON).decode())["project"]["version"],
    ]
    if (root / "package.json").is_file():
        values.append(parse_json(read_file(root / "package.json", MAX_JSON), "root package")["version"])
    ext_lock = parse_json(read_file(root / "extension" / "package-lock.json"), "npm lock")
    values.extend((ext_lock["version"], ext_lock["packages"][""]["version"]))
    cargo_lock = tomllib.loads(read_file(root / "rust" / "Cargo.lock").decode())
    values.extend(item["version"] for item in cargo_lock["package"] if item["name"] in ("bridge-core", "browser-bridge"))
    if any(value != version for value in values):
        raise DistributionError("Source metadata versions are not aligned; refuse to produce a mixed release.")
    config = parse_json(read_file(root / "extension" / "bridge.config.json"), "bridge identity")
    if config.get("nativeHostName") != HOST_NAME or config.get("geckoId") != GECKO_ID or config.get("chromiumExtensionId") != CHROMIUM_ID:
        raise DistributionError("Source extension/native IDs do not match the trusted project.")
    if chromium_id(config.get("chromiumPublicKey")) != CHROMIUM_ID:
        raise DistributionError("The source Chromium ID does not match its pinned public key.")
    for path in (root / "extension" / "src" / "shared" / "protocol.ts", root / "rust" / "crates" / "bridge-core" / "src" / "lib.rs"):
        text = read_file(path, MAX_JSON).decode()
        match = re.search(r"\bPROTOCOL_VERSION(?:\s*:\s*[A-Za-z0-9_]+)?\s*=\s*([0-9]+)", text)
        if not match or int(match[1]) != PROTOCOL:
            raise DistributionError("The source protocol does not match the package installer protocol.")
    return version


def extension_files(directory: Path, browser: str, version: str) -> dict[str, bytes]:
    no_links(directory, recursive=True)
    if not directory.is_dir():
        raise DistributionError(f"Build the {browser} extension before packaging.")
    files = {}
    for path in directory.rglob("*"):
        if path.is_file():
            name = path.relative_to(directory).as_posix()
            if not _ASSET.fullmatch(name):
                raise DistributionError(f"Refusing unexpected extension/source/secret file: {name}")
            files[name] = read_file(path)
    if "manifest.json" not in files:
        raise DistributionError(f"The {browser} build has no manifest.")
    check_extension_manifest(files["manifest.json"], browser, version)
    return files


@dataclass(frozen=True)
class VerifiedPackage:
    data: bytes
    manifest: dict
    files: dict[str, bytes]
    digest: str
    manifest_digest: str


def verify_package(
    data: bytes, *, expected_sha256: str | None = None, expected_size: int | None = None,
    expected_manifest_sha256: str | None = None, target: str | None = None,
    version: str | None = None,
) -> VerifiedPackage:
    digest = sha256(data)
    if expected_sha256 is not None and digest != valid_digest(expected_sha256):
        raise DistributionError("Package SHA256 mismatch. Refusing the corrupted/untrusted archive.")
    if expected_size is not None and (type(expected_size) is not int or expected_size != len(data)):
        raise DistributionError("Package size does not match the trusted descriptor.")
    files = zip_files(data, "Browser Bridge package")
    if "manifest.json" not in files:
        raise DistributionError("Package has no distribution manifest.")
    raw = files.pop("manifest.json")
    manifest_digest = sha256(raw)
    if expected_manifest_sha256 is not None and manifest_digest != valid_digest(expected_manifest_sha256):
        raise DistributionError("Package manifest SHA256 does not match the trusted descriptor.")
    manifest = parse_json(raw, "distribution manifest")
    check_identity(manifest, target, version)
    items = manifest.get("files")
    if not isinstance(items, list) or len(items) != len(files):
        raise DistributionError("Package file list is missing, incomplete, or contains unexpected files.")
    known = set()
    host_entry = f"app/{native_name(manifest['target'])}"
    for item in items:
        if not isinstance(item, dict):
            raise DistributionError("Package file records must be objects.")
        name = safe_member(item.get("path"))
        if name in known or name not in files:
            raise DistributionError(f"Package file list repeats or cannot find {name}.")
        known.add(name)
        if type(item.get("size")) is not int or item["size"] != len(files[name]) or valid_digest(item.get("sha256")) != sha256(files[name]):
            raise DistributionError(f"Package member checksum/size mismatch: {name}")
        if type(item.get("executable")) is not bool:
            raise DistributionError(f"Package member has invalid executable metadata: {name}")
        allowed = name in (*BOOTSTRAP, *OPTIONAL_BOOTSTRAP) or name in (
            host_entry,
            f"extension/artifacts/browser-bridge-firefox-{manifest['version']}.xpi",
            f"extension/artifacts/browser-bridge-chromium-{manifest['version']}.zip",
        )
        for browser in ("chromium", "firefox"):
            prefix = f"extension/{browser}/"
            allowed = allowed or (name.startswith(prefix) and bool(_ASSET.fullmatch(name[len(prefix):])))
        if not allowed:
            raise DistributionError(f"Unexpected package member outside the distribution allowlist: {name}")
        if item["executable"] != (name == host_entry):
            raise DistributionError(f"Only the native host binary can be an executable payload: {name}")
    required = {host_entry, *BOOTSTRAP}
    required.update(f"extension/{browser}/manifest.json" for browser in ("chromium", "firefox"))
    required.update(f"extension/artifacts/browser-bridge-{browser}-{manifest['version']}.{suffix}" for browser, suffix in (("firefox", "xpi"), ("chromium", "zip")))
    if not required.issubset(files):
        raise DistributionError("Package is missing a required host, extension, installer, or archive.")
    if manifest.get("components") != ["host", "extension"]:
        raise DistributionError("Package components do not match the supported distribution format.")
    check_native_format(files[host_entry], manifest["target"])
    for browser, suffix in (("chromium", "zip"), ("firefox", "xpi")):
        check_extension_manifest(files[f"extension/{browser}/manifest.json"], browser, manifest["version"])
        archived = zip_files(files[f"extension/artifacts/browser-bridge-{browser}-{manifest['version']}.{suffix}"],
                             f"{browser} extension archive", allow_directories=True)
        body = {name.removeprefix(f"extension/{browser}/"): data for name, data in files.items() if name.startswith(f"extension/{browser}/")}
        signatures = {name for name in archived if name.startswith("META-INF/")}
        if any(name not in body and name not in signatures for name in archived):
            raise DistributionError(f"The {browser} archive contains unexpected extra files.")
        if any(archived.get(name) != data for name, data in body.items()):
            raise DistributionError(f"The {browser} archive does not match its unpacked extension files.")
        if browser == "chromium" and signatures:
            raise DistributionError("Unexpected Firefox signature metadata in the Chromium archive.")
        if browser == "firefox":
            presence = ({"META-INF/manifest.mf", "META-INF/mozilla.rsa"} <= signatures
                        or {"META-INF/cose.manifest", "META-INF/cose.sig"} <= signatures)
            expected = "signature-present-unverified" if presence else "unsigned-development"
            if manifest.get("firefoxSigning") != expected or (signatures and not presence):
                raise DistributionError("The Firefox signing description does not match its archive.")
    return VerifiedPackage(data, manifest, files, digest, manifest_digest)


def package_artifact(
    root: Path, native_binary: Path, output: Path, *, target: str | None = None,
    extension_directory: Path | None = None, firefox_xpi: Path | None = None,
    runner=run_native,
) -> tuple[Path, dict]:
    target = target or current_target()
    if target not in TARGETS:
        raise DistributionError("Unsupported package target.")
    version = source_version(root)
    check_native_format(read_file(native_binary), target)
    if target == current_target():
        smoke_native(native_binary, version, runner)
    extension_directory = extension_directory or root / "extension" / "dist"
    files = {name: read_file(root.joinpath(*PurePosixPath(name).parts)) for name in BOOTSTRAP}
    for name in OPTIONAL_BOOTSTRAP:
        path = root.joinpath(*PurePosixPath(name).parts)
        if path.exists():
            files[name] = read_file(path)
    files[f"app/{native_name(target)}"] = read_file(native_binary)
    executables = {f"app/{native_name(target)}"}
    signing = "unsigned-development"
    for browser in ("chromium", "firefox"):
        body = extension_files(extension_directory / browser, browser, version)
        files.update({f"extension/{browser}/{name}": data for name, data in body.items()})
        suffix = "xpi" if browser == "firefox" else "zip"
        if browser == "firefox" and firefox_xpi is not None:
            archive = read_file(firefox_xpi)
            contents = zip_files(archive, "signed Firefox XPI", allow_directories=True)
            if any(contents.get(name) != data for name, data in body.items()):
                raise DistributionError("The supplied Firefox XPI does not match the built extension.")
            signatures = set(contents) - set(body)
            if not all(name.startswith("META-INF/") for name in signatures) or not (
                {"META-INF/manifest.mf", "META-INF/mozilla.rsa"} <= signatures
                or {"META-INF/cose.manifest", "META-INF/cose.sig"} <= signatures
            ):
                raise DistributionError("The supplied Firefox XPI has no supported signing metadata.")
            signing = "signature-present-unverified"
        else:
            archive = make_zip(body)
        files[f"extension/artifacts/browser-bridge-{browser}-{version}.{suffix}"] = archive
    components = ["host", "extension"]
    identity = {
        "schemaVersion": 1, "project": PROJECT, "repository": REPOSITORY, "version": version,
        "nativeVersion": version, "extensionVersion": version, "protocolVersion": PROTOCOL,
        "nativeHostName": HOST_NAME, "chromiumExtensionId": CHROMIUM_ID, "geckoId": GECKO_ID,
        "target": target,
    }
    manifest = {
        **identity, "components": components, "firefoxSigning": signing,
        "files": [{"path": name, "size": len(data), "sha256": sha256(data), "executable": name in executables}
                  for name, data in sorted(files.items())],
    }
    manifest_data = json_bytes(manifest)
    archive = make_zip({**files, "manifest.json": manifest_data}, executables)
    verify_package(archive, target=target, version=version)
    stem = f"browser-bridge-{version}-{target}"
    descriptor = {
        **identity, "file": stem + ".zip", "size": len(archive), "sha256": sha256(archive),
        "manifestSha256": sha256(manifest_data),
    }
    output.mkdir(parents=True, exist_ok=True)
    package_path = output / (stem + ".zip")
    descriptor_path = output / (stem + ".json")
    for path, data in ((package_path, archive), (descriptor_path, json_bytes(descriptor))):
        if path.exists() and read_file(path) != data:
            raise DistributionError(f"Refusing to replace a different artifact for the same version: {path}")
    atomic_write(package_path, archive, 0o644)
    atomic_write(descriptor_path, json_bytes(descriptor), 0o644)
    sums = "".join(f"{sha256(read_file(path))}  {path.name}\n" for path in (package_path, descriptor_path))
    atomic_write(output / (stem + ".SHA256SUMS"), sums.encode("ascii"), 0o644)
    return package_path, descriptor


def package_from_path(
    path: Path, descriptor_path: Path | None = None, expected_sha256: str | None = None,
    *, target: str | None = None, version: str | None = None,
) -> VerifiedPackage:
    if descriptor_path is None and path.with_suffix(".json").is_file():
        descriptor_path = path.with_suffix(".json")
    descriptor = None
    if descriptor_path is not None:
        descriptor = parse_json(read_file(descriptor_path, MAX_JSON), "artifact descriptor")
        check_identity(descriptor, target, version)
        if descriptor.get("file") != path.name:
            raise DistributionError("The artifact descriptor filename does not match the package.")
        valid_digest(descriptor.get("sha256"))
        valid_digest(descriptor.get("manifestSha256"))
        if type(descriptor.get("size")) is not int or not 0 < descriptor["size"] <= MAX_ARCHIVE:
            raise DistributionError("The artifact descriptor has an invalid package size.")
        if expected_sha256 is not None and expected_sha256 != descriptor["sha256"]:
            raise DistributionError("The supplied SHA256 disagrees with the artifact descriptor.")
        expected_sha256 = descriptor["sha256"]
    if expected_sha256 is None:
        raise DistributionError("Supply --sha256 from a trusted source or the matching artifact descriptor.")
    return verify_package(
        read_file(path), expected_sha256=expected_sha256,
        expected_size=descriptor["size"] if descriptor else None,
        expected_manifest_sha256=descriptor["manifestSha256"] if descriptor else None,
        target=target, version=version,
    )


def default_install_root() -> Path:
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA")
        if not base:
            raise DistributionError("LOCALAPPDATA is required for a current-user Windows installation.")
        return local_path(Path(base) / "BrowserBridge")
    return local_path(Path.home() / ".browser-bridge")


def read_state(root: Path) -> dict | None:
    path = root / "managed.json"
    if not path.exists():
        return None
    state = parse_json(read_file(path, MAX_JSON), "managed installation metadata")
    check_identity(state, current_target())
    for key, prefix in (("packageFile", "packages/"), ("releaseDirectory", "releases/")):
        name = safe_member(state.get(key))
        if not name.startswith(prefix):
            raise DistributionError(f"Managed installation metadata has an invalid {key}.")
    valid_digest(state.get("packageSha256"))
    valid_digest(state.get("manifestSha256"))
    if state.get("pinnedVersion") is not None:
        version_tuple(state["pinnedVersion"])
    if not isinstance(state.get("agents", []), list) or not isinstance(state.get("browsers", []), list):
        raise DistributionError("Managed configuration scopes are invalid.")
    for scope in state.get("agents", []):
        if not isinstance(scope, dict) or scope.get("target") not in ("copilot", "codex", "claude") or not isinstance(scope.get("path"), str):
            raise DistributionError("Managed metadata contains an invalid agent scope.")
        local_path(scope["path"])
    if any(browser not in BROWSERS for browser in state.get("browsers", [])):
        raise DistributionError("Managed metadata contains an invalid browser scope.")
    development = state.get("firefoxDevelopment")
    if development is not None and (not isinstance(development, dict) or development.get("enabled") is not True
                                    or not isinstance(development.get("profile"), str)
                                    or not isinstance(development.get("executable"), str)):
        raise DistributionError("Managed metadata contains an invalid Firefox development scope.")
    return state


@contextlib.contextmanager
def installation_lock(root: Path):
    no_links(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = root / ".installation.lock"
    no_links(lock)
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as error:
        raise DistributionError(
            f"Installation is locked: {lock}. Do not stop user apps. Remove a stale lock only after verifying its installer has exited."
        ) from error
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(json_bytes({"project": PROJECT, "pid": os.getpid()}))
        yield
    finally:
        lock.unlink()


def directory_digest(path: Path) -> str:
    no_links(path, recursive=True)
    records = [(entry.relative_to(path).as_posix(), sha256(read_file(entry)))
               for entry in path.rglob("*") if entry.is_file()]
    return sha256(json_bytes(sorted(records)))


class FileTransaction:
    """Reverse all completed writes on failure; never terminate an application."""

    def __init__(self, root: Path):
        self.root = root
        self.backup = root / ".rollback" / uuid.uuid4().hex
        self.operations: list[dict] = []

    def __enter__(self):
        return self

    def replace_file(self, path: Path, data: bytes, mode: int = 0o600, expected: bytes | None | object = ...) -> None:
        no_links(path)
        original = read_file(path) if path.exists() else None
        if expected is not ... and original != expected:
            raise DistributionError(f"Configuration changed during installation; refusing to overwrite it: {path}")
        old_mode = stat.S_IMODE(path.stat().st_mode) if original is not None else mode
        operation = {"kind": "file", "path": path, "old": original, "new": data, "mode": old_mode}
        self.operations.append(operation)
        atomic_write(path, data, old_mode if original is not None and not path.suffix.lower() == ".exe" else mode)

    def replace_directory(self, source: Path, destination: Path) -> None:
        no_links(source, recursive=True)
        no_links(destination, recursive=True)
        destination.parent.mkdir(parents=True, exist_ok=True)
        pending = destination.with_name(f".{destination.name}.new-{uuid.uuid4().hex}")
        backup = self.backup / destination.relative_to(self.root)
        no_links(pending)
        try:
            shutil.copytree(source, pending)
            new_digest = directory_digest(pending)
            old_digest = directory_digest(destination) if destination.exists() else None
            operation = {
                "kind": "directory", "path": destination, "backup": backup,
                "oldDigest": old_digest, "newDigest": new_digest, "movedOld": False,
            }
            self.operations.append(operation)
            if destination.exists():
                backup.parent.mkdir(parents=True, exist_ok=True)
                os.replace(destination, backup)
                operation["movedOld"] = True
            os.replace(pending, destination)
        finally:
            if pending.exists():
                shutil.rmtree(pending)

    def registry_write(self, key_path: str, value: str) -> None:
        import winreg
        old = None
        existed = True
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                try:
                    old = winreg.QueryValueEx(key, "")
                except FileNotFoundError:
                    pass
        except FileNotFoundError:
            existed = False
        operation = {"kind": "registry", "key": key_path, "old": old, "existed": existed, "new": value}
        self.operations.append(operation)
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_WRITE) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, value)

    @staticmethod
    def _restore_registry(operation: dict) -> None:
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, operation["key"], 0, winreg.KEY_ALL_ACCESS) as key:
                try:
                    current = winreg.QueryValueEx(key, "")
                except FileNotFoundError:
                    current = None
                if current == operation["old"]:
                    return
                if current != (operation["new"], winreg.REG_SZ):
                    raise DistributionError("A native registration changed concurrently; automatic rollback refused to overwrite it.")
                if operation["old"] is None:
                    winreg.DeleteValue(key, "")
                else:
                    winreg.SetValueEx(key, "", 0, operation["old"][1], operation["old"][0])
                subkeys, values, _ = winreg.QueryInfoKey(key)
            if not operation["existed"] and not subkeys and not values:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, operation["key"])
        except FileNotFoundError:
            if operation["old"] is not None:
                raise DistributionError("A previous native registration disappeared during rollback.")

    def __exit__(self, exception_type, exception, traceback):
        if exception_type is None:
            return False
        errors = []
        for operation in reversed(self.operations):
            try:
                if operation["kind"] == "registry":
                    self._restore_registry(operation)
                elif operation["kind"] == "file":
                    path = operation["path"]
                    current = read_file(path) if path.exists() else None
                    if current == operation["old"]:
                        continue
                    if current != operation["new"]:
                        raise DistributionError(f"Rollback refused to overwrite a concurrent file change: {path}")
                    if operation["old"] is None:
                        path.unlink()
                    else:
                        atomic_write(path, operation["old"], operation["mode"])
                else:
                    path, backup = operation["path"], operation["backup"]
                    if path.exists():
                        digest = directory_digest(path)
                        if digest == operation["oldDigest"] and not operation["movedOld"]:
                            continue
                        if digest != operation["newDigest"]:
                            raise DistributionError(f"Rollback refused to overwrite a concurrent extension change: {path}")
                        shutil.rmtree(path)
                    if operation["movedOld"]:
                        os.replace(backup, path)
            except (OSError, DistributionError) as error:
                errors.append(str(error))
        if errors:
            raise DistributionError(
                f"Installation failed and rollback requires attention. Backups: {self.backup}. " + "; ".join(errors)
            ) from exception
        return False


def agent_paths(home: Path | None = None) -> dict[str, Path]:
    home = home or Path.home()
    return {
        "copilot": home / ".copilot" / "mcp-config.json",
        "codex": home / ".codex" / "config.toml",
        "claude": home / ".claude.json",
    }


def configuration_plan(
    scopes: list[dict], executable: Path, read_only: bool | None, allow_evaluate: bool | None,
) -> list[tuple[Path, bytes | None, bytes]]:
    result = []
    seen = set()
    for scope in scopes:
        if not isinstance(scope, dict) or scope.get("target") not in ("copilot", "codex", "claude"):
            raise DistributionError("Managed metadata contains an unknown agent target.")
        if not isinstance(scope.get("path"), str):
            raise DistributionError("Managed metadata contains an invalid agent configuration path.")
        path = local_path(scope["path"])
        if str(path).lower() in seen:
            raise DistributionError("Two agent targets cannot share the same configuration file.")
        seen.add(str(path).lower())
        original = read_file(path, MAX_JSON) if path.exists() else None
        target = scope["target"]
        if target == "codex":
            updated = merge_codex_config(original, executable, read_only, allow_evaluate)
        else:
            updated = merge_json_config(original, target, executable, read_only, allow_evaluate)
        result.append((path, original, updated))
    return result


def registry_key(browser: str) -> str:
    vendor = {"edge": r"Microsoft\Edge", "chrome": r"Google\Chrome", "chromium": "Chromium", "firefox": "Mozilla"}[browser]
    return f"Software\\{vendor}\\NativeMessagingHosts\\{HOST_NAME}"


def unix_manifest_path(browser: str, home: Path | None = None) -> Path:
    home = home or Path.home()
    if platform.system() == "Darwin":
        vendor = {
            "edge": "Microsoft Edge", "chrome": "Google/Chrome",
            "chromium": "Chromium", "firefox": "Mozilla",
        }[browser]
        return home / "Library" / "Application Support" / vendor / "NativeMessagingHosts" / f"{HOST_NAME}.json"
    config = Path(os.environ.get("XDG_CONFIG_HOME", str(home / ".config")))
    if not config.is_absolute():
        raise DistributionError("XDG_CONFIG_HOME must be an absolute directory.")
    vendor = {"edge": "microsoft-edge", "chrome": "google-chrome", "chromium": "chromium"}
    if browser == "firefox":
        return home / ".mozilla" / "native-messaging-hosts" / f"{HOST_NAME}.json"
    return config / vendor[browser] / "NativeMessagingHosts" / f"{HOST_NAME}.json"


def native_manifest(executable: Path, browser: str) -> bytes:
    if browser not in BROWSERS or not executable.is_absolute():
        raise DistributionError("Native registration requires a supported browser and an absolute executable.")
    value = {
        "name": HOST_NAME, "description": "Browser Bridge native host for AI agents",
        "path": str(executable), "type": "stdio",
    }
    if browser == "firefox":
        value["allowed_extensions"] = [GECKO_ID]
    else:
        value["allowed_origins"] = [f"chrome-extension://{CHROMIUM_ID}/"]
    return json_bytes(value)


def register_native(transaction: FileTransaction, root: Path, executable: Path, browsers: list[str]) -> None:
    for browser in browsers:
        if browser not in BROWSERS:
            raise DistributionError(f"Unsupported native registration browser: {browser}")
        contents = native_manifest(executable, browser)
        if os.name == "nt":
            destination = root / "manifests" / f"{browser}.json"
            transaction.replace_file(destination, contents)
            transaction.registry_write(registry_key(browser), str(destination))
        else:
            transaction.replace_file(local_path(unix_manifest_path(browser)), contents)


def installed_warnings(executable: Path, version: str, runner=run_native) -> list[str]:
    try:
        status = parse_json(runner(executable, ["status", "--json"]).encode(), "native status")
        browsers = status.get("browsers")
        if not isinstance(browsers, list):
            raise DistributionError("Native status has no browser list.")
        warnings = []
        native = version_tuple(version)
        for browser in browsers:
            if not isinstance(browser, dict):
                raise DistributionError("Native status contains an invalid browser record.")
            extension = browser.get("extensionVersion")
            if extension is None:
                continue
            if version_tuple(extension)[:2] != native[:2]:
                warnings.append(
                    f"Connected {browser.get('browser', 'browser')} extension {extension} does not match native {version}. "
                    "Reload the matching extension; a development Firefox launch reactivates it only for that session."
                )
        return warnings
    except DistributionError as error:
        return [f"Installation succeeded, but connected extension versions could not be checked: {error}"]


def find_firefox(explicit: Path | None = None) -> Path:
    if explicit is not None:
        path = local_path(explicit, file=True)
        allowed = ("firefox.exe",) if os.name == "nt" else ("firefox", "firefox-bin")
        if path.name.lower() not in allowed:
            raise DistributionError("The development launcher requires the installed Firefox executable, not another application.")
        return path
    if os.name == "nt":
        candidates = [Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Mozilla Firefox" / "firefox.exe"]
    elif platform.system() == "Darwin":
        candidates = [Path("/Applications/Firefox.app/Contents/MacOS/firefox")]
    else:
        found = shutil.which("firefox")
        candidates = [Path(found)] if found else []
    for path in candidates:
        if path.is_file():
            return local_path(path, file=True)
    raise DistributionError("Specify the installed Firefox executable with --firefox-exe.")


def development_launcher(root: Path) -> tuple[Path, bytes]:
    helper = root / "tools" / "firefox_dev.py"
    if os.name == "nt":
        def quote(value: Path) -> str:
            return '"' + str(value).replace("%", "%%") + '"'
        command = f"{quote(Path(sys.executable))} {quote(helper)} --install-root {quote(root)}"
        return root / "Launch-Browser-Bridge-Firefox.cmd", (
            "@echo off\r\nsetlocal DisableDelayedExpansion\r\n" + command + "\r\nexit /b %errorlevel%\r\n"
        ).encode("utf-8")
    import shlex
    command = " ".join(shlex.quote(str(value)) for value in (Path(sys.executable), helper))
    command += " --install-root " + shlex.quote(str(root))
    return root / "Launch-Browser-Bridge-Firefox.sh", ("#!/bin/sh\nexec " + command + "\n").encode("utf-8")


def install_package(
    package: VerifiedPackage, root: Path, *, browsers: list[str] | None = None,
    agents: list[dict] | None = None, read_only: bool | None = None,
    allow_evaluate: bool | None = None, allow_downgrade: bool = False,
    firefox_dev_launcher: bool = False, firefox_exe: Path | None = None,
    require_idle: bool = False, runner=run_native, register=register_native,
) -> dict:
    root = local_path(root)
    if root == Path(root.anchor) or root == Path.home():
        raise DistributionError("The install root must be a dedicated Browser Bridge directory, not a drive root or home.")
    manifest = package.manifest
    check_identity(manifest, current_target())
    with installation_lock(root):
        previous = read_state(root)
        pin = previous.get("pinnedVersion") if previous else None
        if pin is not None and manifest["version"] != pin and (not previous or manifest["version"] != previous["version"]):
            raise DistributionError(f"Installation is pinned to {pin}. Unpin explicitly before changing versions.")
        if previous and not allow_downgrade and version_tuple(manifest["version"]) < version_tuple(previous["version"]):
            raise DistributionError("Refusing a downgrade. Use the explicit rollback command.")
        if previous and manifest["version"] == previous["version"] and package.digest != previous["packageSha256"]:
            raise DistributionError("Refusing different package bytes with the same installed release version.")
        selected_browsers = list(dict.fromkeys([*(previous.get("browsers", []) if previous else []), *(browsers or [])]))
        if any(browser not in BROWSERS for browser in selected_browsers):
            raise DistributionError("A native registration target is unsupported.")
        scopes = list(previous.get("agents", []) if previous else [])
        for scope in agents or []:
            scopes = [old for old in scopes if old.get("target") != scope.get("target")]
            scopes.append(scope)
        release_name = f"releases/{manifest['version']}-{package.digest[:16]}"
        release = root.joinpath(*PurePosixPath(release_name).parts)
        executable = release / "app" / native_name(manifest["target"])
        configurations = configuration_plan(scopes, executable, read_only, allow_evaluate)
        development = previous.get("firefoxDevelopment") if previous else None
        if firefox_dev_launcher:
            firefox = find_firefox(firefox_exe)
            development = {
                "enabled": True, "executable": str(firefox),
                "profile": str(root / "firefox-development" / "profile"),
            }
            if "firefox" not in selected_browsers:
                raise DistributionError("The Firefox development launcher requires an explicit Firefox native registration.")
        stage = root / ".staging" / uuid.uuid4().hex
        no_links(stage)
        try:
            stage.mkdir(parents=True)
            for name, contents in package.files.items():
                destination = stage.joinpath(*PurePosixPath(safe_member(name)).parts)
                item = next(record for record in manifest["files"] if record["path"] == name)
                atomic_write(destination, contents, 0o755 if item["executable"] else 0o644)
                if sha256(read_file(destination)) != item["sha256"]:
                    raise DistributionError(f"Staged file verification failed: {name}")
            atomic_write(stage / "manifest.json", json_bytes(manifest), 0o644)
            smoke_native(stage / "app" / native_name(manifest["target"]), manifest["version"], runner)
            if release.exists():
                no_links(release, recursive=True)
                for name, contents in package.files.items():
                    if read_file(release.joinpath(*PurePosixPath(name).parts)) != contents:
                        raise DistributionError("An existing immutable release was modified. Refusing to reuse it.")
            else:
                release.parent.mkdir(parents=True, exist_ok=True)
                no_links(release.parent)
                os.replace(stage, release)
            smoke_native(executable, manifest["version"], runner)
            package_name = f"packages/{package.digest}.zip"
            cached = root.joinpath(*PurePosixPath(package_name).parts)
            if cached.exists() and sha256(read_file(cached)) != package.digest:
                raise DistributionError("The retained rollback package was modified.")
            atomic_write(cached, package.data, 0o600)
            identity = {key: manifest[key] for key in (
                "schemaVersion", "project", "repository", "version", "nativeVersion", "extensionVersion",
                "protocolVersion", "nativeHostName", "chromiumExtensionId", "geckoId", "target",
            )}
            state = {
                **identity, "packageSha256": package.digest, "manifestSha256": package.manifest_digest,
                "packageFile": package_name, "releaseDirectory": release_name,
                "pinnedVersion": pin, "agents": scopes, "browsers": selected_browsers,
                "components": list(manifest["components"]),
                "firefoxDevelopment": development,
                "previous": ({key: previous[key] for key in ("version", "packageFile", "packageSha256", "manifestSha256")}
                             if previous and previous["packageSha256"] != package.digest else previous.get("previous") if previous else None),
            }
            if require_idle:
                if previous is None:
                    raise DistributionError("An automatic update requires an existing verified installation.")
                assert_update_idle(root, previous, runner)
            with FileTransaction(root) as transaction:
                transaction.replace_file(root / "app" / native_name(manifest["target"]), package.files[f"app/{native_name(manifest['target'])}"], 0o755)
                transaction.replace_directory(release / "extension", root / "extension")
                for name in ("distribution.py", "agent_config.py", "firefox_dev.py"):
                    transaction.replace_file(root / "tools" / name, package.files[f"scripts/{name}"], 0o600)
                if "scripts/auto-update.ps1" in package.files:
                    transaction.replace_file(root / "tools" / "auto-update.ps1", package.files["scripts/auto-update.ps1"], 0o600)
                register(transaction, root, executable, selected_browsers)
                for path, original, updated in configurations:
                    transaction.replace_file(path, updated, expected=original)
                if development and development.get("enabled") is True:
                    launcher, contents = development_launcher(root)
                    transaction.replace_file(launcher, contents, 0o700)
                smoke_native(root / "app" / native_name(manifest["target"]), manifest["version"], runner)
                transaction.replace_file(root / "managed.json", json_bytes(state))
            for warning in installed_warnings(executable, manifest["version"], runner):
                print("WARNING: " + warning, file=sys.stderr)
            return state
        finally:
            if stage.exists():
                no_links(stage, recursive=True)
                shutil.rmtree(stage)


def rollback_install(root: Path, runner=run_native, register=register_native) -> dict:
    state = read_state(root)
    if not state or not isinstance(state.get("previous"), dict):
        raise DistributionError("No previous verified managed installation is available for rollback.")
    previous = state["previous"]
    filename = safe_member(previous.get("packageFile"))
    if not filename.startswith("packages/"):
        raise DistributionError("The rollback package path is outside the managed package store.")
    package = verify_package(
        read_file(root.joinpath(*PurePosixPath(filename).parts)),
        expected_sha256=valid_digest(previous.get("packageSha256")),
        expected_manifest_sha256=valid_digest(previous.get("manifestSha256")),
        target=current_target(), version=previous.get("version"),
    )
    return install_package(package, root, allow_downgrade=True, runner=runner, register=register)


def repair_install(root: Path, runner=run_native, register=register_native) -> dict:
    state = read_state(root)
    if not state:
        raise DistributionError("No verified managed installation is available for repair.")
    package = verify_package(
        read_file(root.joinpath(*PurePosixPath(state["packageFile"]).parts)),
        expected_sha256=state["packageSha256"], expected_manifest_sha256=state["manifestSha256"],
        target=state["target"], version=state["version"],
    )
    return install_package(package, root, runner=runner, register=register)


def set_pin(root: Path, version: str | None) -> dict:
    with installation_lock(root):
        state = read_state(root)
        if not state:
            raise DistributionError("Install a verified package before setting a version pin.")
        if version is not None:
            version_tuple(version)
        state["pinnedVersion"] = version
        atomic_write(root / "managed.json", json_bytes(state))
        return state


def trusted_url(url: object) -> str:
    if not isinstance(url, str) or any(ord(char) < 33 for char in url):
        raise DistributionError("A release URL is invalid.")
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError as error:
        raise DistributionError("A release URL cannot be parsed safely.") from error
    if (parsed.scheme != "https" or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment):
        raise DistributionError("Release URLs must use HTTPS on the trusted GitHub origin without credentials or query tokens.")
    if "%" in parsed.path or "\\" in parsed.path or any(part in (".", "..") for part in parsed.path.split("/")):
        raise DistributionError("Encoded/traversing release paths are not allowed.")
    api_ok = parsed.netloc == "api.github.com" and bool(re.fullmatch(
        r"/repos/dcluomax/browser-bridge/releases/(?:latest|tags/v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))",
        parsed.path,
    ))
    asset_ok = parsed.netloc == "github.com" and bool(re.fullmatch(
        r"/dcluomax/browser-bridge/releases/download/v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)/[A-Za-z0-9._-]+",
        parsed.path,
    ))
    if not (api_ok or asset_ok):
        raise DistributionError("Release path is outside the trusted dcluomax/browser-bridge GitHub release routes.")
    return url


class SafeGitHubRedirect(urllib.request.HTTPRedirectHandler):
    """Permits at most 1 credential-stripped HTTPS redirect from github.com release downloads to GitHub's asset CDN."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if getattr(req, "_bb_redirected", False):
            raise DistributionError("Multiple release redirects are refused.")
        source = urllib.parse.urlsplit(req.full_url)
        if source.scheme != "https" or source.netloc != "github.com" or not source.path.startswith("/dcluomax/browser-bridge/releases/download/"):
            raise DistributionError("API and non-asset release redirects are refused.")
        if not isinstance(newurl, str) or any(ord(char) < 33 for char in newurl):
            raise DistributionError("Redirect location is invalid.")
        target = urllib.parse.urlsplit(newurl)
        if (target.scheme != "https" or target.username is not None or target.password is not None
                or target.fragment or target.netloc not in CDN_HOSTS):
            raise DistributionError("Release redirect target is outside GitHub's trusted HTTPS asset CDN.")
        clean_headers = {
            k: v for k, v in req.header_items()
            if k.lower() not in ("authorization", "cookie", "host")
        }
        redirected = urllib.request.Request(newurl, headers=clean_headers, method="GET")
        redirected._bb_redirected = True  # type: ignore[attr-defined]
        return redirected


def http_get(url: str, limit: int, expected_size: int | None = None) -> bytes:
    trusted_url(url)
    is_api = url.startswith(API_ORIGIN + "/")
    headers = {
        "Accept": "application/vnd.github+json" if is_api else "application/octet-stream",
        "Accept-Encoding": "identity",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "BrowserBridge-installer",
    }
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        if "\r" in token or "\n" in token:
            raise DistributionError("GITHUB_TOKEN contains an invalid header character.")
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, headers=headers)
    opener = urllib.request.build_opener(SafeGitHubRedirect())
    try:
        with opener.open(request, timeout=20) as response:
            if response.status != 200:
                raise DistributionError(f"Release request returned HTTP {response.status}.")
            length = response.headers.get("Content-Length")
            if length is not None:
                if not re.fullmatch(r"[0-9]+", length) or int(length) > limit:
                    raise DistributionError("Release response has an invalid or excessive size.")
                if expected_size is not None and int(length) != expected_size:
                    raise DistributionError("Release response size differs from its verified descriptor.")
            data = response.read(limit + 1)
    except urllib.error.HTTPError as error:
        raise DistributionError(f"GitHub release is unavailable (HTTP {error.code}).") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise DistributionError("The trusted GitHub release could not be reached or its TLS verification failed.") from error
    if len(data) > limit or (expected_size is not None and len(data) != expected_size):
        raise DistributionError("Release download failed its bounded size check.")
    return data


def _asset_digest(asset: dict, data: bytes) -> None:
    digest = asset.get("digest")
    if digest is not None:
        if not isinstance(digest, str) or not digest.startswith("sha256:"):
            raise DistributionError("Release asset uses an unsupported checksum declaration.")
        if valid_digest(digest[7:]) != sha256(data):
            raise DistributionError("Release asset checksum differs from the GitHub release record.")


def remote_release(target: str, requested_version: str | None = None, fetch=http_get) -> tuple[dict, dict]:
    if target not in TARGETS:
        raise DistributionError("An update requires a supported package target.")
    suffix = "latest"
    if requested_version is not None:
        version_tuple(requested_version)
        suffix = "tags/v" + requested_version
    release = parse_json(fetch(API + "/releases/" + suffix, MAX_JSON), "release metadata")
    tag = release.get("tag_name")
    if not isinstance(tag, str) or not tag.startswith("v"):
        raise DistributionError("The release has no canonical version tag.")
    version = tag[1:]
    version_tuple(version)
    if requested_version is not None and version != requested_version:
        raise DistributionError("The release tag does not match the requested/pinned version.")
    if release.get("draft") is not False or release.get("prerelease") is not False:
        raise DistributionError("Draft/prerelease or incomplete release metadata cannot be installed.")
    assets = release.get("assets")
    if not isinstance(assets, list) or any(not isinstance(asset, dict) for asset in assets):
        raise DistributionError("Release has no valid asset list.")
    stem = f"browser-bridge-{version}-{target}"
    selected = []
    for filename in (stem + ".json", stem + ".zip"):
        matches = [asset for asset in assets if asset.get("name") == filename]
        if len(matches) != 1:
            raise DistributionError(f"The release must contain exactly one {filename} asset.")
        asset = matches[0]
        if type(asset.get("size")) is not int or not 0 < asset["size"] <= (MAX_JSON if filename.endswith(".json") else MAX_ARCHIVE):
            raise DistributionError("Release asset has invalid size metadata.")
        trusted_url(asset.get("browser_download_url"))
        selected.append(asset)
    raw = fetch(selected[0]["browser_download_url"], MAX_JSON, selected[0]["size"])
    _asset_digest(selected[0], raw)
    descriptor = parse_json(raw, "artifact descriptor")
    check_identity(descriptor, target, version)
    valid_digest(descriptor.get("sha256"))
    valid_digest(descriptor.get("manifestSha256"))
    if descriptor.get("file") != stem + ".zip" or type(descriptor.get("size")) is not int or descriptor["size"] != selected[1]["size"]:
        raise DistributionError("Descriptor filename/size does not match its project release asset.")
    return descriptor, selected[1]


def check_update(root: Path, requested_version: str | None = None, fetch=http_get) -> dict:
    state = read_state(root)
    pin = state.get("pinnedVersion") if state else None
    if pin is not None and requested_version is not None and requested_version != pin:
        raise DistributionError(f"The installation is pinned to {pin}; the requested update conflicts.")
    descriptor, _ = remote_release(state["target"] if state else current_target(), requested_version or pin, fetch)
    if state and descriptor["version"] == state["version"] and descriptor["sha256"] != state["packageSha256"]:
        raise DistributionError("The release changed bytes without a version change. Refusing that update metadata.")
    return {
        "repository": REPOSITORY, "installedVersion": state["version"] if state else None,
        "availableVersion": descriptor["version"], "pinnedVersion": pin,
        "updateAvailable": not state or version_tuple(descriptor["version"]) > version_tuple(state["version"]),
        "sha256": descriptor["sha256"], "size": descriptor["size"],
        "trust": "HTTPS GitHub release descriptor & SHA-256 verification; this is not a cryptographically signed update feed",
    }


def assert_update_idle(root: Path, state: dict, runner=run_native) -> None:
    executable = root.joinpath(*PurePosixPath(state["releaseDirectory"]).parts) / "app" / native_name(state["target"])
    smoke_native(executable, state["version"], runner)
    try:
        status = parse_json(runner(executable, ["status", "--json"]).encode(), "native idle status")
    except DistributionError as error:
        raise IdleUpdateSkipped(f"Idle update refused: idle status cannot be verified. {error}") from error
    if status.get("browsers") != []:
        raise IdleUpdateSkipped("Idle update refused: browser connections exist or idle status cannot be verified.")
    for key in ("activeSessions", "active_sessions", "sessions"):
        if key in status and not (status[key] == [] or (type(status[key]) is int and status[key] == 0)):
            raise IdleUpdateSkipped("Idle update refused: agent sessions exist or their idle status cannot be verified.")


def apply_update(
    root: Path, requested_version: str | None = None, require_idle: bool = False,
    fetch=http_get, runner=run_native, register=register_native,
) -> dict:
    state = read_state(root)
    if not state:
        raise DistributionError("Use an explicit verified installation before applying updates.")
    pin = state.get("pinnedVersion")
    if pin is not None and requested_version is not None and requested_version != pin:
        raise DistributionError(f"The installation is pinned to {pin}; the requested update conflicts.")
    if require_idle:
        assert_update_idle(root, state, runner)
    descriptor, asset = remote_release(state["target"], requested_version or pin, fetch)
    if version_tuple(descriptor["version"]) < version_tuple(state["version"]):
        raise DistributionError("Update would downgrade the installation. Use verified local rollback.")
    if descriptor["version"] == state["version"]:
        if descriptor["sha256"] != state["packageSha256"]:
            raise DistributionError("The release changed bytes without a version change. Refusing the replacement.")
        return state
    raw = fetch(asset["browser_download_url"], MAX_ARCHIVE, descriptor["size"])
    _asset_digest(asset, raw)
    package = verify_package(
        raw, expected_sha256=descriptor["sha256"], expected_size=descriptor["size"],
        expected_manifest_sha256=descriptor["manifestSha256"], target=state["target"],
        version=descriptor["version"],
    )
    return install_package(package, root, runner=runner, register=register, require_idle=require_idle)


def argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    pack = commands.add_parser("pack", help="Create immutable deterministic ZIP/XPI artifacts.")
    pack.add_argument("--root", default=str(Path(__file__).absolute().parent.parent))
    pack.add_argument("--target", choices=sorted(TARGETS))
    pack.add_argument("--native-binary")
    pack.add_argument("--extension-dir")
    pack.add_argument("--firefox-xpi")
    pack.add_argument("--output")
    for command in ("verify", "install"):
        item = commands.add_parser(command)
        item.add_argument("--package", required=True)
        item.add_argument("--descriptor")
        item.add_argument("--sha256")
        item.add_argument("--version")
        if command == "install":
            item.add_argument("--install-root")
            item.add_argument("--browser", action="append", choices=BROWSERS)
            item.add_argument("--agent", action="append", choices=("copilot", "codex", "claude"))
            for target in ("copilot", "codex", "claude"):
                item.add_argument(f"--{target}-config")
            policy = item.add_mutually_exclusive_group()
            policy.add_argument("--read-only", dest="read_only", action="store_const", const=True, default=None)
            policy.add_argument("--read-write", dest="read_only", action="store_const", const=False)
            evaluate = item.add_mutually_exclusive_group()
            evaluate.add_argument("--allow-evaluate", dest="allow_evaluate", action="store_const", const=True, default=None)
            evaluate.add_argument("--deny-evaluate", dest="allow_evaluate", action="store_const", const=False)
            item.add_argument("--skip-desktop", action="store_true", help=argparse.SUPPRESS)
            item.add_argument("--firefox-dev-launcher", action="store_true")
            item.add_argument("--firefox-exe")
    for command in ("check", "apply", "rollback", "repair", "pin", "unpin"):
        item = commands.add_parser(command)
        item.add_argument("--install-root")
        if command in ("check", "apply", "pin"):
            item.add_argument("--version")
        if command == "apply":
            item.add_argument("--require-idle", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = argument_parser().parse_args(argv)
    try:
        if args.operation == "pack":
            root = local_path(args.root)
            target = args.target or current_target()
            native = local_path(args.native_binary or root / "rust" / "target" / "release" / native_name(target), file=True)
            path, descriptor = package_artifact(
                root, native, local_path(args.output or root / "dist"),
                target=target, extension_directory=local_path(args.extension_dir) if args.extension_dir else None,
                firefox_xpi=local_path(args.firefox_xpi, file=True) if args.firefox_xpi else None,
            )
            print(json.dumps({"package": str(path), **descriptor}, indent=2))
        elif args.operation in ("verify", "install"):
            if args.version is not None:
                version_tuple(args.version)
            package = package_from_path(
                local_path(args.package, file=True),
                local_path(args.descriptor, file=True) if args.descriptor else None,
                args.sha256, target=current_target() if args.operation == "install" else None, version=args.version,
            )
            if args.operation == "verify":
                print(json.dumps({"verified": True, "version": package.manifest["version"], "sha256": package.digest, "target": package.manifest["target"]}))
            else:
                paths = agent_paths()
                for target in paths:
                    custom = getattr(args, target + "_config")
                    if custom and target not in (args.agent or []):
                        raise DistributionError(f"--{target}-config requires explicit --agent {target}.")
                    if custom:
                        paths[target] = local_path(custom)
                root = local_path(args.install_root) if args.install_root else default_install_root()
                state = install_package(
                    package, root, browsers=args.browser,
                    agents=[{"target": target, "path": str(local_path(paths[target]))} for target in dict.fromkeys(args.agent or [])],
                    read_only=args.read_only, allow_evaluate=args.allow_evaluate,
                    firefox_dev_launcher=args.firefox_dev_launcher,
                    firefox_exe=local_path(args.firefox_exe, file=True) if args.firefox_exe else None,
                )
                print(json.dumps({"installedVersion": state["version"], "installRoot": str(root), "browsers": state["browsers"], "agents": [item["target"] for item in state["agents"]]}, indent=2))
                if state.get("firefoxDevelopment"):
                    launcher, _ = development_launcher(root)
                    print(f"Development launcher (not started): {launcher}")
                print("Release Firefox requires Mozilla-validated signing for a permanent installation.")
                print(f"Unsigned session activation: about:debugging -> Load Temporary Add-on -> {root / 'extension' / 'firefox' / 'manifest.json'}")
        else:
            root = local_path(args.install_root) if args.install_root else default_install_root()
            if args.operation == "check":
                result = check_update(root, args.version)
            elif args.operation == "apply":
                result = apply_update(root, args.version, args.require_idle)
            elif args.operation == "rollback":
                result = rollback_install(root)
            elif args.operation == "repair":
                result = repair_install(root)
            else:
                state = read_state(root)
                version = (args.version or state["version"]) if args.operation == "pin" and state else None
                result = set_pin(root, version)
            print(json.dumps(result, indent=2))
        return 0
    except IdleUpdateSkipped as error:
        print(f"SKIPPED: {error}", file=sys.stderr)
        return 3
    except (DistributionError, ConfigError, OSError, KeyError, tomllib.TOMLDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
