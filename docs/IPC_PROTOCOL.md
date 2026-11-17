# Local IPC & JSON-Line RPC Wire Protocol

External SDKs in any programming language (Go, Node.js, Rust, C#, Ruby, Java, Python) can talk to Browser Bridge in two ways:

1. **Direct OS IPC (Recommended, `~1.1 ms` RTT, zero subprocess):** Connect directly to the per-profile Named Pipe (Windows) or Unix Domain Socket (macOS / Linux).
2. **Managed Stdio RPC (`BrowserBridge rpc`):** Spawn `BrowserBridge rpc` and exchange newline-delimited UTF-8 JSON objects over `stdin` / `stdout`.

---

## 1. Discovering Direct IPC Endpoints

### Windows Named Pipes
Enumerate `\\.\pipe\` for entries matching:

```text
browser-bridge.<CurrentUserSID>.<browser>.<instanceId>
```

Example:
```text
\\.\pipe\browser-bridge.S-1-5-21-123456789-1001.edge.a1b2c3d4e5f6
```

- `<browser>` is one of `edge`, `chrome`, `chromium`, `firefox`.
- `<instanceId>` is a 12-character lowercase hex profile identifier.

### macOS & Linux Unix Domain Sockets
Check `$XDG_RUNTIME_DIR/browser-bridge` first, falling back to `/tmp/bb-<uid>`:

```text
browser-bridge.<username>.<browser>.<instanceId>
```

Verify that the parent directory is owned by your `uid` before connecting.

---

## 2. Direct Pipe / Socket Framing

Each message is a **single UTF-8 JSON object terminated by `\n` (`0x0A`)**.

### Step 1: Client Handshake (`hello`)
Immediately after connecting to a pipe or socket, send a client `hello` line:

```json
{"type":"hello","clientName":"my-go-sdk","pid":48210,"subscribe":false}
```

- Set `"subscribe": true` if your client wants asynchronous `{"type":"event","event":"tabs.changed"}` push notifications.

The host responds with `bridgeHello`:

```json
{
  "type": "bridgeHello",
  "protocol": 1,
  "hostVersion": "0.7.0",
  "session": "s-1",
  "browser": {
    "browser": "edge",
    "browserVersion": "136.0",
    "extensionVersion": "0.7.0",
    "instanceId": "a1b2c3d4e5f6",
    "label": "Work"
  }
}
```

### Step 2: Sending Commands
Send command envelopes with unique integer or string `id` values:

```json
{"id":1,"method":"status","params":{}}
{"id":2,"method":"tabs.new","params":{"url":"https://example.com","active":false}}
{"id":3,"method":"page.snapshot","params":{"tabId":42,"maxChars":20000}}
```

Responses carry matching `id` values:

```json
{"id":2,"ok":true,"result":{"tabId":42,"url":"https://example.com/","title":"Example Domain","loaded":true,"status":200}}
{"id":99,"ok":false,"error":{"code":"forbidden","message":"Tab 7 is not shared with AI agents."}}
```

Closing the pipe/socket automatically releases all tab leases held by that session.

---

## 3. Stdio `BrowserBridge rpc` Mode

If your runtime lacks convenient Named Pipe bindings, spawn `BrowserBridge rpc` with UTF-8 `stdin`/`stdout`:

```json
{"id":1,"method":"bridge.connect","params":{"browser":"edge"}}
{"id":2,"method":"tabs.list","params":{}}
{"id":3,"method":"page.locate","params":{"tabId":42,"locator":{"steps":[{"kind":"role","value":"button","name":"Sign in"}]}}}
```

Host-handled methods available in `rpc` mode in addition to all extension `tabs.*` and `page.*` methods:
- `bridge.connect` — Connects and pins the target browser profile (`params.browser` optional).
- `request.fetch` — Performs an anonymous HTTP(S) request from the Rust host without browser cookies (`url`, `method`, `headers`, `body`, `timeoutMs`, `maxBytes`), returning base64 `data`, `status`, and `headers`.
- `routines.list`, `routines.run`, `routines.save` — Queries, executes, or updates Site Memory playbooks.

---

## 4. Standard Error Codes

| Error Code | Meaning |
| --- | --- |
| `not_installed` | Native host binary or registration was not found |
| `unavailable` | No matching browser profile is currently connected |
| `forbidden` | Target tab is neither user-shared nor owned by this session, or is leased by another session |
| `read_only` | Mutating command blocked by `--read-only`, Global Read-Only Lock, or `[read-only]` tab mode |
| `disabled` | Optional capability (such as `page.evaluate`) is disabled in popup settings |
| `restricted` | Browser-internal URL (`edge://`, `chrome://`, extension store) cannot be scripted |
| `no_tab` | Tab or frame was closed during the operation |
| `bad_ref` / `stale_ref` | Snapshot element ref is malformed or expired after DOM replacement; take a fresh snapshot |
| `strict_locator` | Locator matched `> 1` elements on an action/scalar read; narrow with `.first`, `.nth`, or `.filter` |
| `not_actionable` | Element is hidden, disabled, zero-size, or covered by another element (for example a modal overlay) |
| `timeout` | Readiness condition or navigation did not complete within `timeoutMs` |
| `truncated` | Scalar or bulk read exceeded `maxChars` / item bounds |
| `body_too_large` | Binary/HTTP fetch exceeded `maxBytes` (default 20 MiB, max 32 MiB) |
