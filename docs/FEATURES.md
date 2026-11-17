# Browser Bridge Feature Deep Dive

Every subsystem in Browser Bridge `v0.10.0` is engineered around four core design guarantees:

- **100% Local:** Runs inside your own live, signed-in Edge, Chrome, Brave, or Firefox profile with zero cloud relays and zero WebDriver browser downloads.
- **Zero-Port Secure:** Opens **0 TCP/WebSocket ports**, authenticates over OS user-isolated Named Pipes / `0600` Unix sockets, and enforces **3-layer Read-Only / Read-Write tab ACLs**, `allowedOrigins` domain fences, and automatic password/JWT redaction.
- **Native FAST:** Ships as a **~1.5 MB standalone Rust binary** (~8 MB RAM) delivering **`~1.1 ms` median Direct Pipe RTT**, 1-RTT lazy DOM injection, focus-free background screenshots, and a 0-dependency Python SDK.
- **Self-Evolving:** Ships **14 git-tracked, timestamped `routines/*.json` site optimization playbooks** (`schemaVersion: 2`, `verifiedAt` upgrade auto-merge, `[STALE]` website-redesign drift guard, **5×–31× measured speedups**), passively learns adaptations via **`SiteLearner`**, records user demonstrations via **`browser_demonstrate`**, and discovers native W3C **WebMCP (`document.modelContext`)** tools.

This document details the 31+1 MCP tools, DOM/Canvas/SVG accessibility snapshots, structured locators, Timestamped Site Optimization JSONs (`routines/*.json`), Adaptive Error-Driven Site Learning (`SiteLearner`), and W3C WebMCP integration.

---

## 1. Rich Accessibility Snapshots (`browser_snapshot`)

`browser_snapshot` produces a compact, token-efficient accessibility outline with stable per-document element references (`[ref=e12]`):

- **Google Docs Kix `<canvas>` Native Text Extraction (`10 ms`):** Parses in-page `DOCS_modelChunk` payloads directly in `content.ts` (zero network requests, zero `eval`) so `browser_snapshot` and `browser_get_text` read Canvas-rendered Google Docs prose immediately.
- **Google Sheets / Excel Coordinate Controls:** Automatically exposes `#t-name-box` as `"Name box"` and `#t-formula-bar-input` as `"Formula bar"`, enabling deterministic `259 ms` coordinate jumps and formula reads/writes.
- **Smart `<main>` Budgeting & Layout Compaction:** On massive pages (`GitHub`, `Wikipedia`, `Hacker News`, `ChatGPT`, `Stack Overflow`), automatically compacts sprawling `<header>`/`<nav>`/`<aside>` link menus when approaching `maxChars`, flattens nested `border=0` layout tables, compresses `#cite_note` intra-page hash links, protects composer `<form>` regions inside `contentinfo`, and preserves up to 1,200 characters per `<pre><code>` block.
- **Shadow DOM & Unslotted Light-DOM Traversal:** Pierces open Shadow Roots and preserves unslotted light-DOM children (`shreddit-*`, custom design systems).
- **Cross-Origin Iframes:** Aggregates child frames and prefixes frame-scoped element references as `f<frameId>e<index>` (for example, `f3e7`), supporting full 64-bit Firefox frame IDs (`> 2^31`).
- **SVG Diagram Canvas Support:** Recognizes interactive SVG shapes (`rect`, `circle`, `ellipse`, `polygon`, `path`, `g` with labels/transforms) as `role="shape"` with geometry and label metadata — making whiteboard and diagramming apps (`app.diagrams.net` / Excalidraw / Mermaid) readable without vision-only guessing.
- **Cursor-Pointer & Custom Widgets:** Surfaces clickable `cursor: pointer` cards and ARIA controls alongside native HTML buttons, inputs, links, and form fields.
- **Automatic Credential Masking:** `<input type="password">` values and sensitive attributes are always masked.
- **Scoped & Viewport-Filtered Reads:** Pass `root` (CSS selector) or `viewportOnly: true` and `maxChars` to bound token usage on massive pages.

---

## 2. Complete MCP Tools Matrix

