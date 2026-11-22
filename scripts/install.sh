#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="${REPO}/scripts/distribution.py"
PYTHON="${BROWSER_BRIDGE_PYTHON:-python3}"
PACKAGE=""
OUTPUT="${REPO}/dist"
SKIP_DESKTOP=0
SKIP_EXTENSION=0
VALIDATE_ONLY=0
INSTALL_PYTHON=0
FIREFOX_XPI=""
INSTALL_ROOT="${HOME}/.browser-bridge"
OPTIONS=()
BROWSERS=()

need_value() {
  [[ $# -ge 2 && -n "$2" ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-desktop|--host-only) SKIP_DESKTOP=1; shift ;;
    --skip-extension-build) SKIP_EXTENSION=1; shift ;;
    --validate-only) VALIDATE_ONLY=1; shift ;;
    --install-python) INSTALL_PYTHON=1; shift ;;
    --prebuilt-package) need_value "$@"; PACKAGE="$2"; shift 2 ;;
    --output) need_value "$@"; OUTPUT="$2"; shift 2 ;;
    --install-root) need_value "$@"; INSTALL_ROOT="$2"; shift 2 ;;
    --firefox-xpi) need_value "$@"; FIREFOX_XPI="$2"; shift 2 ;;
    --browser) need_value "$@"; BROWSERS+=("$2"); shift 2 ;;
    --descriptor|--sha256|--version|--agent|--copilot-config|--codex-config|--claude-config|--firefox-exe)
      need_value "$@"; OPTIONS+=("$1" "$2"); shift 2 ;;
    --read-only|--read-write|--allow-evaluate|--deny-evaluate|--firefox-dev-launcher)
      OPTIONS+=("$1"); shift ;;
    --register-copilot|--register-copilot-mcp) OPTIONS+=(--agent copilot); shift ;;
    --register-codex|--register-codex-mcp) OPTIONS+=(--agent codex); shift ;;
    --register-claude|--register-claude-mcp) OPTIONS+=(--agent claude); shift ;;
    --register-all) OPTIONS+=(--agent copilot --agent codex --agent claude); shift ;;
    -h|--help)
      printf '%s\n' 'Usage: install.sh [--prebuilt-package ZIP] [--browser edge|chrome|chromium|firefox] [--agent copilot|codex|claude] [--firefox-dev-launcher]'
      exit 0 ;;
    *) printf 'Unknown installation option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

"${PYTHON}" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || {
  printf '%s\n' 'Python 3.11+ is required. Offline installation needs no Rust or Node.' >&2; exit 1;
}
[[ "${VALIDATE_ONLY}" -eq 0 || -n "${PACKAGE}" ]] || { printf '%s\n' '--validate-only requires --prebuilt-package.' >&2; exit 2; }
[[ -z "${PACKAGE}" || -z "${FIREFOX_XPI}" ]] || { printf '%s\n' 'A prebuilt package cannot be modified with --firefox-xpi.' >&2; exit 2; }

if [[ -z "${PACKAGE}" ]]; then
  if [[ "${SKIP_EXTENSION}" -eq 0 ]]; then
    (cd "${REPO}/extension" && ([[ -d node_modules ]] || npm ci --no-fund --no-audit) && node build.mjs --zip)
  fi
  (cd "${REPO}/rust" && cargo build --locked --release -p browser-bridge)
  PACKAGE_OPTIONS=(pack --root "${REPO}" --native-binary "${REPO}/rust/target/release/BrowserBridge" --output "${OUTPUT}")
  if [[ -n "${FIREFOX_XPI}" ]]; then PACKAGE_OPTIONS+=(--firefox-xpi "${FIREFOX_XPI}"); fi
  "${PYTHON}" "${ENGINE}" "${PACKAGE_OPTIONS[@]}"
  VERSION="$("${PYTHON}" -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "${REPO}/extension/package.json")"
  TARGET="$("${PYTHON}" -c 'import sys; sys.path.insert(0,sys.argv[1]); from distribution import current_target; print(current_target())' "${REPO}/scripts")"
  PACKAGE="${OUTPUT}/browser-bridge-${VERSION}-${TARGET}.zip"
fi

if [[ "${VALIDATE_ONLY}" -eq 1 ]]; then
  VERIFY_OPTIONS=(verify --package "${PACKAGE}")
  for ((index=0; index<${#OPTIONS[@]}; index++)); do
    case "${OPTIONS[index]}" in
      --descriptor|--sha256|--version)
        VERIFY_OPTIONS+=("${OPTIONS[index]}" "${OPTIONS[index+1]}"); ((index+=1)) ;;
    esac
  done
  "${PYTHON}" "${ENGINE}" "${VERIFY_OPTIONS[@]}"
  exit 0
fi
if [[ ${#BROWSERS[@]} -eq 0 ]]; then BROWSERS=(firefox); fi
INSTALL_OPTIONS=(install --package "${PACKAGE}" --install-root "${INSTALL_ROOT}")
if [[ "${SKIP_DESKTOP}" -eq 1 ]]; then INSTALL_OPTIONS+=(--skip-desktop); fi
for browser in "${BROWSERS[@]}"; do INSTALL_OPTIONS+=(--browser "${browser}"); done
# Bash 3.2 (macOS) rejects an empty array expansion under `set -u`.
"${PYTHON}" "${ENGINE}" "${INSTALL_OPTIONS[@]}" ${OPTIONS[@]+"${OPTIONS[@]}"}
if [[ "${INSTALL_PYTHON}" -eq 1 ]]; then
  "${PYTHON}" -m pip install "${REPO}/python"
fi
printf '%s\n' 'No browser or agent was restarted. See docs/INSTALLATION.md for supported browser activation.'