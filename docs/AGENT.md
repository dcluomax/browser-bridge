# Browser Bridge — Shared Tab Agent Guide

The user shared a live, logged-in browser tab with you using a compact prompt such as:
`[Browser Bridge #<TAB_ID> RO|RW <BROWSER>[:<LABEL>]] <Title> (<host>) [focus: "..."]`
(or `tab <TAB_ID>` in `<BROWSER> <INSTANCE>`).

## Safety & Access Modes (`RO` / `[read-only]` vs `RW` / `[read-write]`)
1. Act **only** on the shared `tabId` (`#<TAB_ID>`).
2. **If the prompt says `RO` or `[read-only]` (or MCP is in `--read-only` mode)**: ONLY inspect (`browser_snapshot`, `browser_get_text`, `browser_locate`, `browser_get_element`, `browser_screenshot`, `browser_styles`, `browser_layout`, `browser_dom_baseline`, `browser_performance`, `browser_har`, `browser_webmcp_list`, read-only `browser_routine_run` / `browser_batch`, or `readOnlyHint=true` WebMCP tools). Patch and interception tools permit `list` only. Do **not** click, type, upload, navigate, apply or roll back patches, or intercept requests.
3. **If `RW` or `[read-write]`**: confirm with the user before submitting forms, sending messages, making purchases, or changing account settings. Hand logins, MFA, and CAPTCHAs back to the user.

## 1. Use MCP Tools, Site Routines & WebMCP (preferred when `browser-bridge` MCP is available)
1. Target the shared tab directly (Browser Bridge auto-routes `tabId` across simultaneously open Edge/Chrome/Firefox instances in `< 1 ms`, or pass optional `"browser": "<BROWSER[:LABEL]|INSTANCE>"` directly on any tool):
   - Interactive outline + element refs (`[ref=e12]`; SVG diagram shapes appear as `role="shape"`): `browser_snapshot({ "tabId": <TAB_ID>, "browser": "<BROWSER>" })` (automatically surfaces `[Site Memory & Fast Routines]` + learned per-site perf adaptations!)
   - Browser Bridge automatically learns from errors per website (`load` timeouts -> `domcontentloaded`, SPA hydration races -> settle wait, CDP failures -> direct DOM input, 403 HTTP -> browser session, blocker recovery triads) and applies them transparently.
   - Inspect site routines, timestamped JSON `verifiedAt`/`updatedAt`, learned `accessProfile`, tips, and recorded pitfalls: `browser_routine_list({ "tabId": <TAB_ID> })` (note: routines marked `[STALE]` indicate the website DOM may have redesigned since `verifiedAt` — inspect `browser_snapshot` and refresh via `browser_routine_save`)
   - Run a multi-step learned routine in 1 fast call (24 built-in timestamped JSON playbooks include `google.com`, `docs.google.com/document`, `docs.google.com/spreadsheets`, `mail.google.com`, `github.com`, `chatgpt.com`, `claude.ai`, `perplexity.ai`, `diagrams.net`, `youtube.com`, `wikipedia.org`, `reddit.com`, `x.com`, `linkedin.com`, `notion.so`, `arxiv.org`, `huggingface.co`, `npmjs.com`, `pypi.org`, `medium.com`, `stackoverflow.com`, `amazon.com`, `news.ycombinator.com`, `finance.yahoo.com`): `browser_routine_run({ "tabId": <TAB_ID>, "name": "<ROUTINE>", "arguments": { ... } })`
   - Discover page-registered WebMCP tools (`document.modelContext` / `<form toolname=...>`): `browser_webmcp_list({ "tabId": <TAB_ID> })` -> invoke via `browser_webmcp_call`
