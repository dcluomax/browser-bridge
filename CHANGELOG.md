# Changelog & Upgrade Notes

All notable changes to **Browser Bridge** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See **[`docs/VERSIONING.md`](docs/VERSIONING.md)** for the formal SemVer & Site-Optimization Update Specification:
- **3rd digit (`PATCH`, `x.y.Z`)**: Website optimization JSON additions/refreshes (`routines/*.json`), selector drift updates, and non-breaking latency/bug fixes.
- **2nd digit (`MINOR`, `x.Y.0`)**: New core engine capabilities, new MCP tools/permissions, or new SDK APIs.
- **1st digit (`MAJOR`, `X.0.0`)**: Breaking wire-protocol, MCP schema, or SDK changes.

For step-by-step migration instructions, see **[`docs/UPGRADE.md`](docs/UPGRADE.md)**.

## [0.11.1] - 2026-11-20

### Upgrade Notes (`0.11.0` → `0.11.1`)
- **Patch Version Upgrade (`0.11.1` — `SiteLearner` v2 Security & Readiness Hardening, Zero-Downtime Hot-Swap Install, Ultra-Compact Share Prompt & Redacted Activity Ring Log)**: Re-run the prebuilt bootstrapper (`irm https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.ps1 | iex` or `curl -fsSL https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.sh | bash`) or source installer (`.\scripts\install.ps1` / `./scripts/install.sh`), reinstall the Python SDK if used (`pip install ./python`), and click **Reload (`↻`)** once on the **Browser Bridge** extension card (`edge://extensions` / `chrome://extensions`).

### Added & Hardened in `0.11.1`
1. **`SiteLearner` v2 & `waitForDomQuiet` Safety and Concurrency Hardening**:
   - **Read-Safe Relocation Guard & Template Preservation**: Restricts automatic heuristic locator relocation strictly to idempotent read-only steps (`is_read_safe_step`), never fuzzy-clicking mutating buttons or `not_actionable` covered elements, and preserves `{{param}}` template placeholders on disk.
   - **Atomic Cross-Process Playbook Persistence**: Uses atomic temp-file rename (`write_string_atomic`) and timestamp-aware routine merging (`save_playbook_preserving_newer_disk_routines`) so Native Host flushes never overwrite newer MCP/RPC routine repairs or `[STALE]` states.
   - **Accurate Landmark Readiness & Safe Fallback**: `ARM_SAFE_LOAD_ALL` strips `readinessSelector` so safe fallback waits for genuine `load` + DOM quietness; `elementLandmarkReady` ignores inline `<script>`/`<style>` RSC payloads and empty layout shells, plus isolates `maxChars`-truncated snapshots (`truncated: true`) from false quality violations.
   - **Forward-Compatible Content Injection & NTFS Zero-Downtime Hot-Swap**: `invokeContent` uses semantic `isOlder(bb.version, expectedVersion)` checks to prevent `[script_error]` loops during upgrades, and `scripts/install.ps1` hot-swaps `BrowserBridge.exe` on Windows NTFS without disconnecting active browser pipes.
2. **Ultra-Compact Query-Safe Share Prompt**:
   - New single-line prompt `[Browser Bridge #<tabId> RO|RW <browser>[:<label>]] <Title> (<host>)` (~89% shorter on long SSO/SharePoint URLs) strips `?query` tracking blobs, `#hash` tokens, and `file://` local directory paths while escaping quotes in `[focus: "..."]`.
3. **Bounded Redacted Session Activity Ring Log (`BrowserBridge activity`)**:
   - Records up to `500` recent browser operations (including single-shot read-only `snapshot` sessions) in `%LOCALAPPDATA%\BrowserBridge\logs\activity.jsonl` (`~/.browser-bridge/logs/activity.jsonl`), strictly scrubbing URLs to `scheme://host[:port]/pathname` (`file:///<basename>`) with zero query parameters, zero `#hash` fragments, zero credentials, and zero input text.

## [0.11.0] - 2026-11-18

### Upgrade Notes (`0.10.1` → `0.11.0`)
- **Minor Version Upgrade (`0.11.0` — Quality-Constrained `SiteLearner` v2, Event-Driven DOM Readiness, Auto-Routine Synthesis & `browser_batch`)**: Re-run the installer (`.\scripts\install.ps1` / `./scripts/install.sh`), reinstall the Python SDK if used (`pip install ./python`), and click **Reload (`↻`)** once on the **Browser Bridge** extension card (`edge://extensions` / `chrome://extensions`).

