# Security and Privacy Model

Browser Bridge operates inside your **real daily browser**, so security boundaries are enforced in native code and extension storage rather than relying solely on LLM prompt instructions.

---

## Security Invariants Summary

| Threat Vector | How Browser Bridge Mitigates It |
| --- | --- |
| **Malicious websites probing localhost ports** | **Zero TCP/WebSocket ports** are opened anywhere. Web pages cannot connect to Named Pipes or Unix Domain Sockets. |
| **Other OS users on a shared machine** | Windows Named Pipes carry a `CurrentUserOnly` DACL keyed by Windows SID; Unix sockets reside in a `0700` UID-verified directory with `0600` permissions. |
| **Unauthorized browser extensions launching the host** | Native Messaging manifests pin `allowed_origins` (`chrome-extension://<id>/`) and `allowed_extensions` (`browser-bridge@dcluomax.github.io`). |
| **Agents snooping unrelated personal tabs** | `Let agents use any tab` is **off** by default; unshared tabs are invisible to `tabs.list` and rejected with `forbidden`. |
| **Cross-origin tab hijack across extension reload** | Persisted user grants store the shared tab's `origin`; if the tab navigated cross-origin while unloaded, the grant is discarded. |
| **Concurrent agents colliding on one tab** | Exclusive per-session tab lease: only one session can read/act on a tab at a time; leases release automatically on disconnect. |
| **Unintended clicks/submissions on production dashboards** | **3-Layer Read-Only ACL:** `--read-only` MCP flag, Popup Global Read-Only Lock, and per-tab `[read-only]` mode. |
| **Credential & token leakage into LLM context** | Password inputs are masked; `Authorization`, `Cookie`, `Set-Cookie`, API keys, Bearer tokens, and JWTs are redacted as `[REDACTED]`; cookies are never exported. |
| **Arbitrary page JavaScript execution** | `browser_evaluate` is **dual-gated** (off by default in both MCP server CLI args and browser popup settings). |

---

## Reporting Security Issues

If you discover a bypass of any boundary above, please report it privately through **[GitHub Security Advisories](https://github.com/dcluomax/browser-bridge/security/advisories/new)** rather than opening a public issue.