3. Interact (`[read-write]` only — pass `tabId` + `ref` or `locator`):
   - `browser_click`, `browser_drag`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_set_checked`
   - `browser_press_key`, `browser_scroll`, `browser_upload_file`, `browser_handle_dialog`, `browser_wait_for`
   - **Multi-Step Batch (`browser_batch`)**: execute repeated combobox searches, multi-control form setups, or chained reads in **1 single call** inside your active tab lease (`steps: [{ op, params, saveAs, optional }, ...]`), avoiding 10+ LLM roundtrips!
   - **Auto-Routine Learning**: Browser Bridge automatically distills completed multi-step workflows (stripping failed detours, promoting `ref`s to semantic `locator`s, and scrubbing secrets) into `[auto]` routines in Site Memory; element `ref`s stay stable across `locate`/`snapshot` and self-heal across same-URL SPA re-renders.
   - **Handoff & Demonstrate**: call `browser_handoff` when login, 2FA, CAPTCHA/Cloudflare, or payment is needed (pops a Continue card with `WAIT` badge); call `browser_demonstrate({ "saveAs": "..." })` to record a user demonstration directly into a reusable Site Routine!
   - **Domain Fence & Diagnostics**: use `browser_allowlist` to fence tabs to `allowedOrigins`; inspect redacted HTTP exchanges with `browser_network` and JS errors with `browser_console`.
   - **Prove a UI fix**: inspect with `browser_styles` / `browser_layout`; create a `browser_dom_baseline`; apply a bounded `browser_patch`; verify DOM/style/layout evidence; move the fix into source and roll the patch back. A patch `commit` keeps only the live document, not source.
   - **Evidence lifetime**: baseline and patch handles belong to this session and frame, expire, and do not survive navigation. Reuse the returned `frameId`. A partial baseline comparison cannot prove unchanged. Do not repeat a conflicting rollback.
   - **Network evidence**: start `browser_network`, reproduce, then call `browser_har`. Export never arms capture. Use `browser_performance` for actual browser point samples. These are not Web Vitals.
   - **Chromium-only debugging**: `browser_debugger` reads performance counters; `browser_intercept` explicitly blocks or mocks bounded requests. No arbitrary CDP is exposed. Firefox reports debugger-only mutations as unsupported.
   - **Cross-session reuse**: store locators and diagnostic recipe steps in a Routine, not live refs or handles. Bind outputs such as `{{baseline.id}}` inside each execution.
   - After discovering a faster workflow or pitfall workaround on a site, persist it via `browser_routine_save` so future tasks skip detours!
4. Capture visual screenshots or retrieve non-DRM page media (background-safe, no focus steal):
   - Save screenshot directly to disk: `browser_screenshot({ "tabId": <TAB_ID>, "fullPage": true, "path": "shot.png" })`
   - Inspect `<video>`/`<audio>` streams & progressive/HLS URLs: `browser_media({ "tabId": <TAB_ID> })`
   - Download video/audio/HLS `.m3u8` directly to disk: `browser_download({ "tabId": <TAB_ID>, "path": "video.mp4" })`

## 2. Use Python SDK (`browser-bridge`, zero subprocess overhead)
```python
from browser_bridge import BrowserBridge

with BrowserBridge(browser="<INSTANCE>") as bridge:
    page = bridge.page(<TAB_ID>)              # attaches without closing user's tab on exit
    print(page.snapshot())                    # accessibility tree
    page.get_by_role("button", name="Next").click()
    page.screenshot("shot.png", full_page=True)
    resp = page.request.get("https://...")    # authenticated in-page fetch
```

## 3. Use CLI or Direct IPC (any language, no Python needed)
- Status JSON: `"{{HOST_EXE}}" status --json`
- Recent redacted session activity (`<= 500` entries, zero query tokens): `"{{HOST_EXE}}" activity --limit 25`
- Save screenshot: `"{{HOST_EXE}}" screenshot shot.png --tab <TAB_ID> --browser <INSTANCE> --full-page`
- Stdio JSON-line RPC (`"{{HOST_EXE}}" rpc`):
  `{"id":1,"method":"page.snapshot","params":{"tabId":<TAB_ID>,"browser":"<INSTANCE>"}}`