### Added & Upgraded in `0.11.0`
1. **Quality-Constrained `SiteLearner` v2 (`P0`–`P3` Redesign)**:
   - **Strict Credit Assignment & `_noLearn` Benchmark Isolation**: Strips `_noLearn` and records caller `_siteProfile`, `waitUntil`, and `frames` overrides so synthetic baseline probes never train or drift live site profiles.
   - **Ordered Wait Modes (`commit < domcontentloaded < load`), `k >= 3` Thresholds, Settle Decay & 7-Day TTL**: Eliminates 1-shot policy flips, prevents load timeouts from overwriting faster `commit` profiles, ignores caller `stale_ref` errors for hydration settle, decays `hydrationSettleMs` after 5 consecutive clean navigations, and expires stale learned overrides after 7 days.
   - **Route-Scoped Quality-Constrained Bandit (`RouteBandit`)**: Tracks per-route (`normalize_route_template`) `p50`/`p95` latency, success rate, and content size across candidate readiness arms, enforcing a `>= 85%` reference content-completeness guardrail on idempotent reads with automatic safe-arm fallback.
   - **Field-Level Provenance (`seed` / `learned` / `user`) & Semantic Relocation Auto-Repair**: Preserves `user` overrides across SemVer `PATCH` merges while refreshing aged `learned` drift, and auto-relocates broken read-only selectors via semantic landmarks with post-condition checks.
2. **Event-Driven DOM Readiness Predicate (`waitForDomQuiet`)**:
   - Replaces blind fixed `sleep(hydrationSettleMs)` in `commands.ts` with a `MutationObserver` quiet-window and CSS landmark readiness check (`readinessSelector`, `readinessQuietMs`) in `content.ts`, treating `hydrationSettleMs` strictly as an upper cap and reporting `settledMs`, `settleReason`, `contentChars`, and `mainChars` telemetry.
3. **`PATCH` Release Gate (`scripts/check-routine-gate.py`) & Isolated Interleaved Benchmarks (`scripts/benchmark-sites.py`)**:
   - Enforces `schemaVersion: 2` hygiene plus `N >= 20` interleaved frozen-profile `p50`/`p95` and `>= 80%` content-completeness gates on `routines/*.json` updates.
4. **Automatic Trajectory Distillation (`Auto-Routine`), `browser_batch` / `Page.batch(...)` & Self-Healing Same-URL `ref`s**:
   - Distills completed multi-step workflows into `[auto]` routines with secret scrubbing, executes 1–100 step batches in a single lease roundtrip, and self-heals SPA-rerendered `ref`s on the same URL.

## [0.10.1] - 2026-11-17

### Upgrade Notes (`0.10.0` / `0.7.0` → `0.10.1`)
- **Patch Version Upgrade (`0.10.1` — 24 Timestamped Site JSONs + MV3/Redirect Latency Fixes)**: Re-run the prebuilt bootstrapper (`irm https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.ps1 | iex` or `curl -fsSL https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.sh | bash`) or source installer (`.\scripts\install.ps1` / `./scripts/install.sh`), reinstall the Python SDK if used (`pip install ./python`), and click **Reload (`↻`)** once on the **Browser Bridge** extension card (`edge://extensions` / `chrome://extensions`).
- **Codified 3rd-Digit (`PATCH`, `0.10.Z`) Website-Optimization Policy (`docs/VERSIONING.md`)**: Adding or refreshing website optimization playbooks (`routines/*.json`) increments the **3rd SemVer digit (`x.y.Z`)** and updates ISO-8601 UTC `verifiedAt` / `updatedAt` timestamps so local caches auto-upgrade (`seed.verifiedAt >= disk.updatedAt`) across both `routines` and `accessProfile` without overwriting newer user customizations.

### Engine Speed Fixes (`0.10.1`)
- **Immediate Chromium MV3 Content Injection (`injectImmediately: true`)**: `executeScript` in `extension/src/background/page.ts` now executes as soon as the DOM is ready instead of blocking 12–19 seconds for `document_idle` (`window.onload`) on streaming SSE/WebSocket apps (`perplexity.ai`) or stalled 3rd-party iframes (`medium.com`).
- **Multi-Hop Redirect Tracking (`watchNavigation`)**: Follows chained HTTP `3xx` + client-side redirects across new `main_frame` `requestId`s (`linkedin.com`, `mail.google.com`), eliminating 9-second false stalls.
- **Bounded Multi-Frame Snapshots (`1,500 ms` Cap)**: Non-explicit all-frame snapshots in `commands.ts` cap child-frame scanning at `1,500 ms` and fall back cleanly to the captured `top` frame when a cross-origin ad or Google One-Tap iframe hangs.
- **New Routine URL Variables & Python `**kwargs`**: Added `{{url.cleanPath}}` (used by `reddit.com.json` `.json?raw_json=1` endpoints) and `{{url.arxivId}}` (used by `arxiv.org.json` `/html/{{url.arxivId}}`), plus keyword-argument routine invocation (`page.run_routine("fetch_subreddit_json", subreddit="rust", limit=5)`) in Python.

