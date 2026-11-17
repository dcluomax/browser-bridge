# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| `0.7.x` | :white_check_mark: Yes |
| `< 0.7.0` | :x: Upgrade to `0.7.x` |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use **[GitHub Private Vulnerability Reporting](https://github.com/dcluomax/browser-bridge/security/advisories/new)** on this repository to submit a confidential report directly to [@dcluomax](https://github.com/dcluomax).

Please include:
1. Affected component (`extension/`, `rust/crates/bridge-core`, `rust/crates/browser-bridge`, `python/`, or installer scripts).
2. Operating system, browser name/version, and `BrowserBridge --version`.
3. Minimal reproduction steps or proof-of-concept demonstrating impact across a security boundary.

You can expect an initial acknowledgement within **72 hours** and coordinated disclosure once a fix is released.

## Security Boundary Scope

Browser Bridge treats the following invariants as security-critical:
- **Zero network listeners:** No TCP/UDP/WebSocket port is opened by the native host or MCP server.
- **OS user isolation:** Windows Named Pipes enforce `CurrentUserOnly` DACLs; Unix domain sockets enforce `0700` runtime directory ownership and `0600` socket permissions.
- **Native Messaging origin pinning:** Only the configured Chromium extension ID and Firefox add-on ID are permitted in native host manifests.
- **Explicit tab authorization:** Unshared browser tabs cannot be listed, read, screenshotted, or mutated unless the user explicitly enables `Let agents use any tab`.
- **Three-layer Read-Only enforcement:** `--read-only`, Global Read-Only Lock, and per-tab `[read-only]` mode block mutating commands in both the host and extension.
- **Credential masking & no cookie export:** `<input type="password">` values and sensitive headers/tokens (`Authorization`, `Cookie`, `Set-Cookie`, Bearer, JWT) are masked/redacted and never exported outside the browser.

See **[docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md)** for full architectural details.
