# Browser Bridge Feature Deep Dive

Every subsystem in Browser Bridge `v0.12.0` is engineered around four core design guarantees:

- **100% Local:** Runs inside your own live, signed-in Edge, Chrome, Brave, or Firefox profile with zero cloud relays and zero WebDriver browser downloads.
- **Zero-Port Secure:** Opens **0 TCP/WebSocket ports**, authenticates over OS user-isolated Named Pipes / `0600` Unix sockets, and enforces **3-layer Read-Only / Read-Write tab ACLs**, `allowedOrigins` domain fences, and automatic password/JWT redaction.
- **Native FAST:** Ships as a **~1.5 MB standalone Rust binary** (~8 MB RAM) delivering **`~1.1 ms` median Direct Pipe RTT**, Chromium MV3 `injectImmediately: true` DOM injection, multi-hop redirect tracking, focus-free background screenshots, and a 0-dependency Python SDK.
- **Self-Evolving:** Combines **zero-config engine mitigations**, **quality-constrained `SiteLearner` v2** (event-driven `waitForDomQuiet` DOM readiness, ordered wait lattice, clean-streak decay, and `>= 85%` content-completeness guardrails), **24 git-tracked, timestamped `routines/*.json` site optimization playbooks** (`schemaVersion: 2`, `PATCH` `N >= 20` empirical release gate, field-level provenance, semantic relocation auto-repair & `[STALE]` drift guard), **`browser_demonstrate`**, and native W3C **WebMCP (`document.modelContext`)** tools.

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

## 3. How `SiteLearner` v2 Eliminates Repeat Detours Without Regressions

`SiteLearner` v2 lives inside the Rust host (`bridge-core::routines`) paired with the extension's event-driven readiness engine (`waitForDomQuiet`), modeling per-route browser readiness as a **quality-constrained contextual bandit** rather than one-way heuristic sleep rules:

- **Event-Driven DOM Readiness (`waitForDomQuiet` vs. Blind Sleeps):** Instead of sleeping unconditionally for `hydrationSettleMs`, the content script attaches a bounded `MutationObserver` and optional landmark check that resolves immediately once DOM mutations remain quiet (or the primary landmark renders with content), treating `min(hydrationSettleMs, 600 ms)` strictly as an **upper timeout cap**. Already-hydrated SSR pages settle in milliseconds without paying fixed timer waste.
- **Quality-Constrained Route Bandit (`(domain, routeTemplate, opClass)`):** Tracks per-arm `p50`/`p95` post-network latency, success rate, and extracted character yield separately per route template (isolating e.g. `docs.google.com/document` from `/spreadsheets`). Candidate readiness arms minimize tail-weighted latency (`0.7 * p50 + 0.3 * p95`) subject to `>= 90%` reliability and a **`>= 85%` reference content-completeness floor** (`C_ref`), exploring only on idempotent reads and transparently retrying with a conservative safe arm if an early snapshot returns an unhydrated shell.
- **Ordered Wait Lattice, `k >= 3` Hysteresis & Clean-Streak Decay:** Enforces a strict total order `commit < domcontentloaded < load` so `load`-timeout telemetry never overwrites a faster `commit` profile; requires `k >= 3` consistent observations before switching wait levels; decays `hydrationSettleMs` caps downward after consecutive clean navigations; and attaches TTLs to latched transport flags (`serviceWorkerNavigation`, `preferredInput`).
- **Strict Credit-Assignment & Benchmark Isolation (`_noLearn`):** Ignores caller-overridden wait/frame calls when updating learned defaults and honors `_noLearn: true` across RPC commands so multi-stage benchmarks never mutate the profile under test.
- **Field-Level Provenance (`seed` / `learned` / `user`) & Semantic Relocation:** Merges `seed`, `learned`, and `user` profile fields independently on upgrade (`user` overrides always win) and attempts ARIA/landmark semantic relocation with graceful top-frame snapshot fallback before marking broken routines `[STALE]`.