### Upgraded & Newly Added Website Optimization JSONs (`routines/*.json` — 24 Sites Total)
- **Upgraded `reddit.com.json`**: Added `browse_subreddit`, same-origin `fetch_subreddit_json` (**`99 ms`** structured JSON), `read_thread_json` (`{{url.cleanPath}}.json?raw_json=1` in **`~120–180 ms`**), `search_reddit` with `sort`, and `read_thread` (`shreddit-post` + comments); subreddit open + snapshot in **`481 ms` (`6 ms` snapshot)**.
- **Upgraded `x.com.json`**: Added `search_posts` (`live` / `top` filter), `open_profile`, `read_timeline_posts` (`[data-testid="tweet"]` extraction in **`~45 ms`**), `draft_post` (stages without clicking Post), and `draft_reply`; timeline open + snapshot in **`1,272–2,318 ms` (`5–6 ms` snapshot)**.
- **`perplexity.ai.json` (Perplexity — 23.4× faster)**: `commit` + `450 ms` hydration settle + `injectImmediately` cuts open + snapshot from `29,706 ms` timeout to **`1,267 ms` (`4 ms` snapshot)**; `draft_query`, `ask_search`, `read_answer`.
- **`medium.com.json` (Medium — >1,800× faster snapshot / 40× open)**: Bypasses stalled Google One-Tap GSI parser/iframe (`12,825 ms` snapshot hang → **`7 ms` snapshot**, `23,679 ms` open+snapshot → **`~590 ms`**); `read_article`, `dismiss_meter_modal`, `search_stories`.
- **`linkedin.com.json` (LinkedIn — ~10× faster)**: Multi-hop redirect + `domcontentloaded` cuts Jobs/Feed open + snapshot from `>9,000 ms` stall to **`905–1,670 ms` (`29 ms` snapshot)**; `search_jobs`, `search_people`, `read_main_content`.
- **`pypi.org.json` (PyPI — 6.3×–14.9× faster)**: Bypasses stalled external badge/ad scripts (`9,097 ms` → **`610–1,451 ms`**); `read_package_docs` (`20 KB` full docs in **`~40 ms`**), `search_packages`.
- **`arxiv.org.json` (arXiv — up to 19.4× faster)**: Cuts MathJax/font `onload` stall (`10,682 ms` → **`550–1,811 ms`**); `read_abstract` (**`12 ms`**), `open_html_paper` via `{{url.arxivId}}` (**`1,041 ms`** full HTML paper), `search_papers`.
- **`huggingface.co.json` (Hugging Face)**: `domcontentloaded` + `top`-frame (`~850–2,068 ms` open + `29 ms` snapshot, **`~45 ms`** Model Card read); `read_model_card`, `search_models`, `search_datasets`, `search_papers`.
- **`npmjs.com.json` (npm)**: Clean `#readme` extraction (`1,629 ms` open + **`7–15 ms`** snapshot, **`~45 ms`** README read); `read_package_readme`, `search_packages`.
- **`notion.so.json` (Notion / `notion.com` / `*.notion.site`)**: Hydrated `[role="main"], .notion-page-content` reader (`1,130–2,314 ms` open + `13–16 ms` snapshot); `read_page`, `quick_find` (`Ctrl+K`).
- **`claude.ai.json` (Claude)**: Preserves ProseMirror `[contenteditable="true"]` composer (`~865–1,044 ms` ready + `35–37 ms` snapshot); `draft_prompt`, `ask_and_wait`, `read_conversation`, `new_chat`.
- **`mail.google.com.json` (Gmail)**: Multi-hop redirect + `domcontentloaded` skips infinite `/bind` long-polling hang (`>9,032 ms` → **`950–2,941 ms` open + `6–8 ms` snapshot**); `search_mail`, `read_open_thread`, `draft_compose` (stages draft safely without clicking Send).

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
