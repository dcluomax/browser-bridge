#!/usr/bin/env bash
set -euo pipefail

# Zero-build 1-command installer for Browser Bridge on macOS and Linux.
# Downloads SHA-256-verified prebuilt binaries and unpacked extensions from GitHub Releases,
# registers Native Messaging hosts, and auto-configures installed AI MCP clients.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.sh | bash
#   ./scripts/bootstrap.sh [--version latest] [--read-only] [--allow-evaluate] [--install-python]
#                          [--install-root ~/.browser-bridge] [--skip-native-install] [--skip-mcp-config]

VERSION="latest"
REPO="dcluomax/browser-bridge"
INSTALL_ROOT="${BROWSER_BRIDGE_INSTALL_ROOT:-${HOME}/.browser-bridge}"
READ_ONLY=0
ALLOW_EVAL=0
INSTALL_PYTHON=0
SKIP_NATIVE=0
SKIP_MCP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)        VERSION="$2"; shift 2 ;;
    --repo)           REPO="$2"; shift 2 ;;
    --install-root)   INSTALL_ROOT="$2"; shift 2 ;;
    --read-only)      READ_ONLY=1; shift ;;
    --allow-evaluate) ALLOW_EVAL=1; shift ;;
    --install-python) INSTALL_PYTHON=1; shift ;;
    --skip-native-install) SKIP_NATIVE=1; shift ;;
    --skip-mcp-config)     SKIP_MCP=1; shift ;;
    -h|--help)
      sed -n '4,11p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"

case "${OS_NAME}:${ARCH_NAME}" in
  Darwin:arm64|Darwin:aarch64) PLATFORM_LABEL="macos-arm64" ;;
  Darwin:x86_64)               PLATFORM_LABEL="macos-x64" ;;
  Linux:x86_64|Linux:amd64)    PLATFORM_LABEL="linux-x64" ;;
  *)
    echo "No prebuilt binary for ${OS_NAME}/${ARCH_NAME}; clone https://github.com/${REPO} and run ./scripts/install.sh --register-all" >&2
    exit 1
    ;;
esac

if [[ "${VERSION}" == "latest" ]]; then
  API_URL="https://api.github.com/repos/${REPO}/releases/latest"
else
  TAG="${VERSION#v}"
  API_URL="https://api.github.com/repos/${REPO}/releases/tags/v${TAG}"
fi

PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "python3 is required by bootstrap.sh to parse JSON and verify archives cleanly." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "==> Resolving Browser Bridge release (${VERSION}) for ${PLATFORM_LABEL}..."
RELEASE_JSON="${TMP_DIR}/release.json"
curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: BrowserBridge-Bootstrap/1.0" "${API_URL}" -o "${RELEASE_JSON}"

"${PYTHON_BIN}" - "${RELEASE_JSON}" "${PLATFORM_LABEL}" "${TMP_DIR}" "${INSTALL_ROOT}" "${SKIP_NATIVE}" "${SKIP_MCP}" "${READ_ONLY}" "${ALLOW_EVAL}" "${INSTALL_PYTHON}" <<'PY'
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

(
    release_json_path,
    platform_label,
    tmp_dir_str,
    install_root_str,
    skip_native,
    skip_mcp,
    read_only,
    allow_eval,
    install_python,
) = sys.argv[1:10]

tmp_dir = Path(tmp_dir_str)
install_root = Path(install_root_str).expanduser()
release = json.loads(Path(release_json_path).read_text(encoding="utf-8"))
tag_name = release["tag_name"]
ver_num = tag_name.lstrip("v")
assets = {a["name"]: a for a in release.get("assets", [])}


def fetch_verified(asset_name: str) -> Path:
    if asset_name not in assets:
        raise SystemExit(f"Release {tag_name} is missing expected asset '{asset_name}'.")
    asset = assets[asset_name]
    dest = tmp_dir / asset_name
    print(f"  Downloading {asset_name}...")
    req = urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": "BrowserBridge-Bootstrap/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp, dest.open("wb") as out:
        shutil.copyfileobj(resp, out)
    digest = asset.get("digest") or ""
    if digest.startswith("sha256:"):
        expected = digest.split(":", 1)[1].lower()
        actual = hashlib.sha256(dest.read_bytes()).hexdigest().lower()
        if actual != expected:
            raise SystemExit(f"SHA-256 mismatch for {asset_name}: expected {expected}, got {actual}")
        print(f"  Verified SHA-256 ({expected[:12]}...)")
    return dest


def unpack_archive(archive_path: Path, dest_dir: Path) -> None:
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    if zipfile.is_zipfile(archive_path):
        with zipfile.ZipFile(archive_path, "r") as zf:
            zf.extractall(dest_dir)
    else:
        with tarfile.open(archive_path, "r:*") as tf:
            tf.extractall(dest_dir)


host_tar = fetch_verified(f"browser-bridge-{platform_label}.tar.gz")
chromium_zip = fetch_verified(f"browser-bridge-chromium-{ver_num}.zip")
firefox_xpi = fetch_verified(f"browser-bridge-firefox-{ver_num}.xpi")

