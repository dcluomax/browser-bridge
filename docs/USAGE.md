# Browser Bridge Usage & Onboarding Guide

This guide walks through installing Browser Bridge in one AI prompt (or via the zero-build bootstrapper / source build), loading the extension across browsers, sharing tabs safely, using the CLI, and uninstalling.

---

## 1. Fastest Onboarding: Install in One Prompt (Zero Build Tools Required)

Paste this single prompt into **GitHub Copilot** (VS Code / CLI), **Claude Code**, **Cursor**, **Windsurf**, **Cline**, or **Codex**:

```text
Install and configure Browser Bridge by following https://raw.githubusercontent.com/dcluomax/browser-bridge/main/docs/INSTALL.md — download and SHA-256-verify the prebuilt release for my OS/CPU, register the native host and my AI client MCP config, verify with `BrowserBridge status`, and print the exact extension folder path to load in my browser.
```

Or run the zero-build bootstrapper directly in a terminal:

```powershell
# Windows (PowerShell — x64 & ARM64)
irm https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.ps1 | iex
```

```bash
# macOS (Apple Silicon & Intel) / Linux (x64)
curl -fsSL https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.sh | bash
```

---

## 2. Building & Installing from Source

| Tool | Minimum Version | Purpose |
| --- | --- | --- |
| **Rust & Cargo** | `1.85+` | Compiles the standalone `BrowserBridge` native host & MCP binary |
| **Node.js & npm** | `20.0+` | Bundles the Chromium MV3 & Firefox MV2 extensions |
| **Python** *(optional)* | `3.10+` | Installs the zero-dependency `browser-bridge` Python SDK |
| **Windows Build Tools** *(Windows only)* | MSVC (`vcvars64` / `vcvarsarm64`) | `scripts\install.ps1` auto-discovers Visual Studio Build Tools even when not on `PATH` |

### Source Installation Commands

### Windows (PowerShell)

```powershell
# Recommended: build, install, register MCP clients, and install Python SDK
.\scripts\install.ps1 -RegisterAllMcp -InstallPythonSdk

# Or select individual options:
.\scripts\install.ps1 -RegisterCopilotMcp
.\scripts\install.ps1 -RegisterClaudeMcp -ReadOnlyMcp
.\scripts\install.ps1 -RegisterCursorMcp -AllowEvaluate
```

Installed locations on Windows:
- **Host & MCP executable:** `%LOCALAPPDATA%\BrowserBridge\app\BrowserBridge.exe`
- **Unpacked extensions:** `%LOCALAPPDATA%\BrowserBridge\extension\chromium` and `...\firefox`
- **Native manifests:** `%LOCALAPPDATA%\BrowserBridge\manifests\{chromium,firefox}.json` (registered under `HKCU\Software\...\NativeMessagingHosts\io.github.dcluomax.browser_bridge`)
- **Shared-tab agent guide:** `%LOCALAPPDATA%\BrowserBridge\AGENT.md`
- **Learned site playbooks:** `%LOCALAPPDATA%\BrowserBridge\routines\<domain>.json`
- **Native host logs:** `%LOCALAPPDATA%\BrowserBridge\logs\native-host.log`

### macOS & Linux

```bash
# Recommended: build, install, register MCP clients, and install Python SDK
./scripts/install.sh --register-all --install-python

# Or select individual options:
./scripts/install.sh --register-copilot
./scripts/install.sh --register-claude --read-only
./scripts/install.sh --register-cursor --allow-evaluate
```

Installed locations on macOS / Linux:
- **Host & MCP executable:** `~/.browser-bridge/app/BrowserBridge`
- **Unpacked extensions:** `~/.browser-bridge/extension/chromium` and `.../firefox`
- **Native manifests:**
  - **macOS:** `~/Library/Application Support/{Microsoft Edge,Google/Chrome,Chromium,Mozilla}/NativeMessagingHosts/io.github.dcluomax.browser_bridge.json`
  - **Linux:** `~/.config/{microsoft-edge,google-chrome,chromium}/NativeMessagingHosts/...` and `~/.mozilla/native-messaging-hosts/...`
- **Learned site playbooks:** `~/.browser-bridge/routines/<domain>.json`

---

## 3. Loading the Extension in Your Browser

Because the installer copies the built extension into `%LOCALAPPDATA%\BrowserBridge\extension` (or `~/.browser-bridge/extension`), rebuilding or switching git branches in your checkout never corrupts a running browser.

### Microsoft Edge
1. Open `edge://extensions`.
2. Turn on **Developer mode** (left sidebar or top-right toggle).
3. Click **Load unpacked** and choose the `extension/chromium` folder shown by the installer.
4. Confirm the card shows the expected 32-character Extension ID from `extension/bridge.config.json`.