| Observed Friction on Visit 1 | Quality-Constrained `SiteLearner` v2 Adaptation | Benefit on Subsequent Visits |
| --- | --- | --- |
| `page.navigate` repeatedly (`k >= 3`) hits `load` timeouts or `> 3s` post-DOM tails while content is complete | Relaxes ordered wait mode `load -> domcontentloaded` (never inverting `commit`) | Skips multi-second stalled `onload` beacons without regressing faster `commit` seeds |
| Early snapshot returns `< 85%` of `C_ref` or triggers post-nav `stale_ref` | Raises `waitForDomQuiet` upper cap (`150–600 ms`) & retries safe arm immediately; decays cap after clean streaks | Captures full SPA hydration (`youtube.com`, `x.com`) while imposing near-zero delay once SSR DOMs are quiet |
| Action fails with `covered by <div#cookie-wall>`, agent clicks `#accept-cookies`, then retry succeeds | Records `LearnedRecoveryRule` triad (`blocker`, `recoveryMethod`, `recoveryTarget`) | Surfaces exact proven dismissal step immediately |
| Chromium `chrome.debugger` attachment is blocked by enterprise policy or extension conflict | Sets `preferredInput = "dom"` with 24h TTL expiration | Avoids repeated debugger attach retries without permanent lock-in |
| Plain HTTP `request.fetch` receives `403` / `429` WAF block while `page.fetch` succeeds | Sets `directHttpBlocked = true` | `smart_fetch` routes directly through the authenticated tab |
| A saved routine selector misses after a website UI redesign | Attempts semantic ARIA/heading relocation + safe top-frame fallback; marks `stale = true` after `>= 2` misses | Prevents brittle routine failure cliffs while flagging `[STALE]` for refresh via `browser_routine_save` |

---

## 4. Built-In Timestamped Site Optimization Playbooks (`routines/*.json` — 24 Sites)

All **24** built-in playbooks live in [`routines/`](../routines/) (`schemaVersion: 2`), follow the **3rd-digit (`PATCH`, `0.10.Z`) Empirical Release Gate ([`docs/VERSIONING.md`](VERSIONING.md))** (`scripts/check-routine-gate.py`: `N >= 20` interleaved `_noLearn: true` trials verifying `p50`/`p95` non-regression and `>= 80%` content completeness vs. `load`), merge cleanly via field-level provenance (`seed` / `learned` / `user`), and combine with zero-config engine mitigations and `waitForDomQuiet` to eliminate multi-second non-network stalls:

| Playbook File | Canonical Domain / Alias | Built-in Routines | Network-Excluded / `0-Net` Speedup |
| --- | --- | --- | --- |
| `perplexity.ai.json` | `perplexity.ai` (`perplexity`) | `draft_query`, `ask_search`, `read_answer` | `18.9s` SSE `document_idle` hang → **`4–7.8 ms` `0-Net` snap (>2,400×)** · **`~450–840 ms` post-net** |
| `medium.com.json` | `medium.com` (`medium`) | `read_article`, `dismiss_meter_modal`, `search_stories` | `12,825 ms` One-Tap iframe hang → **`5.7–7 ms` `0-Net` snap (>1,800×)** · **`586 ms` post-net (39×)** |
| `docs.google.com__spreadsheets.json` | `docs.google.com/spreadsheets` (`google-sheets` / `google-excel`) | `read_sheet_csv`, `read_cell`, `write_cell`, `select_range`, `rename_spreadsheet` | `8,077 ms` UI detours → **`180–259 ms` `0-Net` cell R/W (31×–45×)** · **`~201–325 ms`** `/gviz/tq` CSV |
| `google.com.json` | `google.com` (`google`) | `search`, `read_results`, `next_results_page` | `~14,978 ms` post-net → **`532 ms` post-net (28×)** · **`41 ms` `0-Net` `read_results`** |
| `docs.google.com__document.json` | `docs.google.com/document` (`google-docs`) | `read_document`, `append_text`, `replace_text`, `rename_document` | **`10 ms` `0-Net` Kix `<canvas>` `DOCS_modelChunk` snapshot** + **`~170–267 ms`** `/mobilebasic` full read |
| `arxiv.org.json` | `arxiv.org` (`arxiv`) | `read_abstract`, `open_html_paper`, `search_papers` | `~10,100 ms` MathJax stall → **`~550 ms` post-net (18×)** · **`12 ms` `0-Net` `read_abstract`** + `{{url.arxivId}}` |
| `pypi.org.json` | `pypi.org` (`pypi`) | `read_package_docs`, `search_packages` | `~7,320 ms` post-net → **`491 ms` post-net (14.9×)** · **`40–50 ms` `0-Net` `read_package_docs`** |
| `linkedin.com.json` | `linkedin.com` (`linkedin`) | `search_jobs`, `search_people`, `read_main_content` | `>8,500 ms` multi-hop redirect stall → **`~450–905 ms` (~10×–18×)** · **`29 ms` `0-Net` snap** |
| `mail.google.com.json` | `mail.google.com` (`gmail`) | `search_mail`, `read_open_thread`, `draft_compose` | Skips infinite `/bind` long-poll (`>9s` → **`~950 ms` post-net**, **`6–8 ms` `0-Net` snap**); safe `draft_compose` |
| `github.com.json` | `github.com` | `read_main_content`, `search_github`, `search_repo_issues`, `go_to_file` | 200-link header compaction + `{{url.repo}}`: **`50 ms` `0-Net` untruncated README/PR read** |
| `huggingface.co.json` | `huggingface.co` (`hf`) | `read_model_card`, `search_models`, `search_datasets`, `search_papers` | **`18–45 ms` `0-Net` Model Card read** (`23.9 ms` `0-Net` snap) without 200-file header truncation |
| `npmjs.com.json` | `npmjs.com` (`npm`) | `read_package_readme`, `search_packages` | Skips child-frame stalls: **`13 ms` `0-Net` `#readme` extraction** (`13.1 ms` `0-Net` snap) |
| `notion.so.json` | `notion.so` (`notion`, `notion.com`, `*.notion.site`) | `read_page`, `quick_find` | **`13–16 ms` `0-Net` snap** · **`~50 ms` `.notion-page-content` read** + `Ctrl+K` `quick_find` |
| `chatgpt.com.json` | `chatgpt.com` (`chatgpt`) | `draft_prompt`, `ask_and_wait`, `read_conversation`, `new_chat` | Protected `contentinfo` `<form>` · **`35 ms` `0-Net` read** · **`117 ms` draft** · deterministic Stop-button wait |
| `claude.ai.json` | `claude.ai` (`claude`) | `draft_prompt`, `ask_and_wait`, `read_conversation`, `new_chat` | ProseMirror `[contenteditable]` staging · **`35–37 ms` `0-Net` snap** · deterministic Stop-button wait |
| `reddit.com.json` | `reddit.com` | `browse_subreddit`, `fetch_subreddit_json`, `read_thread_json`, `search_reddit`, `read_thread` | **`6 ms` `0-Net` snap** · **`99 ms`** `.json?raw_json=1` feed · `{{url.cleanPath}}` nested comment reader |
| `x.com.json` | `x.com` (`twitter`) | `search_posts`, `open_profile`, `read_timeline_posts`, `draft_post`, `draft_reply` | **`5 ms` `0-Net` snap** · **`~45 ms` timeline tweet extraction** · safe `draft_post` / `draft_reply` |
| `diagrams.net.json` | `diagrams.net` (`drawio`) | `read_diagram_xml`, `write_diagram_xml`, `insert_shape`, `add_page` | `#fragment` `30s` timeout → `4.96 s`; **`660 ms` `0-Net` XML read** / **`870 ms` write** |
| `amazon.com.json` | `amazon.com` | `search_products`, `read_product_details` | Soft-gate bypass + 20-iframe ad skip: `16,043 ms` → **`2,491 ms` (6.4×)** |
| `finance.yahoo.com.json` | `finance.yahoo.com` | `lookup_quote`, `read_quote_summary` | `8,050 ms+` → **`702 ms` (11.5×)** · **`51 ms` `0-Net` `read_quote_summary`** |
| `youtube.com.json` | `youtube.com` | `search_videos`, `open_transcript` | **`2,042 ms`** video search (avoids 30s Polymer streaming `onload` stall) |
| `wikipedia.org.json` | `wikipedia.org` | `search_article`, `read_article` | ~8 KB `#cite_note` compaction · **`52 ms` `0-Net` 35k-char `#mw-content-text` read** |
| `news.ycombinator.com.json` | `news.ycombinator.com` (`hn`) | `read_front_page`, `search_hn` | Flattens `border=0` layout tables; **`32 ms` `0-Net` 30/30 stories untruncated** |
| `stackoverflow.com.json` | `stackoverflow.com` | `dismiss_cookies`, `search_questions`, `read_qa` | Auto-dismisses OneTrust banner + 1,200-char code blocks + **`~60 ms` `0-Net` Q&A read** |

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
