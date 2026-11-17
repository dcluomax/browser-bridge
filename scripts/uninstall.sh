#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${HOME}/.browser-bridge"
EXE="${BASE_DIR}/app/BrowserBridge"

if [[ -x "${EXE}" ]]; then
  "${EXE}" uninstall
fi

if [[ "${1:-}" == "--purge" && -d "${BASE_DIR}" ]]; then
  rm -rf "${BASE_DIR}"
  echo "Removed ${BASE_DIR}"
fi

echo "Browser Bridge native host unregistered. Remove the unpacked extension in your browser and delete any MCP config entry if no longer needed."
