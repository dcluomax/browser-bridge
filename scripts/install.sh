#!/usr/bin/env bash
set -euo pipefail

# Turnkey installer for Browser Bridge on macOS and Linux.
# Usage:
#   ./scripts/install.sh [--register-copilot] [--register-claude] [--register-cursor] [--register-all]
#                        [--install-python] [--read-only] [--allow-evaluate] [--skip-extension-build]

REGISTER_COPILOT=0
REGISTER_CLAUDE=0
REGISTER_CURSOR=0
INSTALL_PYTHON=0
READ_ONLY=0
ALLOW_EVAL=0
SKIP_EXT=0

for arg in "$@"; do
  case "$arg" in
    --register-copilot) REGISTER_COPILOT=1 ;;
    --register-claude)  REGISTER_CLAUDE=1 ;;
    --register-cursor)  REGISTER_CURSOR=1 ;;
    --register-all)     REGISTER_COPILOT=1; REGISTER_CLAUDE=1; REGISTER_CURSOR=1 ;;
    --install-python)   INSTALL_PYTHON=1 ;;
    --read-only)        READ_ONLY=1 ;;
    --allow-evaluate)   ALLOW_EVAL=1 ;;
    --skip-extension-build) SKIP_EXT=1 ;;
    -h|--help)
      sed -n '3,6p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${HOME}/.browser-bridge/app"
EXT_DIR="${HOME}/.browser-bridge/extension"

if [[ "${SKIP_EXT}" -eq 0 ]]; then
  cd "${REPO}/extension"
  [[ -d node_modules ]] || npm ci --no-fund --no-audit
  node build.mjs
fi

cd "${REPO}/rust"
cargo build --release -p browser-bridge

mkdir -p "${APP_DIR}" "${EXT_DIR}/chromium" "${EXT_DIR}/firefox"
cp "${REPO}/rust/target/release/BrowserBridge" "${APP_DIR}/BrowserBridge"
chmod +x "${APP_DIR}/BrowserBridge"

rm -rf "${EXT_DIR}/chromium" "${EXT_DIR}/firefox"
mkdir -p "${EXT_DIR}/chromium" "${EXT_DIR}/firefox"
cp -R "${REPO}/extension/dist/chromium/." "${EXT_DIR}/chromium/"
cp -R "${REPO}/extension/dist/firefox/." "${EXT_DIR}/firefox/"

CHROMIUM_ID="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${REPO}/extension/bridge.config.json','utf8')).chromiumExtensionId)")"
GECKO_ID="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${REPO}/extension/bridge.config.json','utf8')).geckoId)")"

"${APP_DIR}/BrowserBridge" install --chromium-id "${CHROMIUM_ID}" --gecko-id "${GECKO_ID}" --host-path "${APP_DIR}/BrowserBridge"

register_mcp_json() {
  local cfg_path="$1"
  local is_copilot="$2"
  local label="$3"
  node - "${cfg_path}" "${APP_DIR}/BrowserBridge" "${is_copilot}" "${READ_ONLY}" "${ALLOW_EVAL}" "${label}" <<'NODE'
const fs = require('fs');
const path = require('path');
const [cfgPath, exe, isCopilot, ro, allowEval, label] = process.argv.slice(2);
const dir = path.dirname(cfgPath);
fs.mkdirSync(dir, { recursive: true });
let doc = { mcpServers: {} };
if (fs.existsSync(cfgPath)) {
  doc = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}
doc.mcpServers = doc.mcpServers || {};
const args = ['mcp'];
if (ro === '1') args.push('--read-only');
if (allowEval === '1') args.push('--allow-evaluate');
doc.mcpServers['browser-bridge'] = isCopilot === '1'
  ? { type: 'local', command: exe, args, tools: ['*'] }
  : { command: exe, args };
fs.writeFileSync(cfgPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
console.log(`Registered MCP server 'browser-bridge' for ${label} in ${cfgPath}`);
NODE
}

if [[ "${REGISTER_COPILOT}" -eq 1 ]]; then
  register_mcp_json "${HOME}/.copilot/mcp-config.json" "1" "GitHub Copilot"
fi

if [[ "${REGISTER_CLAUDE}" -eq 1 ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    CLAUDE_CFG="${HOME}/Library/Application Support/Claude/claude_desktop_config.json"
  else
    CLAUDE_CFG="${XDG_CONFIG_HOME:-${HOME}/.config}/Claude/claude_desktop_config.json"
  fi
  register_mcp_json "${CLAUDE_CFG}" "0" "Claude Desktop"
fi

if [[ "${REGISTER_CURSOR}" -eq 1 ]]; then
  register_mcp_json "${HOME}/.cursor/mcp.json" "0" "Cursor"
fi

if [[ "${INSTALL_PYTHON}" -eq 1 ]]; then
  python3 -m pip install "${REPO}/python"
fi

echo ""
echo "Browser Bridge installed successfully!"
echo "Load the extension once per browser profile:"
echo "  Edge:    edge://extensions   -> Developer mode -> Load unpacked -> ${EXT_DIR}/chromium"
echo "  Chrome:  chrome://extensions -> Developer mode -> Load unpacked -> ${EXT_DIR}/chromium"
echo "  Firefox: about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> ${EXT_DIR}/firefox/manifest.json"
echo "Expected Chromium extension id: ${CHROMIUM_ID}"
echo "Native host & MCP server:       ${APP_DIR}/BrowserBridge"
echo "Verify connection status with:  \"${APP_DIR}/BrowserBridge\" status"
