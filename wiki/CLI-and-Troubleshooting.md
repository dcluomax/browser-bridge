# CLI and Troubleshooting

## CLI Quick Reference

```bash
# Check native host registrations and live browser connections
BrowserBridge status
BrowserBridge status --json

# Take a background screenshot directly from the terminal
BrowserBridge screenshot out.png --full-page
BrowserBridge screenshot header.png --tab 42 --selector "header"

# View or reset learned Site Memory playbooks
BrowserBridge routines
BrowserBridge routines app.diagrams.net
BrowserBridge routines example.com --reset-profile

# Inspect recent URL-redacted session activity (origin+path only, <=500 entries)
BrowserBridge activity
BrowserBridge activity --limit 20 --json

# Inspect or switch GitHub Copilot MCP read-only mode
BrowserBridge mcp-mode status
BrowserBridge mcp-mode read-only
BrowserBridge mcp-mode read-write

# Print version
BrowserBridge --version
```

---

## Common Issues & Fixes

### 1. Popup says *"Native host is not installed"* or shows disconnected
- **Cause:** Either `install.ps1` / `install.sh` has not been run yet, or the unpacked extension was loaded from a folder whose manifest key differs from the registered `--chromium-id`.
- **Fix:**
  1. Run `.\scripts\install.ps1` (Windows) or `./scripts/install.sh` (macOS/Linux).
  2. Confirm `edge://extensions` / `chrome://extensions` loaded the stable folder (`%LOCALAPPDATA%\BrowserBridge\extension\chromium` or `~/.browser-bridge/extension/chromium`) and matches the printed 32-character Extension ID.
  3. Click **Reload** on the extension card, then open the popup and click **Reconnect**.

### 2. Agent reports *"No connected browser"* (`unavailable`)
- Ensure your browser window is open and the Browser Bridge toolbar icon shows a **green dot**.
- Run `BrowserBridge status` in a terminal to see which browser instances and profile labels are currently online.
- If you passed a `browser` selector (e.g. `browser="Work"`), verify the **Profile Label** in the popup Settings matches `"Work"`.

### 3. Agent receives `forbidden: Tab is not shared`
- By default, existing tabs are private. Click the Browser Bridge toolbar button on that tab (or right-click the page → **Browser Bridge**) to share it in `Read-Only` or `Read-Write` mode, or let the agent open its own background tab via `browser_tabs({ "action": "new" })`.

### 4. Agent receives `read_only` when trying to click or type
Check the three Read-Only gates:
1. Was the tab shared in **`Read-Only`** (`AI` green badge)? Click **`Read-Write`** in the popup to promote it.
2. Is **Global Read-Only Lock** enabled in the popup Settings? Turn it off when mutations are intended.
3. Was the MCP server started with `--read-only` (or `BROWSER_BRIDGE_READ_ONLY=1`)? Run `BrowserBridge mcp-mode status` to check.

### 5. Chromium shows *"Browser Bridge started debugging this browser"* banner
- That banner is Chromium's standard indicator while `chrome.debugger` Trusted Input is attached to dispatch genuine user-activation mouse/keyboard events or capture full-page screenshots.
- If you prefer never seeing the banner, open the Browser Bridge popup → **Settings** → turn off **Trusted Mouse & Keyboard Input** (actions will use DOM events instead).

### 6. Where to Find Diagnostic Logs
- **Native host log:**
  - Windows: `%LOCALAPPDATA%\BrowserBridge\logs\native-host.log`
  - macOS / Linux: `~/.browser-bridge/logs/native-host.log`
- **MCP server stderr:** Visible inside your AI client's MCP server output panel (for example VS Code *Output → MCP: browser-bridge*).
- **Extension background console:** `edge://extensions` or `chrome://extensions` → Browser Bridge card → **Inspect views: service worker**.