### Google Chrome / Brave / Chromium
1. Open `chrome://extensions` (or `brave://extensions`).
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select `extension/chromium`.

### Mozilla Firefox
1. For development or single-session use: open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on...** → select `extension/firefox/manifest.json`.
2. For permanent installation on Release Firefox (which requires signed XPIs across restarts):
   ```bash
   cd extension
   WEB_EXT_API_KEY="<amo-jwt-issuer>" WEB_EXT_API_SECRET="<amo-jwt-secret>" npm run sign:firefox
   ```
   Install the resulting `.xpi` from `extension/dist/signed/`.

> **Updating later (`v0.7.0` → `v0.10.0`):** Re-run the bootstrapper or `.\scripts\install.ps1` (`./scripts/install.sh`), then click **Reload (`↻`)** once on the extension card in `edge://extensions` / `chrome://extensions` (accepting the Chromium `tabGroups` permission if prompted). Built-in timestamped `routines/*.json` playbooks refresh automatically while preserving all your custom routines and notes — see **[docs/UPGRADE.md](UPGRADE.md)**. User-shared tab grants persist across reloads as long as the tab stays on the same origin.

---

## 4. Daily Workflows

### Workflow A: Sharing an Existing Logged-In Tab
1. Navigate to the target web app (for example, an internal dashboard, pull request, cloud console, or design tool) and sign in normally.
2. Click the **Browser Bridge** toolbar icon:
   - Choose **Share Read-Only** (`AI` green badge) when you only want the agent to inspect DOM outlines, read text, or capture screenshots.
   - Choose **Share Read-Write** (`AI` blue badge) when you want the agent to click, type, fill forms, or run mutating routines.
3. *(Optional)* Right-click selected text or a hyperlink on the page → **Browser Bridge** → **Share & Copy Focused Prompt**. This copies a minimal single-line prompt containing the `tabId`, browser instance ID, URL, `[read-only]`/`[read-write]` mode, your highlighted focus snippet, and the local `AGENT.md` path.

### Workflow B: Letting an Agent Open Its Own Background Tab
When `Read-Write` mode is active, an agent can call `browser_tabs({ "action": "new", "url": "https://...", "name": "docs-lookup" })`:
- Tabs open in the **background** (`active: false`) so your active window never loses focus.
- On Chromium, agent-opened tabs are neatly organized into a collapsed `[Agent]` tab group.
- Passing a `name` reuses an existing named tab across turns instead of spawning duplicates; unnamed idle agent tabs can auto-close after the configured idle timeout.

### Workflow C: Selecting Among Multiple Browsers or Profiles
If you run Edge (`Work` profile), Edge (`Personal` profile), and Firefox simultaneously:
1. Open the Browser Bridge popup → **Settings** → set **Profile Label** (e.g., `Work`, `Personal`, `Staging`).
2. Pass `browser: "Work"` (or `browser: "firefox"`, or a 12-char `instanceId`) to `browser_status` in MCP or `BrowserBridge(browser="Work")` in Python.

---

## 5. CLI Reference

The `BrowserBridge` binary includes built-in diagnostic and automation subcommands:

```bash
# Show native messaging registrations and live connected browser instances
BrowserBridge status
BrowserBridge status --json

# Capture a background viewport, full-page, or element screenshot directly from CLI
BrowserBridge screenshot page.png --full-page
BrowserBridge screenshot chart.png --tab 42 --browser Work --selector "#latency-chart"

# Inspect or reset learned Site Memory routines & performance profiles
BrowserBridge routines
BrowserBridge routines app.diagrams.net
BrowserBridge routines example.com --reset-profile

# Inspect recent URL-redacted session activity (up to 500 entries, zero query/hash tokens)
BrowserBridge activity
BrowserBridge activity --limit 20 --json

# Check or toggle GitHub Copilot MCP read-only mode in ~/.copilot/mcp-config.json
BrowserBridge mcp-mode status
BrowserBridge mcp-mode read-only
BrowserBridge mcp-mode read-write

# Run the MCP server (invoked automatically by MCP clients)
BrowserBridge mcp [--read-only] [--allow-evaluate]

# Run the line-delimited JSON RPC server over stdio for custom language bindings
BrowserBridge rpc

# Remove current-user native messaging registrations
BrowserBridge uninstall
```

---

## 6. Uninstalling

**Windows:**
```powershell
.\scripts\uninstall.ps1 -PurgeData
```

**macOS / Linux:**
```bash
./scripts/uninstall.sh --purge
```

Then remove the unpacked extension from `edge://extensions` / `chrome://extensions` and delete the `"browser-bridge"` entry from your MCP client configuration file if present.
