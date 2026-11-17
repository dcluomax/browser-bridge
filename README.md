<div align="center">

<img src="docs/assets/hero-banner.svg" alt="Browser Bridge — Local MCP Server, Browser Extension, and Python SDK for Your Signed-In Tabs" width="100%" />

<br />

[![CI](https://github.com/dcluomax/browser-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/dcluomax/browser-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-2563eb.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-1.85%2B-0f172a?logo=rust)](rust/Cargo.toml)
[![Python](https://img.shields.io/badge/Python-3.10%2B%20(0%20deps)-0f172a?logo=python)](python/README.md)
[![Browsers](https://img.shields.io/badge/Browsers-Edge%20%7C%20Chrome%20%7C%20Brave%20%7C%20Firefox-059669)](#browser-setup)
[![MCP](https://img.shields.io/badge/MCP-2025--06--18-6366f1)](docs/MCP_CLIENTS.md)

**English** · **[简体中文](README.zh-CN.md)** · **[Usage Guide](docs/USAGE.md)** · **[Feature Deep Dive](docs/FEATURES.md)** · **[MCP Client Setup](docs/MCP_CLIENTS.md)** · **[Python SDK](python/README.md)** · **[Wiki](https://github.com/dcluomax/browser-bridge/wiki)**

</div>

---

**Browser Bridge** lets local AI coding agents (GitHub Copilot, Claude Desktop / Claude Code, Cursor, Windsurf, Cline, or any MCP client) and local Python scripts safely inspect and act inside **your own live Edge, Chrome, Brave, or Firefox tabs** — using the accounts, SSO sessions, cookies, and browser extensions you already have open.

Unlike headless browser drivers (Playwright, Selenium, Puppeteer) or containerized cloud browsers, Browser Bridge **never launches an isolated profile, never exports cookies, and opens zero TCP or WebSocket ports**. Every tab stays private until you explicitly share it.

---

## Why Browser Bridge?

| Capability | Headless Drivers (Playwright / CDP Port) | Browser Bridge |
| --- | --- | --- |
| **Signed-in SSO & corporate sessions** | Loses session or requires fragile profile cloning | Works directly in your live signed-in browser |
| **Network attack surface** | Localhost debugging port reachable by local processes/pages | **0 TCP ports** — OS user-isolated Named Pipes / `0600` Unix sockets |
| **Tab privacy boundary** | Exposes the entire browser context | **Opt-in per tab** (`[read-only]` or `[read-write]` + exclusive lease) |
| **Repeat-visit speed on complex sites** | Static timeouts & repeated failures | **Adaptive `SiteLearner`** + reusable multi-step **Site Memory Routines** |
| **Native W3C WebMCP support** | None | Discovers & invokes `document.modelContext` and declarative `<form toolname>` tools |
| **Host footprint** | Hundreds of MBs of browser binaries + Node/Python drivers | **~1.5 MB standalone Rust binary** + **0-dependency Python SDK** |

---

## 60-Second Quickstart (Out of the Box)

<p align="center">
  <img src="docs/assets/onboarding-flow.svg" alt="Four-step onboarding flow: run installer, load unpacked extension once, share a tab, and prompt your AI agent" width="100%" />
</p>

### Option A: Zero-Build Install from Prebuilt GitHub Releases

Download the precompiled binary for your platform (`windows-x64`, `windows-arm64`, `macos-arm64`, `linux-x64`) plus `browser-bridge-chromium-0.7.0.zip` or `browser-bridge-firefox-0.7.0.xpi` from **[GitHub Releases](https://github.com/dcluomax/browser-bridge/releases/latest)** — no Rust or Node.js toolchain needed:

```bash
# Register the native host manifest once (replace <CHROMIUM_EXT_ID> from extension/bridge.config.json: ggkciaoahjoickdapninkfaceeadombm)
BrowserBridge install --chromium-id ggkciaoahjoickdapninkfaceeadombm
```

### Option B: Build, Install & Register MCP from Source in One Command

Prerequisites: **Rust** `1.85+` (`rustup`), **Node.js** `20+` (`npm`), and *(optional)* **Python** `3.10+`.

**Windows (PowerShell):**

```powershell
git clone https://github.com/dcluomax/browser-bridge.git
cd browser-bridge
.\scripts\install.ps1 -RegisterAllMcp -InstallPythonSdk
```

**macOS / Linux:**

```bash
git clone https://github.com/dcluomax/browser-bridge.git
cd browser-bridge
./scripts/install.sh --register-all --install-python
```

> Prefer registering a single MCP client? Pass `-RegisterCopilotMcp`, `-RegisterClaudeMcp`, or `-RegisterCursorMcp` (or `--register-copilot`, `--register-claude`, `--register-cursor` on macOS/Linux). Add `-ReadOnlyMcp` / `--read-only` to enforce hardware-level read-only inspection.

### 2. Load the Browser Extension (Once per Profile)

The installer copies built extensions to a **stable per-user directory** so rebuilding or pulling repository updates never breaks your browser:

| Browser | Navigation | Folder / Manifest to Select |
| --- | --- | --- |
| **Microsoft Edge** | `edge://extensions` → Enable **Developer mode** → **Load unpacked** | Windows: `%LOCALAPPDATA%\BrowserBridge\extension\chromium`<br>macOS/Linux: `~/.browser-bridge/extension/chromium` |
| **Google Chrome / Brave** | `chrome://extensions` → Enable **Developer mode** → **Load unpacked** | Windows: `%LOCALAPPDATA%\BrowserBridge\extension\chromium`<br>macOS/Linux: `~/.browser-bridge/extension/chromium` |
| **Mozilla Firefox** | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** | Windows: `%LOCALAPPDATA%\BrowserBridge\extension\firefox\manifest.json`<br>macOS/Linux: `~/.browser-bridge/extension/firefox/manifest.json` |

Verify that the native host is registered and connected:

```bash
# Windows
"%LOCALAPPDATA%\BrowserBridge\app\BrowserBridge.exe" status

# macOS / Linux
~/.browser-bridge/app/BrowserBridge status
```

When connected, the Browser Bridge toolbar icon displays a **green status dot**.

### 3. Share a Tab & Prompt Your Agent

1. Open any web page in your browser and click the **Browser Bridge** toolbar icon (or **right-click** anywhere on the page → **Browser Bridge**).
2. Share the tab in **`Read-Only`** (safe inspection & screenshots only) or **`Read-Write`** (full interaction) mode.
3. Click **Copy Prompt** to paste a single-line tab handle into any AI agent, or simply ask your MCP-connected assistant:
   > *"Inspect my shared browser tab, summarize the failing CI logs, and tell me the root cause."*

---

## Architecture & Security Boundary

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Browser Bridge system architecture showing MCP clients and Python SDK connecting over OS user-isolated IPC to the Rust native host and browser extension" width="100%" />
</p>

1. **Cross-Browser Extension (`extension/`)** — TypeScript + React 19 + Astryx UI bundled for Chromium (Manifest V3 service worker) and Firefox (Manifest V2 persistent background page). Enforces per-tab grants, origin-verified reload persistence, exclusive session leases, password/token redaction, and background screenshot capture.
2. **Standalone Rust Host & MCP Server (`rust/`)** — A single ~1.5 MB native binary (`BrowserBridge`) with zero runtime dependencies:
   - Launched automatically by Edge, Chrome, Chromium, or Firefox via browser Native Messaging (`io.github.dcluomax.browser_bridge`).
   - Exposes each browser profile on a **current-user-only Windows Named Pipe** (`\\.\pipe\browser-bridge.<SID>.<browser>.<instance>`) or **`0700`/`0600` Unix Domain Socket**.
   - Runs as an MCP server (`BrowserBridge mcp`), JSON-line stdio RPC bridge (`BrowserBridge rpc`), or direct CLI (`status`, `screenshot`, `routines`, `mcp-mode`).
3. **Zero-Dependency Python SDK (`python/`)** — Pure Python (`>=3.10`) speaking directly over the Named Pipe / Unix Socket (`~1.1 ms` median round-trip, zero intermediate subprocesses), offering Playwright-style chained locators, `page.request` (in-tab authenticated fetch), `browser.request` (anonymous host HTTP), and `browser.smart_fetch` (adaptive WAF fallback).

---

## Toolbar Popup & 3-Layer Permission Controls

<p align="center">
  <img src="docs/assets/popup-showcase.svg" alt="Browser Bridge toolbar popup showing Read-Only and Read-Write tab sharing, Copy Prompt action, shared tab inventory, and profile security settings" width="100%" />
</p>

Browser Bridge enforces **three independent safety layers** before any mutation can touch a tab:

1. **MCP Server Flag (`--read-only` / `BROWSER_BRIDGE_READ_ONLY=1`)** — Strips mutating tools from `tools/list` and blocks mutating RPC calls at the host boundary.
2. **Popup Global Read-Only Lock** — Instant per-profile kill switch in the toolbar popup that freezes all clicks, typing, navigation, and tab creation across every connected agent.
3. **Per-Tab Access Mode (`[read-only]` vs `[read-write]`)** — Share sensitive dashboards (Grafana, Azure/AWS consoles, production logs) as `Read-Only` while granting `Read-Write` only to local dev apps or sandboxes. Promote or downgrade anytime with one click.

Additional popup capabilities:
- **Trusted Input (`chrome.debugger`)** — Enabled by default on Chromium so clicks, drags, and shortcuts carry genuine user activation; automatically falls back to DOM events on Firefox or when detached.
- **Background `[Agent]` Tab Grouping** — Agent-opened tabs open in the background (`active: false`) inside a collapsed `[Agent]` group without stealing window focus.
- **Multi-Language UI** — Built-in English (`en`), Simplified Chinese (`zh_CN`), Traditional Chinese (`zh_TW`), and Japanese (`ja`) with dark/light theme toggle.

---

## Adaptive Site Memory, Fast Routines & WebMCP

<p align="center">
  <img src="docs/assets/site-memory-flow.svg" alt="Diagram showing Adaptive Error-Driven Site Learning turning first-visit timeouts, overlays, and 403 WAF errors into sub-second domain playbooks and routines" width="100%" />
</p>

Real-world web apps stall `window.onload` with analytics beacons, re-render during SPA hydration, cover buttons with cookie banners, or block plain HTTP with `403` WAF rules. Browser Bridge learns per-domain adaptations automatically:

- **Error-Driven `SiteLearner`** — Observes `load` timeouts → switches future visits to `domcontentloaded`; detects hydration `stale_ref` races → applies tuned `hydrationSettleMs`; records `Error -> Recovery Action -> Retry Success` triads for overlay blockers; remembers `403` WAF endpoints so `smart_fetch` routes through the authenticated browser tab.
- **Executable Site Memory Routines** — Parameterized multi-step workflows stored locally in `routines/<domain>.json` (includes built-in `app.diagrams.net` routines such as `read_diagram_xml`, `write_diagram_xml`, and `insert_shape`). Agents inspect routines via `browser_routine_list`, execute in 1 call via `browser_routine_run`, and save newly discovered workflows via `browser_routine_save`.
- **Native W3C WebMCP (`document.modelContext`)** — Automatically discovers imperative tools registered via `document.modelContext.registerTool(...)` / `navigator.modelContext.registerTool(...)` and declarative `<form toolname="...">` actions across Edge, Chrome, and Firefox (`browser_webmcp_list` / `browser_webmcp_call`).

---

## MCP Tool Catalog (26 Tools + Resources + Prompts)

| Category | Tools | Description |
| --- | --- | --- |
| **Discovery & Tabs** | `browser_status`, `browser_tabs` | Inspect connected browsers/profiles (`browser="edge"` or `browser="Work"`); `list`, `new`, `select`, `close` tabs |
| **Navigation** | `browser_navigate`, `browser_history` | Navigate with learned wait strategies (`domcontentloaded`, `load`, `commit`); `back`, `forward`, `reload` |
| **Page Reading** | `browser_snapshot`, `browser_get_text`, `browser_locate`, `browser_get_element` | Accessibility outline with stable refs (`e12`, cross-origin iframe `f3e7`, SVG `role="shape"`), Shadow DOM traversal, structured locators, masked passwords |
| **User Actions** | `browser_click`, `browser_hover`, `browser_drag`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_set_checked`, `browser_press_key`, `browser_scroll` | Ref- or locator-targeted interactions with covered-element guards, modifier keys, HTML5/pointer drag-and-drop, and verified checkbox toggling |
| **Files, Dialogs & Waits** | `browser_upload_file`, `browser_handle_dialog`, `browser_wait_for`, `browser_screenshot` | Chunked file input uploads, `alert`/`confirm`/`prompt` handling, observable state waits, background viewport/full-page/element PNG & JPEG screenshots |
| **Site Memory & WebMCP** | `browser_routine_list`, `browser_routine_run`, `browser_routine_save`, `browser_webmcp_list`, `browser_webmcp_call` | Per-domain learned performance profiles, pitfall logs, 1-call multi-step routines, and W3C WebMCP page tool discovery/invocation |
| **Optional Script Eval** | `browser_evaluate` | Disabled by default; requires **both** `BrowserBridge mcp --allow-evaluate` **and** the popup toggle |

MCP **Resources** (`bridge://guide`, `bridge://status`, `bridge://tabs`, `bridge://routines`) and **Prompts** (`inspect-shared-tab`, `act-in-shared-tab`) are also exposed out of the box.

---

## Local Python SDK (Zero Dependencies)

Control your live browser from standard Python without Playwright, WebDriver binaries, or browser restarts:

```python
from browser_bridge import BrowserBridge

with BrowserBridge() as browser:
    # Open an agent-owned background tab (auto-closed on context exit; never closes your browser)
    page = browser.new_page("https://example.com")
    print(page.title(), page.locator("h1").first.inner_text())

    # Attach to a tab you shared from the toolbar popup (released, never closed, on exit)
    # shared = browser.page(42)

    # Adaptive fetch: fast host HTTP first, transparent in-tab session fallback on 403 WAF
    api_resp = browser.smart_fetch("https://example.com/", page=page)
    print("Status:", api_resp.status)

    page.screenshot("example-full.png", full_page=True)
```

Read the complete **[Python SDK & Direct IPC Reference](python/README.md)** and **[JSON-Line Wire Protocol Spec](docs/IPC_PROTOCOL.md)**.

---

## Documentation & Repository Map

| Document | Contents |
| --- | --- |
| **[docs/USAGE.md](docs/USAGE.md)** | Complete installation, onboarding, popup controls, CLI subcommands, and daily workflows |
| **[docs/FEATURES.md](docs/FEATURES.md)** | Deep dive into all 26 MCP tools, `SiteLearner`, Site Memory routines, WebMCP, and SVG/iframe snapshots |
| **[docs/MCP_CLIENTS.md](docs/MCP_CLIENTS.md)** | Copy-paste setup for GitHub Copilot, VS Code, Claude Desktop, Claude Code, Cursor, Windsurf, and Cline |
| **[docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md)** | Zero-port IPC isolation, 3-layer ACLs, credential redaction, and human handoff invariants |
| **[docs/IPC_PROTOCOL.md](docs/IPC_PROTOCOL.md)** | Direct Named Pipe / Unix Socket & `BrowserBridge rpc` JSON-line protocol for non-Python languages |
| **[python/README.md](python/README.md)** | Full Python SDK guide (locators, waits, `page.request` vs `browser.request`, error codes) |
| **[wiki/](wiki/Home.md)** | Multi-page GitHub Wiki source mirrored automatically to the repository Wiki |

```text
browser-bridge/
├── extension/          # Cross-browser TypeScript + React 19 + Astryx extension (Chromium MV3 & Firefox MV2)
├── rust/
│   └── crates/
│       ├── bridge-core/     # Named Pipe / Unix Socket IPC, Native Messaging, HTTP, SiteLearner & Routines
│       └── browser-bridge/  # Standalone Native Host, MCP server, RPC server, installer & CLI
├── python/             # Zero-dependency Python 3.10+ SDK (`browser_bridge`)
├── e2e/                # Real-browser MCP + Python SDK end-to-end test harness & HTML fixtures
├── scripts/            # Turnkey cross-platform install, uninstall & sanitization check scripts
├── docs/               # Illustrated guides, architecture specs & vector SVG diagrams
└── wiki/               # Full GitHub Wiki project pages
```

---

## Development & Verification

```bash
# Run sanitization audit + TypeScript check + Extension unit tests + Rust workspace tests
npm test

# Run zero-dependency Python SDK unit tests
python -m unittest discover -s python/tests -v

# Build extension bundles (dist/chromium, dist/firefox) + Rust release binary
npm run build

# Package distributable extension archives (.zip and .xpi)
npm run package:extension

# Run full real-browser E2E suite (36 MCP checks + Python integration suite)
npm run e2e:edge      # or: npm run e2e:chrome / npm run e2e:firefox
```

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for development setup, coding conventions, and pull request guidelines, and **[SECURITY.md](SECURITY.md)** for vulnerability reporting.

---

## License

Released under the **[MIT License](LICENSE)** · Copyright © [dcluomax](https://github.com/dcluomax).
