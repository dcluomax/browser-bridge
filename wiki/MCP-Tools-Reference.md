# MCP Tools Reference

Browser Bridge `v0.10.0` exposes **31 MCP tools** (plus optional dual-gated `browser_evaluate`), **4 `bridge://` MCP resources**, and **2 MCP workflow prompts**. Stateful `tools/call` turns are processed through a sequential FIFO worker so batched tool calls (for example `[browser_click, browser_snapshot]`) never race out of order.

---

## 1. Discovery, Background Tab Groups & Allowlists

| Tool | Read-Safe? | Key Parameters | Purpose |
| --- | --- | --- | --- |
| `browser_status` | Yes | `browser?` (`edge`, `chrome`, `firefox`, profile label, or `instanceId`) | Lists connected browsers, capabilities, and optionally selects the target profile for the session |
| `browser_tabs` | `list` only | `action` (`list` \| `new` \| `select` \| `close`), `tabId?`, `url?`, `active?` (`false` default), `name?`, `group?`, `allowedOrigins?` | Lists accessible tabs, opens silent background tabs in a collapsed `[Agent]` group, reuses persistent named tabs, switches active tab, or closes owned tabs/groups |
| `browser_allowlist` | Inspect only | `origins?` (`['https://docs.google.com', '*.github.com']`), `clear?`, `tabId?` | Inspects, sets, or clears the session or per-tab `allowedOrigins` domain fence |

---

## 2. Navigation & History

| Tool | Read-Safe? | Key Parameters | Purpose |
| --- | --- | --- | --- |
| `browser_navigate` | No | `url`, `tabId?`, `newTab?`, `waitUntil?` (`load` \| `domcontentloaded` \| `commit`), `timeoutSeconds?` | Navigates and reports actual HTTP status; automatically applies learned domain wait profiles |
| `browser_history` | No | `action` (`back` \| `forward` \| `reload`), `tabId?` | Navigates session history or reloads the current document |

---

## 3. Page Reading & Structured Locators

| Tool | Read-Safe? | Key Parameters | Purpose |
| --- | --- | --- | --- |
| `browser_snapshot` | Yes | `tabId?`, `root?`, `viewportOnly?`, `maxChars?` | Returns accessibility outline with `[ref=e12]`, cross-origin iframe `f3e7` refs, Shadow DOM nodes, SVG `role="shape"`, masked passwords, and `[Site Memory]` hints |
| `browser_get_text` | Yes | `tabId?`, `root?`, `maxChars?` | Returns visible document text with minimal token overhead |
| `browser_locate` | Yes | `locator` (`steps`, `frameId?`), `maxResults?`, `tabId?` | Evaluates chained locators (`role`, `text`, `label`, `placeholder`, `testId`, `alt`, `title`, `css`, `nth`, `first`, `last`, `hasText`) and returns exact `count` + refs |
| `browser_get_element` | Yes | `ref` or `locator`, `operation` (`text` \| `innerText` \| `value` \| `attribute` \| `state` \| `box`), `name?` | Reads typed scalar element properties while keeping password inputs masked |
| `browser_network` | Yes | `action` (`start` \| `status` \| `stop` \| `clear`), `onlyFailures?`, `urlInclude?`, `limit?` | Captures credential-redacted HTTP/XHR/fetch traffic (`Authorization`, `Cookie`, API keys, passwords, JWTs replaced with `[REDACTED]`) |
| `browser_console` | Yes | `action` (`read` \| `clear`), `level?` (`all` \| `warn` \| `error`), `limit?`, `clear?` | Reads or clears page console logs and uncaught JS errors captured from `document_start` |

---

## 4. User Interactions

All interaction tools require `[read-write]` permission and accept either `ref` (from `browser_snapshot`) or structured `locator`:

| Tool | Key Parameters | Purpose |
| --- | --- | --- |
| `browser_click` | `ref` \| `locator`, `button?`, `doubleClick?`, `modifiers?` | Clicks target after verifying visibility and checking that no overlay covers the click point |
| `browser_hover` | `ref` \| `locator` | Moves pointer and dispatches hover events |
| `browser_drag` | `ref` \| `locator` (or `startX,startY`), `targetRef` \| `targetLocator` (or `targetX,targetY` / `dx,dy`), `steps?` | Performs smooth pointer/HTML5 drag-and-drop |
| `browser_type` | `ref` \| `locator`, `text`, `clear?`, `submit?` | Types or replaces text in inputs, textareas, and `contenteditable` fields |
| `browser_fill_form` | `fields: [{ ref, value }]`, `submit?` | Fills multiple form controls in one round-trip |
| `browser_select_option` | `ref` \| `locator`, `values` | Selects `<select>` option(s) by `value` or visible label |
| `browser_set_checked` | `ref` \| `locator`, `checked` (`true` \| `false`) | Idempotently checks or unchecks checkboxes/radios and verifies resulting state |
| `browser_press_key` | `key` (e.g. `Enter`, `Escape`, `Control+A`), `ref?` \| `locator?` | Dispatches trusted or emulated keyboard shortcuts |
| `browser_scroll` | `direction?` (`down` \| `up` \| `top` \| `bottom`), `amount?`, `ref?` \| `locator?` | Scrolls viewport or brings target element into view |

---

## 5. Files, Dialogs, Waits & Screenshots

| Tool | Read-Safe? | Key Parameters | Purpose |
| --- | --- | --- | --- |
| `browser_upload_file` | No | `ref` \| `locator`, `paths: string[]` | Streams local file(s) into `<input type="file">` without OS file dialogs |
| `browser_handle_dialog` | No | `accept`, `promptText?`, `armNext?` | Handles or pre-arms `alert`, `confirm`, `prompt`, and `beforeunload` dialogs |
| `browser_wait_for` | Yes | `text?`, `textGone?`, `url?`, `loadState?`, `state?`, `ref?`, `locator?`, `delaySeconds?`, `timeoutSeconds?` | Waits for observable page or element conditions |
| `browser_screenshot` | Yes | `tabId?`, `fullPage?`, `ref?`, `locator?`, `path?`, `format?`, `quality?`, `maxWidth?` | Captures background viewport, stitched full-page, or element crops without stealing tab focus |

---

## 6. Human Handoff, Demonstrate, Site Memory, WebMCP & Optional Eval

| Tool | Read-Safe? | Key Parameters | Purpose |
| --- | --- | --- | --- |
| `browser_handoff` | No | `message`, `tabId?`, `bringToFront?`, `timeoutSeconds?` | Pops a closed-ShadowRoot Continue card (`WAIT` badge) for login/2FA/CAPTCHA/payment and resumes once user clicks Continue |
| `browser_demonstrate` | No | `instruction?`, `saveAs?`, `description?`, `tabId?`, `timeoutSeconds?` | Records user clicks and non-sensitive inputs (never passwords/OTPs) directly into a reusable Site Memory Routine |
| `browser_routine_list` | Yes | `tabId?`, `domain?`, `includeTrace?` | Lists timestamped `routines/*.json` routines (`verifiedAt`, `[STALE]` warnings), `SiteAccessProfile`, notes, and pitfalls |
| `browser_routine_run` | If `readOnly: true` | `name`, `arguments?`, `tabId?`, `domain?` | Runs a multi-step routine (`op: "fetch"`, `{{param:urlencode}}`, `{{url.docId}}` / `{{url.gid}}` / `{{url.repo}}`) in 1 call |
| `browser_routine_save` | No | `domain?`, `routine?`, `note?`, `deleteRoutine?`, `resetAccessProfile?` | Saves newly learned site routines (stamping fresh `verifiedAt` and clearing `[STALE]`) or domain notes |
| `browser_webmcp_list` | Yes | `tabId?` | Lists page-provided `document.modelContext` and `<form toolname>` WebMCP tools |
| `browser_webmcp_call` | If `readOnlyHint: true` | `name`, `arguments?`, `submit?`, `tabId?` | Invokes a page WebMCP tool with structured input |
| `browser_evaluate` | No | `expression`, `tabId?` | Optional; requires `--allow-evaluate` **and** popup script permission |
