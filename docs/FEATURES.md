# Browser Bridge Feature Deep Dive

Every subsystem in Browser Bridge `v0.7.0` is engineered around four core design guarantees:

- **100% Local:** Runs inside your own live, signed-in Edge, Chrome, Brave, or Firefox profile with zero cloud relays and zero WebDriver browser downloads.
- **Zero-Port Secure:** Opens **0 TCP/WebSocket ports**, authenticates over OS user-isolated Named Pipes / `0600` Unix sockets, and enforces **3-layer Read-Only / Read-Write tab ACLs** with automatic password/JWT redaction.
- **Native FAST:** Ships as a **~1.5 MB standalone Rust binary** (~8 MB RAM) delivering **`~1.1 ms` median Direct Pipe RTT**, 1-RTT lazy DOM injection, focus-free background screenshots, and a 0-dependency Python SDK.
- **Self-Evolving:** Passively learns per-domain navigation modes, hydration settles, and blocker workarounds via **`SiteLearner`**, replays multi-step workflows in 1 call via **Site Memory Routines**, and discovers native W3C **WebMCP (`document.modelContext`)** tools.

This document details the 26 MCP tools, DOM & SVG accessibility snapshots, structured locators, Adaptive Error-Driven Site Learning (`SiteLearner`), Executable Site Memory Routines, and W3C WebMCP integration.

---

## 1. Rich Accessibility Snapshots (`browser_snapshot`)

`browser_snapshot` produces a compact, token-efficient accessibility outline with stable per-document element references (`[ref=e12]`):

- **Shadow DOM Traversal:** Automatically pierces open Shadow Roots so modern web components and design systems expose interactive controls cleanly.
- **Cross-Origin Iframes:** Aggregates child frames and prefixes frame-scoped element references as `f<frameId>e<index>` (for example, `f3e7`), supporting full 64-bit Firefox frame IDs (`> 2^31`).
- **SVG Diagram Canvas Support:** Recognizes interactive SVG shapes (`rect`, `circle`, `ellipse`, `polygon`, `path`, `g` with labels/transforms) as `role="shape"` with geometry and label metadata — making whiteboard and diagramming apps (`app.diagrams.net` / Excalidraw / Mermaid) readable without vision-only guessing.
- **Cursor-Pointer & Custom Widgets:** Surfaces clickable `cursor: pointer` cards and ARIA controls alongside native HTML buttons, inputs, links, and form fields.
- **Automatic Credential Masking:** `<input type="password">` values and sensitive attributes are always masked.
- **Scoped & Viewport-Filtered Reads:** Pass `root` (CSS selector) or `viewportOnly: true` and `maxChars` to bound token usage on massive pages.

---

## 2. Complete MCP Tools Matrix

### Session & Tab Management
- **`browser_status`** — Lists all connected browser instances, versions, profile labels, active tab leases, and capability flags; optionally pins the preferred `browser` (`"edge"`, `"chrome"`, `"firefox"`, profile label `"Work"`, or `instanceId`).
- **`browser_tabs`** — Actions:
  - `list`: Lists tabs visible to this agent session (`shared by user`, `yours`, `released`).
  - `new`: Opens a background tab (`url`, optional persistent `name`, optional `group`, optional `readOnlyTab`, optional `allowedOrigins`).
  - `select`: Claims and switches the session's active target tab (`tabId`).
  - `close`: Closes an agent-eligible tab (`tabId`).

### Navigation & History
- **`browser_navigate`** — Navigates to `url` (or opens `newTab: true`) and correlates real `webNavigation` + `webRequest` HTTP status codes (`200`, `404`, `403`, redirects). Automatically applies per-domain learned `preferredWaitUntil`.
- **`browser_history`** — Navigates `back`, `forward`, or triggers `reload`.

### Inspection & Structured Locators
- **`browser_snapshot`** — Interactive outline + refs + `[Site Memory & Fast Routines]` header when domain knowledge exists.
- **`browser_get_text`** — Extracts clean visible text with minimal token cost.
- **`browser_locate`** — Resolves Playwright-style chained locator steps (`role`, `text`, `label`, `placeholder`, `testId`, `alt`, `title`, `css`, `nth`, `first`, `last`, `hasText`) and returns exact total `count` plus bounded summaries and refs.
- **`browser_get_element`** — Reads scalar `text`, `innerText`, `value`, `attribute`, `boundingBox`, or boolean states (`visible`, `enabled`, `editable`, `checked`).

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

### Adaptive Site Memory & Routines
- **`browser_routine_list`** — Lists built-in and user/agent-saved routines, notes, recorded pitfalls, and the learned `SiteAccessProfile` for the current tab or `domain`.
- **`browser_routine_run`** — Executes a parameterized multi-step routine (`navigate`, `click`, `type`, `select`, `check`, `press`, `waitFor`, `query`, `queryAll`, `snapshot`, `evaluate`) with `{{param}}` interpolation and `saveAs` outputs in a single tool call.
- **`browser_routine_save`** — Persists a reusable routine, domain tip (`note`), or resets a domain profile (`resetAccessProfile: true`).

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

---

## 4. MCP Resources & Prompts

Beyond tools, `BrowserBridge mcp` implements standard MCP `resources/*` and `prompts/*`:

- **Resources:**
  - `bridge://guide` — Rendered Shared-Tab Agent Guide (`AGENT.md`) with exact host binary path.
  - `bridge://status` — Live JSON status of connected browsers and profiles.
  - `bridge://tabs` — Live inventory of shared and agent-owned tabs across connected browsers.
  - `bridge://routines` — Summary catalog of learned Site Memory domains and routines.
- **Prompts:**
  - `inspect-shared-tab` — Read-only analysis workflow prompt for a shared tab.
  - `act-in-shared-tab` — Confirmation-aware interactive workflow prompt for a shared tab.