stage_host = tmp_dir / "host"
unpack_archive(host_tar, stage_host)

app_dir = install_root / "app"
ext_home = install_root / "extension"
app_dir.mkdir(parents=True, exist_ok=True)
ext_home.mkdir(parents=True, exist_ok=True)

target_exe = app_dir / "BrowserBridge"
shutil.copy2(stage_host / "BrowserBridge", target_exe)
target_exe.chmod(target_exe.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
if (stage_host / "AGENT.md").is_file():
    shutil.copy2(stage_host / "AGENT.md", install_root / "AGENT.md")

unpack_archive(chromium_zip, ext_home / "chromium")
unpack_archive(firefox_xpi, ext_home / "firefox")

c_manifest = json.loads((ext_home / "chromium" / "manifest.json").read_text(encoding="utf-8"))
f_manifest = json.loads((ext_home / "firefox" / "manifest.json").read_text(encoding="utf-8"))
key_der = base64.b64decode(c_manifest["key"])
hex32 = hashlib.sha256(key_der).hexdigest()[:32]
chromium_id = "".join(chr(ord("a") + int(ch, 16)) for ch in hex32)
gecko_id = f_manifest["browser_specific_settings"]["gecko"]["id"]

if skip_native != "1":
    subprocess.run(
        [str(target_exe), "install", "--chromium-id", chromium_id, "--gecko-id", gecko_id, "--host-path", str(target_exe)],
        check=True,
    )

if skip_mcp != "1":
    mcp_args = ["mcp"]
    if read_only == "1":
        mcp_args.append("--read-only")
    if allow_eval == "1":
        mcp_args.append("--allow-evaluate")

    def merge_mcp(cfg_path: Path, root_key: str, entry: dict, label: str) -> None:
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        doc = {}
        if cfg_path.is_file():
            try:
                doc = json.loads(cfg_path.read_text(encoding="utf-8"))
            except Exception:
                doc = {}
        doc.setdefault(root_key, {})["browser-bridge"] = entry
        cfg_path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        print(f"  Registered MCP server for {label} -> {cfg_path}")

    home = Path.home()
    merge_mcp(
        home / ".copilot" / "mcp-config.json",
        "mcpServers",
        {"type": "local", "command": str(target_exe), "args": mcp_args, "tools": ["*"]},
        "GitHub Copilot CLI",
    )

    is_mac = sys.platform == "darwin"
    vscode_roots = [
        (home / "Library/Application Support/Code/User") if is_mac else ( Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")) / "Code/User" ),
        (home / "Library/Application Support/Code - Insiders/User") if is_mac else ( Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")) / "Code - Insiders/User" ),
    ]
    for vr in vscode_roots:
        if vr.is_dir():
            merge_mcp(vr / "mcp.json", "servers", {"type": "stdio", "command": str(target_exe), "args": mcp_args}, f"VS Code ({vr.parent.name})")

    claude_dir = (home / "Library/Application Support/Claude") if is_mac else (Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")) / "Claude")
    if claude_dir.is_dir():
        merge_mcp(claude_dir / "claude_desktop_config.json", "mcpServers", {"command": str(target_exe), "args": mcp_args}, "Claude Desktop")

    if (home / ".claude.json").is_file():
        merge_mcp(home / ".claude.json", "mcpServers", {"type": "stdio", "command": str(target_exe), "args": mcp_args}, "Claude Code")

    if (home / ".cursor").is_dir():
        merge_mcp(home / ".cursor/mcp.json", "mcpServers", {"command": str(target_exe), "args": mcp_args}, "Cursor")

    if (home / ".codeium/windsurf").is_dir():
        merge_mcp(home / ".codeium/windsurf/mcp_config.json", "mcpServers", {"command": str(target_exe), "args": mcp_args}, "Windsurf")

if install_python == "1":
    whl_names = [n for n in assets if n.startswith("browser_bridge-") and n.endswith(".whl")]
    if whl_names:
        whl_path = fetch_verified(whl_names[0])
        subprocess.run([sys.executable, "-m", "pip", "install", "--force-reinstall", str(whl_path)], check=True)

print("")
print(f"Browser Bridge {tag_name} is installed and ready!")
print(f"  Host & MCP server:   {target_exe}")
print(f"  Chromium extension:  {ext_home / 'chromium'}   (ID: {chromium_id})")
print(f"  Firefox extension:   {ext_home / 'firefox' / 'manifest.json'}   (ID: {gecko_id})")
print("")
print("Final one-time step in your browser:")
print(f"  Edge:    edge://extensions   -> Enable 'Developer mode' -> 'Load unpacked' -> {ext_home / 'chromium'}")
print(f"  Chrome:  chrome://extensions -> Enable 'Developer mode' -> 'Load unpacked' -> {ext_home / 'chromium'}")
print(f"  Firefox: about:debugging#/runtime/this-firefox -> 'Load Temporary Add-on' -> {ext_home / 'firefox' / 'manifest.json'}")
PY
