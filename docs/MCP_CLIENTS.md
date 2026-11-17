# MCP Client Configuration Guide

Browser Bridge speaks standard Model Context Protocol (`stdio`, JSON-RPC 2.0, protocol `2025-06-18` backward-compatible). Below are turnkey configurations for every popular AI client.

---

## Binary Path by Operating System

| OS | Default Installed Binary Path |
| --- | --- |
| **Windows** | `C:\Users\<YOU>\AppData\Local\BrowserBridge\app\BrowserBridge.exe` |
| **macOS** | `/Users/<YOU>/.browser-bridge/app/BrowserBridge` |
| **Linux** | `/home/<YOU>/.browser-bridge/app/BrowserBridge` |

> Tip: Running `.\scripts\install.ps1 -RegisterAllMcp` (Windows) or `./scripts/install.sh --register-all` (macOS/Linux) writes the exact absolute path for your user account automatically.

---

## 1. GitHub Copilot CLI (`~/.copilot/mcp-config.json`)

Automatic registration:
```powershell
# Windows
.\scripts\install.ps1 -RegisterCopilotMcp

# macOS / Linux
./scripts/install.sh --register-copilot
```

Manual JSON (`~/.copilot/mcp-config.json`):
```json
{
  "mcpServers": {
    "browser-bridge": {
      "type": "local",
      "command": "C:\\Users\\alice\\AppData\\Local\\BrowserBridge\\app\\BrowserBridge.exe",
      "args": ["mcp"],
      "tools": ["*"]
    }
  }
}
```

---

## 2. VS Code (GitHub Copilot Agent Mode — `.vscode/mcp.json` or User `mcp.json`)

Open Command Palette → **MCP: Open User Configuration** and add:

```json
{
  "servers": {
    "browser-bridge": {
      "type": "stdio",
      "command": "C:\\Users\\alice\\AppData\\Local\\BrowserBridge\\app\\BrowserBridge.exe",
      "args": ["mcp"]
    }
  }
}
```

On macOS / Linux, set `"command": "/Users/alice/.browser-bridge/app/BrowserBridge"` (or `/home/alice/...`).

---

## 3. Claude Desktop (`claude_desktop_config.json`)

Automatic registration:
```powershell
# Windows (%APPDATA%\Claude\claude_desktop_config.json)
.\scripts\install.ps1 -RegisterClaudeMcp

# macOS (~/Library/Application Support/Claude/claude_desktop_config.json)
./scripts/install.sh --register-claude
```

Manual JSON:
```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "/Users/alice/.browser-bridge/app/BrowserBridge",
      "args": ["mcp"]
    }
  }
}
```

---

## 4. Claude Code CLI

```bash
# macOS / Linux
claude mcp add browser-bridge -- ~/.browser-bridge/app/BrowserBridge mcp

# Windows (PowerShell)
claude mcp add browser-bridge -- "$env:LOCALAPPDATA\BrowserBridge\app\BrowserBridge.exe" mcp
```

---

## 5. Cursor (`~/.cursor/mcp.json`)

Automatic registration:
```powershell
.\scripts\install.ps1 -RegisterCursorMcp
# or on macOS / Linux:
./scripts/install.sh --register-cursor
```

Manual JSON (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "/Users/alice/.browser-bridge/app/BrowserBridge",
      "args": ["mcp"]
    }
  }
}
```

---

## 6. Windsurf / Cline / Zed / Custom MCP Hosts

Configure a `stdio` MCP server pointing to the `BrowserBridge` executable with argument `["mcp"]`.

### Optional Server Flags & Environment Variables

| Flag / Variable | Default | Effect |
| --- | --- | --- |
| `--read-only` or `BROWSER_BRIDGE_READ_ONLY=1` | Off | Exposes **only** read-safe inspection & screenshot tools; strips and rejects all mutating actions at the MCP server layer |
| `--allow-evaluate` | Off | Exposes `browser_evaluate` in `tools/list` (still requires the user to enable **Allow agents to run page scripts** in the browser popup) |
| `BROWSER_BRIDGE_ROUTINES_DIR` | `<data_dir>/routines` | Overrides where learned Site Memory playbooks (`<domain>.json`) are read and stored |
