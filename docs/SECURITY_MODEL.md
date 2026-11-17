# Security & Privacy Model

Browser Bridge is designed from the ground up to operate safely inside a developer's **real daily browser** without weakening browser sandboxes, opening network ports, or exfiltrating credentials.

---

## 1. Zero Network Surface (OS-Authenticated Local IPC Only)

Most browser-automation bridges start a local HTTP or WebSocket server (for example `127.0.0.1:9222`), which creates cross-origin / DNS-rebinding / multi-user localhost risks.

Browser Bridge opens **zero TCP or UDP sockets**:
- **Browser ↔ Native Host:** Browser-managed `stdio` Native Messaging (`io.github.dcluomax.browser_bridge`). Only the pinned Chromium extension ID (`allowed_origins`) and Firefox add-on ID (`allowed_extensions`) can launch the host.
- **MCP / SDK Client ↔ Native Host:**
  - **Windows:** Named Pipe `\\.\pipe\browser-bridge.<User-SID>.<browser>.<instance>` created with an explicit Windows Security Descriptor (`CurrentUserOnly` DACL + `FILE_FLAG_FIRST_PIPE_INSTANCE`). Other local accounts and untrusted sandboxes are denied by the OS kernel.
  - **macOS / Linux:** Unix Domain Socket inside `$XDG_RUNTIME_DIR/browser-bridge` (or `/tmp/bb-<uid>`) verified to be owned by the current `uid` with directory mode `0700` and socket mode `0600`.
- **Bounded Framing:** IPC line length and per-session message queues are strictly bounded so a misbehaving client cannot exhaust host memory.

---

## 2. Explicit Opt-In Tab Visibility & Exclusive Leases

1. **Default-Deny Tab Visibility:** When you install Browser Bridge, **zero existing tabs are visible** to AI agents (`Let agents use any tab` is **off** by default).
2. **Scoped User Grants:** Clicking **Share** in the toolbar popup (or context menu) grants access to that specific `tabId` bound to its current **origin**. If the extension reloads after an update, user-shared tabs are restored only if their origin still matches; cross-origin navigation while unloaded drops the grant.
3. **Exclusive Per-Session Lease:** At most one agent session owns control of a tab at a time. While Session A acts on a user-shared tab, `tabs.inventory` shows the tab as `busy: true, controllable: false` to Session B, and any read/write attempt by Session B returns `forbidden` until Session A disconnects. Private tabs opened by Session A remain completely hidden from Session B.

---

## 3. Three-Layer Read-Only / Read-Write Access Control

Any mutation (`click`, `drag`, `type`, `fill`, `select`, `check`, `press`, `upload`, `navigate`, `tabs.new`, `tabs.close`, `evaluate`, or non-read-only WebMCP/routine execution) must pass all three gates:

1. **Layer 1 — Host Startup Gate:** `BrowserBridge mcp --read-only` (or `BROWSER_BRIDGE_READ_ONLY=1`).
2. **Layer 2 — Profile Popup Gate:** **Global Read-Only Lock** switch in the Browser Bridge popup.
3. **Layer 3 — Per-Tab Grant Mode:** Individual tab mode (`read` vs `write`). New popup shares default cleanly to explicit mode selection and can be toggled between `Read-Only` and `Read-Write` in real time.

### Session & Per-Tab Origin Fencing (`browser_allowlist` / `allowedOrigins`)

Agents can additionally fence their session or individual tabs to an explicit allowlist of origins, bare hosts, or `*.domain.com` subdomain wildcards (`browser_allowlist` or `browser_tabs(action="new", allowedOrigins=[...])`). Cross-origin navigations, HTTP redirects, and child popups outside `allowedOrigins` are blocked immediately at the extension `webNavigation` boundary without prefix-spoofing vulnerabilities.

---

## 4. Credential, Cookie & Header Protection

- **Passwords Stay Masked:** `browser_snapshot`, `browser_get_element`, and `page.queryAll` never return `<input type="password">` values or raw password `value` attributes.
- **No Cookie Export:** `page.request` executes inside the authorized tab honoring normal browser CORS rules; `browser.request` runs in the Rust host with **no cookie jar**. Cookies are never serialized or exported to MCP clients or Python scripts.
- **Automatic Diagnostic Redaction:** Sensitive headers (`Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, `X-CSRF-Token`, etc.), sensitive form keys (`password`, `secret`, `token`, `otp`, `cvv`, etc.), Bearer tokens, and JWTs (`eyJ...`) are automatically replaced with `[REDACTED]`.
- **Restricted Browser Surfaces:** `chrome://`, `edge://`, `about:*` (except `about:blank`), `moz-extension://`, `view-source:`, and official browser extension web stores are blocked from scripting and sharing.

---

## 5. Dual-Gated Arbitrary JavaScript (`browser_evaluate`)

Standard automation (`snapshot`, `locate`, `click`, `type`, `fill_form`, `screenshot`, `page.request`, `webmcp`) works in an isolated extension content world without arbitrary page-script execution.

`browser_evaluate` is **disabled by default** behind two independent gates:
1. The operator must pass `--allow-evaluate` in the MCP client configuration.
2. The user must explicitly turn on **Allow agents to run page scripts** in that browser profile's popup.

---

## 6. Human-in-the-Loop & Non-Goals

- **No Anti-Bot / No Stealth Evasion:** Browser Bridge is **not** a scraping-evasion, fingerprint-spoofing, or CAPTCHA-solving tool. Chromium displays its standard *"Browser Bridge started debugging this browser"* banner whenever `chrome.debugger` trusted input is attached; dismissing that banner turns Trusted Input off cleanly.
- **Human Handoff for Authentication & Consequential Actions (`browser_handoff` & `browser_demonstrate`):** Built-in MCP instructions (`INSTRUCTIONS` and `docs/AGENT.md`) direct agents to call `browser_handoff` whenever logins, MFA/2FA prompts, Cloudflare/CAPTCHA walls (auto-detected with `suggestHandoff: true`), or payments appear. `browser_handoff` renders a tamper-proof closed-ShadowRoot Continue card (`WAIT` badge) and pauses until the user clicks **Continue**. When recording workflows via `browser_demonstrate` (or Popup **Teach Routine**), password and OTP fields are strictly ignored and never stored.