### Session, Tab Groups & Allowlist Fencing
- **`browser_status`** — Lists all connected browser instances, versions, profile labels, active tab leases, and capability flags; optionally pins the preferred `browser` (`"edge"`, `"chrome"`, `"firefox"`, profile label `"Work"`, or `instanceId`).
- **`browser_tabs`** — Actions:
  - `list`: Lists tabs visible to this agent session (`shared by user`, `yours`, `released`, plus `#name`, `group=...`, and `WAIT` tags).
  - `new`: Opens a background tab silently by default (`active: false`), groups it into a collapsed Chromium `[Agent]` tab group (`group: "Agent"`), supports persistent named tab reuse (`name: "work-doc"`, exempt from 10-minute idle auto-close), and accepts per-tab `allowedOrigins`.
  - `select`: Claims and switches the session's active target tab (`tabId`).
  - `close`: Closes an agent-eligible `tabId` or an entire tab `group`.
- **`browser_allowlist`** — Inspects, sets, or clears the `allowedOrigins` domain fence (`['https://docs.google.com', '*.github.com']`) for the session or a specific `tabId`.

### Navigation & History
- **`browser_navigate`** — Navigates to `url` (or opens `newTab: true`) and correlates real `webNavigation` + `webRequest` HTTP status codes (`200`, `404`, `403`, redirects). Automatically applies per-domain learned `preferredWaitUntil`.
- **`browser_history`** — Navigates `back`, `forward`, or triggers `reload`.

### Inspection, Structured Locators & Redacted Diagnostics
- **`browser_snapshot`** — Interactive outline + refs + `[Site Memory & Fast Routines]` header when domain knowledge exists.
- **`browser_get_text`** — Extracts clean visible text with minimal token cost.
- **`browser_locate`** — Resolves Playwright-style chained locator steps (`role`, `text`, `label`, `placeholder`, `testId`, `alt`, `title`, `css`, `nth`, `first`, `last`, `hasText`) and returns exact total `count` plus bounded summaries and refs.
- **`browser_get_element`** — Reads scalar `text`, `innerText`, `value`, `attribute`, `boundingBox`, or boolean states (`visible`, `enabled`, `editable`, `checked`).
- **`browser_network`** — Starts, reads, clears, or stops HTTP/XHR/fetch traffic capture on a tab (`onlyFailures`, `urlInclude`, `limit`) with automatic `[REDACTED]` scrubbing of `Authorization`, `Cookie`, API keys, passwords, OTPs, and JWTs.
- **`browser_console`** — Reads or clears page `console.log/info/warn/error` messages and uncaught exceptions/rejections captured since `document_start`.

### Precision Interactions
- **`browser_click`** — Left, right, middle, or double-click by `ref` or `locator` with modifier keys (`Control`, `Shift`, `Alt`, `Meta`). Refuses clicks when a modal/banner covers the target (`not_actionable: covered by <div#...>`) rather than mis-clicking an overlay.
- **`browser_hover`** — Moves pointer / dispatches hover events over target element.
- **`browser_drag`** — Drags from source (`ref` / `locator` / coordinates) to destination (`targetRef` / `targetLocator` / `targetX,targetY` / `dx,dy`) using smooth multi-step CDP pointer trajectories or HTML5 `DragEvent` + `PointerEvent` dispatch.
- **`browser_type`** — Replaces (`clear: true`) or appends text, with optional `submit: true` (`Enter`).
- **`browser_fill_form`** — Fills multiple form fields in a single batched round-trip (`fields: [{ ref, value }, ...]`, optional `submit`).
- **`browser_select_option`** — Selects `<select>` single or multiple options by `value` or visible `label` and verifies selection.
- **`browser_set_checked`** — Idempotently sets checkbox/radio state (`checked: true|false`) and verifies that page handlers did not cancel the change.
- **`browser_press_key`** — Sends key chords (`Enter`, `Escape`, `Control+A`, `Meta+K`, `ArrowDown`, etc.) to a target element or active document.
- **`browser_scroll`** — Scrolls the page (`up`, `down`, `left`, `right`, `top`, `bottom`) or scrolls a specific `ref`/`locator` into view.

### Files, Dialogs, Waits & Screenshots
- **`browser_upload_file`** — Streams local files in safe base64 chunks into `<input type="file">` elements without opening OS file-picker dialogs.
- **`browser_handle_dialog`** — Accepts or dismisses `alert`, `confirm`, `prompt`, and `beforeunload` dialogs (`armNext: true` pre-arms before clicking a trigger button).
- **`browser_wait_for`** — Waits for `text` appearance, `textGone`, `url`, `loadState` (`domcontentloaded` / `load`), element `state` (`visible`, `hidden`, `attached`, `detached`, `enabled`, `editable`, `checked`), or fixed `delaySeconds`.
- **`browser_screenshot`** — Background-capable capture (no window focus steal):
  - Viewport, `fullPage: true` stitched/resized capture, or element crop (`ref` / `locator`).
  - `format: "jpeg" | "png"`, `quality`, `maxWidth`, and direct disk output via `path` (saving to `path` avoids returning huge base64 blobs into the LLM context window).

