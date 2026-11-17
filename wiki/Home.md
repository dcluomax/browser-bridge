<p align="center">
  <img src="https://raw.githubusercontent.com/dcluomax/browser-bridge/main/docs/assets/hero-banner.svg" alt="Browser Bridge — Local MCP Server, Browser Extension, and Python SDK" width="100%" />
</p>

Welcome to the official **Browser Bridge Wiki**!

**Browser Bridge** connects local AI coding agents (GitHub Copilot, Claude Desktop / Claude Code, Cursor, Windsurf, Cline, and any MCP client) and local Python scripts directly to **your own signed-in Microsoft Edge, Google Chrome, Brave, or Mozilla Firefox tabs** — with zero open TCP ports, explicit per-tab user consent, and automatic per-domain performance learning.

---

## Quick Navigation

| Section | Pages |
| --- | --- |
| **Start Here** | [[Getting Started]] · [[Browser Extension Guide]] · [[MCP Client Setup]] |
| **Tools, Routines & SDK** | [[MCP Tools Reference]] · [[Site Memory and WebMCP]] · [[Python SDK and Local IPC]] |
| **Architecture & Security** | [[Architecture Deep Dive]] · [[Security and Privacy Model]] |
| **Operations & Development** | [[CLI and Troubleshooting]] · [[Contributing and Development]] |

---

## System Overview

<p align="center">
  <img src="https://raw.githubusercontent.com/dcluomax/browser-bridge/main/docs/assets/architecture.svg" alt="Browser Bridge system architecture and security isolation" width="100%" />
</p>

### Core Design Pillars

1. **Use Your Real Browser & SSO:** No headless browser downloads, no profile cloning, and no cookie export. Sign in once in your normal browser and share only the specific tab you want an agent to read or assist with.
2. **Zero Network Exposure:** Communication uses OS-enforced `CurrentUserOnly` Windows Named Pipes (`\\.\pipe\browser-bridge.<SID>.*`) and `0700`/`0600` Unix Domain Sockets — never localhost HTTP or WebSocket ports.
3. **Three-Layer Read/Write Safety:** Enforce read-only inspection via `BrowserBridge mcp --read-only`, the popup Global Read-Only Lock, or per-tab `Read-Only` / `Read-Write` grants.
4. **Adaptive Site Memory & WebMCP:** `SiteLearner` turns first-visit timeouts, SPA hydration races, overlay blockers, and `403` WAF blocks into sub-second domain playbooks, alongside reusable multi-step routines and W3C `document.modelContext` WebMCP tool invocation.
