# MCP Client Setup

Browser Bridge implements standard Model Context Protocol over `stdio` (`JSON-RPC 2.0`). You can connect multiple MCP clients concurrently — Browser Bridge's exclusive tab lease prevents two sessions from colliding on the same tab.

---

## Installed Executable Paths

- **Windows:** `%LOCALAPPDATA%\BrowserBridge\app\BrowserBridge.exe` (e.g. `C:\Users\alice\AppData\Local\BrowserBridge\app\BrowserBridge.exe`)
- **macOS:** `/Users/<you>/.browser-bridge/app/BrowserBridge`
- **Linux:** `/home/<you>/.browser-bridge/app/BrowserBridge`

---

## Turnkey Auto-Registration

```powershell
# Windows: register Copilot, Claude Desktop, and Cursor in one command
.\scripts\install.ps1 -RegisterAllMcp

# macOS / Linux
./scripts/install.sh --register-all
```

---

## Manual Configuration Snippets

### GitHub Copilot CLI (`~/.copilot/mcp-config.json`)

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

### VS Code GitHub Copilot (`mcp.json`)

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

### Claude Desktop (`claude_desktop_config.json`)

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

### Claude Code CLI

```bash
claude mcp add browser-bridge -- ~/.browser-bridge/app/BrowserBridge mcp
```

### Cursor (`~/.cursor/mcp.json`)

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

## Hardening Flags

- **Enforce Read-Only MCP (`--read-only`):**
  ```json
  "args": ["mcp", "--read-only"]
  ```
  Removes all mutating tools from `tools/list` and blocks any write RPC call. You can also toggle `~/.copilot/mcp-config.json` anytime via `BrowserBridge mcp-mode read-only` / `read-write`.
- **Enable Dual-Gated Script Evaluation (`--allow-evaluate`):**
  ```json
  "args": ["mcp", "--allow-evaluate"]
  ```
  Exposes `browser_evaluate` (still requires turning on **Allow agents to run page scripts** in the browser popup).