### Human Handoff & Password-Safe Demonstrate-to-Routine
- **`browser_handoff`** — Hands a tab back to the user for human-only steps (login, 2FA/MFA, Cloudflare/CAPTCHA verification, payment). Displays a closed-ShadowRoot Continue card and `WAIT` badge on the tab, resuming automatically once the user clicks **Continue**.
- **`browser_demonstrate`** — Records a user-demonstrated workflow on the tab while strictly ignoring password and OTP inputs. Pass `saveAs` to persist the recorded steps directly into `Site Memory` as a reusable Routine.

### Timestamped Site Memory & Routines (`schemaVersion: 2`)
- **`browser_routine_list`** — Lists built-in (`routines/*.json`) and user/agent-saved routines, `verifiedAt`/`updatedAt` timestamps, `[STALE]` redesign warnings, `speedupSummary`, notes, recorded pitfalls, and the learned `SiteAccessProfile` for the current tab or `domain` (supports aliases such as `google-docs`, `google-sheets`, `google-excel`, `chatgpt`).
- **`browser_routine_run`** — Executes a parameterized multi-step routine (`navigate`, `click`, `doubleClick`, `drag`, `type`, `select`, `check`, `press`, `scroll`, `waitFor`, `locate`, `query`, `queryAll`, `snapshot`, `text`, `screenshot`, `fetch` with `stripHtml`, `webmcp.call`, `dialog`) with `{{param}}`, `{{param:urlencode}}`, automatic URL variables (`{{url.docId}}`, `{{url.gid}}`, `{{url.repo}}`, `{{url.origin}}`), and `saveAs` outputs in a single tool call.
- **`browser_routine_save`** — Persists a reusable routine (stamping a fresh ISO-8601 `verifiedAt` and clearing `[STALE]`), domain tip (`note`), `deleteRoutine`, or resets a domain profile (`resetAccessProfile: true`).

### Native W3C WebMCP
- **`browser_webmcp_list`** — Discovers imperative tools registered on `document.modelContext` / `navigator.modelContext` (`registerTool`, `provideContext`) as well as declarative HTML `<form toolname="..." tooldescription="...">` tools, including `readOnlyHint` and `consequentialHint` annotations.
- **`browser_webmcp_call`** — Invokes a discovered WebMCP tool by `name` with structured JSON `arguments`. Automatically enforces `readOnlyHint === true` whenever the tab or MCP server is in read-only mode.

### Dual-Gated Page Evaluation
- **`browser_evaluate`** — Hidden from `tools/list` unless the MCP server was started with `--allow-evaluate`, and still rejected at runtime unless **Allow agents to run page scripts** is switched on in the browser popup.

---

## 3. How `SiteLearner` Eliminates Repeat Detours

`SiteLearner` lives inside the Rust host (`bridge-core::routines`) and passively observes command telemetry and errors per canonical hostname (skipping `localhost` / `127.0.0.1` unless explicitly configured for testing):

| Observed Friction on Visit 1 | Automatic Adaptation Persisted in `SitePlaybook` | Benefit on Visit 2+ |
| --- | --- | --- |
| `page.navigate` hits `load` timeout while DOM is already interactive (stalled analytics/ad beacon) | Sets `preferredWaitUntil = "domcontentloaded"` | Skips multi-second stalled `onload` waits automatically |
| Slow tail between `DOMContentLoaded` and `load` (`> 2.5s`) across visits | Sets `preferredWaitUntil = "domcontentloaded"` | Cuts navigation latency by 60–90% |
| Early `stale_ref` or `not_ready` right after navigation | Tunes `hydrationSettleMs` (`150–400 ms`) | Prevents SPA React/Next/Vue hydration race failures |
| Action fails with `covered by <div#cookie-wall>`, agent clicks `#accept-cookies`, then retry succeeds | Records `LearnedRecoveryRule` triad (`blocker`, `recoveryMethod`, `recoveryTarget`) | Surfaces exact proven dismissal step immediately |
| Chromium `chrome.debugger` attachment is blocked by enterprise policy or extension conflict | Sets `preferredInput = "dom"` (with 24h TTL) | Avoids repeated debugger attach retries |
| Plain HTTP `request.fetch` receives `403` / `429` WAF block while `page.fetch` succeeds | Sets `directHttpBlocked = true` | `smart_fetch` routes directly through the authenticated tab |
| A saved routine fails `>= 2` consecutive times with selector/timeout errors after a website redesign | Marks routine `stale = true` with `staleReason` | Flags `[STALE - DOM may have changed]` so the agent refreshes selectors via `browser_snapshot` |

