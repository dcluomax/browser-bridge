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
2. **Stamp Fresh ISO-8601 UTC Timestamps & Field-Level Provenance (`seed` / `learned` / `user`)**:
   - Update top-level `"verifiedAt"`, `"updatedAt"`, `"updatedAtEpochS"`, and per-routine `"verifiedAt"` / `"updatedAt"` in UTC (`YYYY-MM-DDTHH:MM:SSZ`) after live browser verification.
   - During upgrade (`BrowserBridge install` and runtime `resolve_playbook`), Browser Bridge merges profile fields using explicit field-level provenance (`seed`, `learned`, `user`) alongside `seed.verifiedAt` vs. cached `disk.updatedAt`:
     - `user`-provenance overrides, custom user routines, and domain notes always take precedence and are never overwritten.
     - When `seed.verifiedAt > disk.routine.updatedAt`, outdated built-in `seed` routine selectors refresh automatically.
     - When `seed.verifiedAt >= disk.updatedAt`, tuned `seed` `accessProfile` fields (`preferredWaitUntil`, `hydrationSettleMs` upper cap, `preferredSnapshotFrames`, etc.) refresh stale `seed` and expired/regressed `learned` parameters cleanly without letting transient mid-benchmark writes shadow curated seeds.
3. **Pass the Mandatory `PATCH` (`x.y.Z`) Empirical Release Gate (`scripts/check-routine-gate.py`)**:
   - Every `routines/*.json` addition, selector refresh, or `accessProfile` latency tune must validate **both** static playbook hygiene and multi-trial empirical non-regression before tagging `v0.10.Z` / `v0.11.Z`:
     1. **Static Schema & Hygiene Audit**: `schemaVersion == 2`, valid ISO-8601 UTC `verifiedAt`/`updatedAt`, ordered `preferredWaitUntil` (`"commit"`, `"domcontentloaded"`, `"load"`, or unset), bounded `0 <= hydrationSettleMs <= 600` (used strictly as the upper timeout cap for `waitForDomQuiet`), non-empty routine `steps`, and zero unsanitized identifiers.
     2. **Empirical `N >= 20` Interleaved Frozen-Profile Gate (`_noLearn: true`)**: Run `N >= 20` randomized interleaved trials per modified site with learner writes frozen (`_noLearn: true`) so baseline probes never mutate the profile under test, verifying:
        - Success rate `>= 95%`;
        - Content completeness `>= 80%` median extracted characters relative to the `load` (`S1`) baseline (preventing unhydrated empty shells from passing as "speedups");
        - Post-network latency non-regression vs. zero-config engine defaults (`S2`): `p50` regression `<= +10%` and `p95` regression `<= +15%` (exempting sites where `S2` itself violates the `< 80%` content floor and the `S3` profile restores `>= 80%` content, e.g., SPA hydration waits).
   - Command:
     ```bash
     PYTHONPATH=python python scripts/benchmark-sites.py --compare-unoptimized --trials 20 --interleave --json-out benchmark-report.json
     python scripts/check-routine-gate.py --routines-dir routines --benchmark-json benchmark-report.json
     ```
4. **Record Measured Multi-Trial Speedups**:
   - Include a factual `"speedupSummary"` in each `routines/*.json` file (distinguishing engine mitigations, quality-constrained `SiteLearner` v2 readiness, and 1-call routines) and document measured `p50`/`p95` latency and content completeness in `CHANGELOG.md`, `README.md`, and `README.zh-CN.md`.
5. **Verification & Release Flow**:
   - Run the full verification gate (`npm test` covering sanitization, SVG layout bounds, TypeScript, 71+ extension tests, and Rust workspace tests, plus `python -m unittest discover -s python/tests -v` and `python scripts/check-routine-gate.py --routines-dir routines`).
   - Commit and push `main` and annotated tag `v0.10.Z` to trigger GitHub Actions CI, Wiki Sync, and the multi-platform prebuilt Release pipeline.
