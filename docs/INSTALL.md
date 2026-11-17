# Browser Bridge — AI Agent One-Prompt Installation Guide

> **For AI Coding Agents (GitHub Copilot, Claude Code, Cursor, Windsurf, Cline, Codex):**
> Follow the steps below to install Browser Bridge on the user's machine in seconds using official SHA-256-verified prebuilt GitHub Release binaries. **Do not compile Rust or Node.js from source** unless Step 1 reports that no prebuilt binary matches the current OS/architecture.

---

## Step 1: Run the Prebuilt Zero-Toolchain Bootstrapper

Detect the user's operating system and run the corresponding single command. The bootstrapper downloads the latest GitHub Release (`BrowserBridge` native binary + unpacked Chromium & Firefox extensions), verifies GitHub's `sha256:` asset digests, registers per-user browser Native Messaging manifests, and merges `"browser-bridge"` into detected MCP client configuration files without overwriting existing MCP servers.

### Windows (PowerShell — x64 & ARM64)

```powershell
$script = Join-Path $env:TEMP "bb-bootstrap-$PID.ps1"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.ps1" -OutFile $script -UseBasicParsing
try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script
} finally {
    Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue
}
```

- If the user asked for **read-only mode**, append `-ReadOnlyMcp`.
- If the user also wants the **Python SDK**, append `-InstallPythonSdk`.

### macOS (Apple Silicon & Intel) and Linux (x64)

```bash
curl -fsSL https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.sh | bash
```

- For options, pass `| bash -s -- --read-only` and/or `--install-python`.

### Fallback Only (Unsupported OS/CPU such as `linux-arm64`)

Only if `bootstrap` reports an unsupported OS/CPU, clone and build from source (requires Rust `1.85+` and Node.js `20+`):

```bash
git clone --depth 1 https://github.com/dcluomax/browser-bridge.git ~/.browser-bridge-src
~/.browser-bridge-src/scripts/install.sh --register-all
```

---

## Step 2: Verify Native Host Registration

Run `status` on the installed binary and confirm that `edge`, `chrome`, `chromium`, and `firefox` native messaging manifests are registered (`exists: true`):

- **Windows:**
  ```powershell
  & "$env:LOCALAPPDATA\BrowserBridge\app\BrowserBridge.exe" status
  ```
- **macOS / Linux:**
  ```bash
  ~/.browser-bridge/app/BrowserBridge status
  ```

> Note: `Connected browsers: none` is completely normal until the user loads the unpacked extension in Step 4!

---

## Step 3: Confirm Your Current AI Client Has the MCP Entry

`bootstrap` automatically configures GitHub Copilot CLI (`~/.copilot/mcp-config.json`), VS Code (`User/mcp.json`), Claude Desktop, Claude Code (`~/.claude.json`), Cursor (`~/.cursor/mcp.json`), and Windsurf when their config directories exist.

If you are running inside a client with a custom or workspace-scoped MCP file (or Claude Code CLI where `claude mcp add` is preferred), verify or add the entry using the exact binary path `<EXE>` (`%LOCALAPPDATA%\BrowserBridge\app\BrowserBridge.exe` on Windows, `~/.browser-bridge/app/BrowserBridge` on macOS/Linux):

- **VS Code (`mcp.json`):**
  ```json
  {
    "servers": {
      "browser-bridge": { "type": "stdio", "command": "<EXE>", "args": ["mcp"] }
    }
  }
  ```
- **GitHub Copilot CLI (`~/.copilot/mcp-config.json`):**
  ```json
  {
    "mcpServers": {
      "browser-bridge": { "type": "local", "command": "<EXE>", "args": ["mcp"], "tools": ["*"] }
    }
  }
  ```
- **Claude Code CLI:**
  ```bash
  claude mcp add browser-bridge -- "<EXE>" mcp
  ```
- **Cursor / Claude Desktop / Windsurf / Cline (`mcpServers`):**
  ```json
  {
    "mcpServers": {
      "browser-bridge": { "command": "<EXE>", "args": ["mcp"] }
    }
  }
  ```

---

## Step 4: Present the Single Final Browser Action to the User

Modern browsers forbid external programs from silently side-loading unpacked extensions without user confirmation. Give the user this exact, concise checklist with their resolved path:

1. **Load the extension once in your browser:**
   - **Edge:** Open `edge://extensions` → Turn on **Developer mode** → Click **Load unpacked** → Select:
     - Windows: `%LOCALAPPDATA%\BrowserBridge\extension\chromium` (print the expanded `C:\Users\<user>\AppData\Local\BrowserBridge\extension\chromium` path!)
     - macOS / Linux: `~/.browser-bridge/extension/chromium` (print the expanded `/Users/...` or `/home/...` path!)
   - **Chrome / Brave:** Open `chrome://extensions` → Turn on **Developer mode** → Click **Load unpacked** → Select the same `chromium` folder.
   - **Firefox:** Open `about:debugging#/runtime/this-firefox` → Click **Load Temporary Add-on...** → Select `<extension_dir>/firefox/manifest.json`.
2. **Confirm the green dot:** Pin the **Browser Bridge** icon on the browser toolbar — a green dot confirms it connected to the native host.
3. **Share a tab & go:** Click the Browser Bridge icon on any tab → **Share Read-Only** or **Share Read-Write** (and reload/restart MCP servers in your IDE if `browser-bridge` tools were just added).
