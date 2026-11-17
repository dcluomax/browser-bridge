# Getting Started

<p align="center">
  <img src="https://raw.githubusercontent.com/dcluomax/browser-bridge/main/docs/assets/onboarding-flow.svg" alt="Browser Bridge One-Prompt Onboarding Flow" width="100%" />
</p>

Go from zero to reading and automating a live signed-in browser tab in seconds — with **zero Rust or Node.js build tools required**.

---

## Step 1: Install in One AI Prompt (Recommended)

Paste this single prompt into **GitHub Copilot** (VS Code or CLI), **Claude Code**, **Cursor**, **Windsurf**, **Cline**, or **Codex**:

```text
Install and configure Browser Bridge by following https://raw.githubusercontent.com/dcluomax/browser-bridge/main/docs/INSTALL.md — download and SHA-256-verify the prebuilt release for my OS/CPU, register the native host and my AI client MCP config, verify with `BrowserBridge status`, and print the exact extension folder path to load in my browser.
```

### Alternative: One-Line Terminal Bootstrap (Zero Build Tools)

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.sh | bash
```

### Alternative: Build from Source (Rust 1.85+ & Node.js 20+)

```powershell
# Windows
git clone https://github.com/dcluomax/browser-bridge.git
cd browser-bridge
.\scripts\install.ps1 -RegisterAllMcp -InstallPythonSdk
```

```bash
# macOS / Linux
git clone https://github.com/dcluomax/browser-bridge.git
cd browser-bridge
./scripts/install.sh --register-all --install-python
```

---

## Step 2: Load the Extension Once

| Browser | Instructions |
| --- | --- |
| **Microsoft Edge** | Visit `edge://extensions` → Turn on **Developer mode** → Click **Load unpacked** → Select `%LOCALAPPDATA%\BrowserBridge\extension\chromium` (or `~/.browser-bridge/extension/chromium`) |
| **Google Chrome / Brave** | Visit `chrome://extensions` → Turn on **Developer mode** → Click **Load unpacked** → Select the `chromium` folder above |
| **Mozilla Firefox** | Visit `about:debugging#/runtime/this-firefox` → Click **Load Temporary Add-on...** → Select `extension/firefox/manifest.json` |

Verify the connection:

```bash
# Windows
"%LOCALAPPDATA%\BrowserBridge\app\BrowserBridge.exe" status

# macOS / Linux
~/.browser-bridge/app/BrowserBridge status
```

You should see your running browser listed under `Connected browsers:` and a **green status dot** on the Browser Bridge toolbar icon.

---

## Step 3: Share One Tab

1. Open any tab you want your AI assistant to inspect or interact with.
2. Click the **Browser Bridge** toolbar button (or right-click anywhere on the page → **Browser Bridge**).
3. Choose **Read-Only** (inspection & screenshots only) or **Read-Write** (clicks, forms & navigation).

All other tabs in your browser remain invisible to AI sessions.

---

## Step 4: Prompt Your AI Agent or Python Script

Click **Copy Prompt** in the popup to copy a ready-to-paste handle, or simply ask your MCP client:

> *"Check my shared browser tab with `browser_snapshot` and summarize the page."*

Next: explore [[Browser Extension Guide]], [[MCP Client Setup]], and [[MCP Tools Reference]].
