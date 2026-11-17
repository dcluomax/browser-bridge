# Changelog & Upgrade Notes

All notable changes to **Browser Bridge** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
For step-by-step migration instructions from `v0.7.0`, see **[docs/UPGRADE.md](docs/UPGRADE.md)**.

## [0.10.0] - 2026-11-17

### Upgrade Notes (`v0.7.0` → `v0.10.0`)
- **Zero-Build / 1-Prompt Upgrade**: Re-run the bootstrapper (`irm https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.ps1 | iex` on Windows, or `curl -fsSL https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.sh | bash` on macOS/Linux) — or ask your AI agent to follow `docs/INSTALL.md` — then click **Reload (`↻`)** once on the **Browser Bridge** extension card (`edge://extensions` / `chrome://extensions`).
- **Source Build Upgrade**: Pull `main`, re-run `.\scripts\install.ps1 -RegisterAllMcp -InstallPythonSdk` (Windows) or `./scripts/install.sh --register-all --install-python` (macOS/Linux), and click **Reload (`↻`)** on the extension card.
- **New `tabGroups` Extension Permission (Chromium)**: Enables silent background agent tabs inside a collapsed `[Agent]` tab group (`active: false` by default). Accept the browser permission prompt if shown after reloading.
- **Upgrade-Aware Timestamped Site JSON Merge (`routines/*.json`, `schemaVersion: 2`)**: `BrowserBridge install` automatically seeds and refreshes all 14 built-in site playbooks inside `%LOCALAPPDATA%\BrowserBridge\routines\` (`~/.browser-bridge/routines/`). Whenever a built-in routine's ISO-8601 `verifiedAt` is newer than an older local cache's `updatedAt`, Browser Bridge refreshes its selectors automatically while preserving your custom user routines, learned pitfalls, and domain notes.
- **Automatic Website-Redesign Drift Detection (`[STALE]`)**: If a live website redesign breaks a routine (`>= 2` consecutive selector or timeout failures), Browser Bridge automatically flags that routine `[STALE]` with `staleReason` in `browser_routine_list` and `BrowserBridge routines` so agents inspect a fresh `browser_snapshot` and update it via `browser_routine_save`.

### Timestamped Site Optimization JSONs & Measured Speedups (`routines/*.json`)
- **`google.com.json` (Google Search — ~11–12× faster)**: `domcontentloaded` + `top`-frame fast path + `search(query)`, `read_results()`, `next_results_page()` — end-to-end search and result extraction cut from `15,495 ms` to **`1,292–1,423 ms`**.
- **`docs.google.com__document.json` (Google Docs — 5.4× faster open + 10 ms Canvas snapshot)**: Document open cut from `8,218 ms` to **`1,528 ms`**; `content.ts` natively parses Kix `<canvas>` `DOCS_modelChunk` script payloads so `browser_snapshot` / `browser_get_text` read Canvas document prose in **`10 ms`** (zero network requests, zero `eval`); `read_document` pulls full multi-page text via same-origin `/mobilebasic` in **`~170–267 ms`**; includes `append_text`, `replace_text`, `rename_document`.
- **`docs.google.com__spreadsheets.json` (Google Sheets / Excel — 31× faster cell R/W)**: Snapshot engine automatically labels `#t-name-box` (`"Name box"`) and `#t-formula-bar-input` (`"Formula bar"`); `read_sheet_csv` exports full-sheet CSV via same-origin `/gviz/tq?tqx=out:csv` in **`~201–325 ms`** (eliminating unreadable Canvas grids); `read_cell` / `write_cell` / `select_range` jump deterministically by coordinate in **`259 ms`** vs `8,077 ms` unoptimized (**31× faster**); includes `rename_spreadsheet`.
- **`github.com.json` (GitHub — ~50 ms README/PR extraction)**: `domcontentloaded` + `120 ms` Turbo settle + automatic compaction of 200+ repository header links + `{{url.repo}}` interpolation; `read_main_content` extracts full README/PR/Issue bodies in **`~50 ms`**; includes `search_repo_issues`, `search_github`, `go_to_file`.
- **`chatgpt.com.json` (ChatGPT — 117 ms safe draft + deterministic stream wait)**: Protects composer `<form>` inside `contentinfo` from nav compaction; first-paint ready in **`~690–914 ms`**; `draft_prompt` stages prompts safely in **`117 ms`** without premature send; `ask_and_wait` awaits `stop-button` disappearance deterministically instead of blind sleep loops; includes `read_conversation`, `new_chat`.
- **9 Additional Built-in Site Playbooks**:
  - `diagrams.net.json`: PWA `#fragment` open `30,000 ms` timeout → `4,960 ms`; XML read **`660 ms`**, write **`870 ms`**, shape insert **`1.64 s`**, `add_page`.
  - `amazon.com.json`: Soft-gate bypass + product search cut from `16,043 ms` to **`2,491 ms` (6.4× faster)**.
  - `finance.yahoo.com.json`: Live ticker quote & valuation lookup cut from `8,050 ms+` to **`702 ms` (11.5× faster)**.
  - `youtube.com.json`: Video search + results snapshot in **`2,042 ms`** (`domcontentloaded` + `250 ms` Polymer hydration, avoiding 30s streaming `onload` stalls) + `open_transcript`.
  - `wikipedia.org.json`: `#cite_note` hash compression (~8 KB snapshot savings/article) + 35k-char `#mw-content-text` `read_article` in **`~2,200 ms`**.
  - `news.ycombinator.com.json`: Flattens nested `border=0` layout tables so all 30 front-page stories fit cleanly with zero truncation.
  - `stackoverflow.com.json`: Auto-dismisses `#onetrust-banner-sdk` cookie banner + preserves 1,200-char `<pre><code>` blocks + **`~60 ms`** `#mainbar` Q&A read.
  - `reddit.com.json`: Marks `directHttpBlocked = true` (skipping guaranteed anonymous `403` hits) + pierces `shreddit-*` Shadow DOM & unslotted light-DOM children.
  - `x.com.json`: `domcontentloaded` + `350 ms` SPA hydration + automatic Cloudflare/bot-challenge detection (`suggestHandoff: true`).

### Added Engine Capabilities (`0.8.0`–`0.10.0`)
- **Path-Scoped Playbooks, Aliases & Routine Engine v2**: Supports multi-app domains (`docs.google.com/document` vs `docs.google.com/spreadsheets`), friendly aliases (`google-docs`, `google-sheets`, `google-excel`, `chatgpt`, `drawio`, `hn`), `op: "fetch"` (with `stripHtml`), `{{param:urlencode}}`, and automatic URL variables (`{{url.docId}}`, `{{url.gid}}`, `{{url.repo}}`, `{{url.origin}}`, `{{url.href}}`).
- **Silent Background Tabs, Collapsed `[Agent]` Tab Groups, Named Tabs & Idle GC**: `browser_tabs(action="new")` / `browser.new_page(...)` opens silently in the background (`active: false` default) inside a collapsed Chromium `[Agent]` tab group, reuses persistent named handles (`name="work-doc"`), auto-closes idle agent tabs after 10 minutes (configurable `10m / 30m / 60m / Never`), and shows live `RW` / `RO` / `RUN` / `WAIT` toolbar badges.
- **Interactive Human Handoff & Password-Safe Demonstrate-to-Routine**: `browser_handoff` renders a tamper-resistant closed-ShadowRoot Continue card (`WAIT` badge) for logins, 2FA/MFA, CAPTCHAs, and payments; `browser_demonstrate` (and Popup **Teach Routine**) records user clicks and non-sensitive inputs while strictly ignoring password/OTP fields, saving directly into `Site Memory`.
- **`allowedOrigins` Domain Fence, Bot-Challenge Detection & Redacted Diagnostics**: `browser_allowlist` enforces session- or tab-scoped host/wildcard fences across navigations, redirects, and popups; `allowlist.ts` detects Cloudflare/CAPTCHA/403/429 walls; `browser_network` captures HTTP/XHR/fetch traffic with automatic redaction of `Authorization`, `Cookie`, API keys, passwords, and JWTs; `browser_console` captures page logs and uncaught JS errors from `document_start`.
- **Smart `<main>` Snapshot Budgeting**: Compacts sprawling `<header>`/`<nav>`/`<aside>` link menus on overflow while preserving `<main>` content, composer `<form>` regions, flattened `border=0` layout tables, and 1,200-char `<pre><code>` blocks.

## [0.7.0] - 2026-11-16

### Added
- **Adaptive Error-Driven Site Learning (`SiteLearner` & `SiteAccessProfile`):** Automatically learns per-domain `preferredWaitUntil="domcontentloaded"` from stalled `onload` beacons, SPA `hydrationSettleMs`, overlay blocker recovery triads (`Error -> Recovery -> Retry Success`), CDP fallback preferences, and `directHttpBlocked` (`403` WAF) routing.
- **Executable Site Memory & Multi-Step Routines Engine:** Local domain playbooks (`browser_routine_list`, `browser_routine_run`, `browser_routine_save`) with built-in `app.diagrams.net` XML read/write/shape routines and CLI inspection (`BrowserBridge routines`).
- **Native W3C WebMCP Integration (`browser_webmcp_list` & `browser_webmcp_call`):** Discovers and invokes page-registered `document.modelContext` / `navigator.modelContext` imperative tools and declarative `<form toolname="...">` tools across Edge, Chrome, and Firefox.
- **Three-Layer Read-Only / Read-Write ACLs:** Enforces read-only safety via `BrowserBridge mcp --read-only` (`BROWSER_BRIDGE_READ_ONLY=1`), Popup Global Read-Only Lock, and per-tab `[read-only]` / `[read-write]` mode toggles.
- **Rich Snapshot & Interaction Additions:** Interactive SVG diagram canvas shapes (`role="shape"`), native pointer/HTML5 drag-and-drop (`browser_drag`), chunked file uploads (`browser_upload_file`), JavaScript dialog handling (`browser_handle_dialog`), right-click context menu tab sharing, 1-line `Copy Agent Prompt`, and 4-locale UI (`en`, `zh_CN`, `zh_TW`, `ja`).
- **Standalone Rust Architecture & Direct IPC Python SDK:** ~1.5 MB zero-dependency Rust host/MCP binary communicating over `CurrentUserOnly` Windows Named Pipes and `0700`/`0600` Unix Domain Sockets (`~1.1 ms` median Python SDK RTT, `browser.smart_fetch` adaptive WAF fallback, background full-page/element screenshots).
