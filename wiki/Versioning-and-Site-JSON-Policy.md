# Versioning and Site JSON Policy

Browser Bridge follows **Semantic Versioning (`MAJOR.MINOR.PATCH`)** with a dedicated rule for **website optimization JSON playbooks (`routines/*.json`)**:

| SemVer Digit | Example | Scope |
| --- | --- | --- |
| **`MAJOR` (`X.0.0`)** | `1.0.0` | Breaking changes to Native Messaging, Named Pipe / Unix Socket IPC framing, or core MCP / Python SDK contracts |
| **`MINOR` (`0.Y.0`)** | `0.10.0` | New core engine subsystems, new MCP tools/resources/prompts, new browser extension permissions, or new SDK APIs |
| **`PATCH` (`0.10.Z`)** | `0.10.1` | **Website optimization JSON additions or updates (`routines/*.json`)**, selector drift refreshes after website redesigns, per-site latency tuning, and non-breaking bug/documentation fixes |

---

## Timestamped Site JSON Upgrade Lifecycle (`schemaVersion: 2`)

1. **Bump `PATCH` (`0.10.Z`) on Site JSON Updates:** Adding new site playbooks or tuning existing `routines/*.json` files increments the 3rd version digit across Rust, Extension, and Python manifests.
2. **Refresh ISO-8601 UTC Timestamps:** Update `"verifiedAt"` and `"updatedAt"` (`YYYY-MM-DDTHH:MM:SSZ`) plus `"speedupSummary"` after verifying against the live site.
3. **Automatic Non-Destructive Cache Merge:** When users upgrade to `0.10.Z`, `resolve_playbook` compares `seed.verifiedAt` with local `disk.updatedAt` in `<data_dir>/routines/*.json` — automatically refreshing built-in routines and `accessProfile` latency settings while keeping custom user routines, learned pitfalls, and notes untouched.
4. **Automatic `[STALE]` Drift Guard:** If a live website redesign causes `>= 2` consecutive selector or timeout failures at runtime, Browser Bridge marks that routine `[STALE - DOM may have changed]` until refreshed.
