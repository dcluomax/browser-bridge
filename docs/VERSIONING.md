# Versioning & Site-Optimization Update Specification

Browser Bridge follows **Semantic Versioning (`MAJOR.MINOR.PATCH`)** with a clear separation between **core engine/protocol evolution** and **website optimization JSON updates (`routines/*.json`)**:

| Version Segment | Example | When to Increment |
| --- | --- | --- |
| **1st — `MAJOR` (`X.0.0`)** | `1.0.0` | Incompatible changes to the Native Messaging wire protocol, Named Pipe / Unix Socket IPC frame format, or core MCP / SDK contracts. |
| **2nd — `MINOR` (`0.Y.0`)** | `0.10.0` | New core engine capabilities, new MCP tools/resources/prompts, new browser extension permissions (for example `tabGroups`), or new SDK APIs. |
| **3rd — `PATCH` (`0.10.Z`)** | `0.10.1` | **Adding or updating website optimization JSON playbooks (`routines/*.json`)**, refreshing selectors/routines after website DOM redesigns, per-site latency parameter tuning, non-breaking bug fixes, and documentation updates. |

---

## Rules for Updating Website Optimization JSONs (`routines/*.json`)

1. **Always Increment the 3rd Version Digit (`PATCH`, `x.y.Z`)**:
   - Whenever adding new websites or refreshing existing site routines/latency profiles in `routines/*.json`, increment the **3rd SemVer digit** across `package.json`, `rust/Cargo.toml`, `extension/package.json`, `extension/package-lock.json`, `extension/src/content/content.ts`, `extension/src/background/page.ts`, `extension/src/popup/PopupApp.tsx`, and `python/pyproject.toml`.
2. **Stamp Fresh ISO-8601 UTC Timestamps (`verifiedAt` & `updatedAt`)**:
   - Update top-level `"verifiedAt"`, `"updatedAt"`, `"updatedAtEpochS"`, and per-routine `"verifiedAt"` / `"updatedAt"` in UTC (`YYYY-MM-DDTHH:MM:SSZ`) after live browser verification.
   - During upgrade (`BrowserBridge install` and runtime `resolve_playbook`), Browser Bridge compares `seed.verifiedAt` against any cached local `disk.updatedAt`:
     - When `seed.verifiedAt > disk.routine.updatedAt`, outdated built-in routine selectors refresh automatically.
     - When `seed.verifiedAt >= disk.updatedAt`, tuned `accessProfile` latency settings (`preferredWaitUntil`, `hydrationSettleMs`, `snapshotFrames`, etc.) upgrade automatically.
     - Newer user-created custom routines, learned pitfalls, and domain notes are always preserved intact.
3. **Record Measured Speedups**:
   - Include a factual `"speedupSummary"` in each `routines/*.json` file and document measured before/after latency in `CHANGELOG.md`, `README.md`, and `README.zh-CN.md`.
4. **Verification & Release Flow**:
   - Run the full verification gate (`npm test` covering sanitization, SVG layout bounds, TypeScript, 71+ extension tests, and Rust workspace tests, plus `python -m unittest discover -s python/tests -v`).
   - Commit and push `main` and annotated tag `v0.10.Z` to trigger GitHub Actions CI, Wiki Sync, and the multi-platform prebuilt Release pipeline.