---

## 4. Built-In Timestamped Site Optimization Playbooks (`routines/*.json`)

All 14 built-in playbooks live in [`routines/`](../routines/) (`schemaVersion: 2`), carry ISO-8601 UTC `verifiedAt` and `updatedAt` timestamps, auto-refresh outdated built-in selectors on upgrade without touching custom user flows, and deliver measured 5×–31× speedups:

| Playbook File | Canonical Domain / Path | Built-in Routines | Measured Speedup |
| --- | --- | --- | --- |
| `google.com.json` | `google.com` | `search`, `read_results`, `next_results_page` | `15,495 ms` → **`1,292–1,423 ms` (~11–12×)** |
| `docs.google.com__document.json` | `docs.google.com/document` (`google-docs`) | `read_document`, `append_text`, `replace_text`, `rename_document` | `8,218 ms` → **`1,528 ms` (5.4×)** + **`10 ms`** Kix `<canvas>` snapshot + **`~170–267 ms`** `/mobilebasic` read |
| `docs.google.com__spreadsheets.json` | `docs.google.com/spreadsheets` (`google-sheets` / `google-excel`) | `read_sheet_csv`, `read_cell`, `write_cell`, `select_range`, `rename_spreadsheet` | `8,077 ms` → **`259 ms` (31×)** cell R/W + **`~201–325 ms`** `/gviz/tq` CSV |
| `github.com.json` | `github.com` | `read_main_content`, `search_github`, `search_repo_issues`, `go_to_file` | `3,469 ms` → **`~920 ms` (3.8×)** nav + **`~50 ms`** untruncated README/PR read |
| `chatgpt.com.json` | `chatgpt.com` (`chatgpt`) | `draft_prompt`, `ask_and_wait`, `read_conversation`, `new_chat` | **`~690–914 ms`** ready + **`117 ms`** safe draft + deterministic `stop-button` wait |
| `diagrams.net.json` | `diagrams.net` (`drawio`) | `read_diagram_xml`, `write_diagram_xml`, `insert_shape`, `add_page` | `#fragment` `30s` timeout → `4.96 s`; **`660 ms`** XML read / **`870 ms`** write |
| `amazon.com.json` | `amazon.com` | `search_products`, `read_product_details` | `16,043 ms` → **`2,491 ms` (6.4×)** |
| `finance.yahoo.com.json` | `finance.yahoo.com` | `lookup_quote`, `read_quote_summary` | `8,050 ms+` → **`702 ms` (11.5×)** |
| `youtube.com.json` | `youtube.com` | `search_videos`, `open_transcript` | **`2,042 ms`** video search (avoids 30s streaming `onload` stall) |
| `wikipedia.org.json` | `wikipedia.org` | `search_article`, `read_article` | ~8 KB `#cite_note` compaction + 35k-char article read in **`~2.2 s`** |
| `news.ycombinator.com.json` | `news.ycombinator.com` (`hn`) | `read_front_page`, `search_hn` | Flattens `border=0` layout tables; 30/30 stories untruncated |
| `stackoverflow.com.json` | `stackoverflow.com` | `dismiss_cookies`, `search_questions`, `read_qa` | Auto-dismisses OneTrust banner + 1,200-char code blocks + **`~60 ms`** Q&A read |
| `reddit.com.json` | `reddit.com` | `search_reddit`, `read_thread` | `directHttpBlocked=true` (`403` skip) + `shreddit-*` Shadow DOM traversal |
| `x.com.json` | `x.com` (`twitter`) | `search_posts`, `draft_post` | `domcontentloaded` + `350 ms` hydration + Cloudflare `browser_handoff` detection |

---

## 5. MCP Resources & Prompts

Beyond tools, `BrowserBridge mcp` implements standard MCP `resources/*` and `prompts/*`:

- **Resources:**
  - `bridge://guide` — Rendered Shared-Tab Agent Guide (`AGENT.md`) with exact host binary path.
  - `bridge://status` — Live JSON status of connected browsers and profiles.
  - `bridge://tabs` — Live inventory of shared and agent-owned tabs across connected browsers.
  - `bridge://routines` — Summary catalog of learned Site Memory domains and routines.
- **Prompts:**
  - `inspect-shared-tab` — Read-only analysis workflow prompt for a shared tab.
  - `act-in-shared-tab` — Confirmation-aware interactive workflow prompt for a shared tab.
