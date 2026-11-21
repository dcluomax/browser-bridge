# Versioning & Site-Optimization Update Specification

Browser Bridge follows **Semantic Versioning (`MAJOR.MINOR.PATCH`)** with an explicit separation between **core engine/protocol evolution** and **website optimization JSON updates (`routines/*.json`)**:

| Version Segment | Example | When to Increment |
| --- | --- | --- |
| **1st — `MAJOR` (`X.0.0`)** | `1.0.0` | Incompatible changes to the Native Messaging wire protocol, Named Pipe / Unix Socket IPC frame format, or core MCP tool contracts. |
| **2nd — `MINOR` (`0.Y.0`)** | `0.12.0` | New core engine capabilities (e.g. `browser_media` / `browser_download` HLS fMP4 video building blocks, zero-collision O(1) multi-browser `tabId` routing & cloned-profile self-healing, Auto-Routine distillation, `browser_batch`), new MCP tools/resources/prompts, new browser extension permissions, or new SDK APIs. |
| **3rd — `PATCH` (`0.11.Z`)** | `0.11.1` | **Adding or updating website optimization JSON playbooks (`routines/*.json`)**, refreshing selectors/routines after website DOM redesigns, site-specific speed tuning, bug fixes, and documentation updates. |

## Rules for Updating Website Optimization JSONs (`routines/*.json`)

1. **Always Bump the 3rd Version Number (`PATCH`)**:
   - Whenever adding new websites or refreshing existing site routines in `routines/*.json`, increment the 3rd SemVer digit across `rust/Cargo.toml`, `extension/package.json`, `extension/src/content/content.ts`, `extension/src/background/page.ts`, and `python/pyproject.toml`.
2. **Stamp Fresh ISO-8601 UTC Timestamps & Field-Level Provenance (`seed` / `learned` / `user`)**:
   - Update top-level `"verifiedAt"`, `"updatedAt"`, `"updatedAtEpochS"`, and per-routine `"verifiedAt"` / `"updatedAt"` in UTC (`YYYY-MM-DDTHH:MM:SSZ`) after live browser verification.
   - During upgrade, `resolve_playbook` merges fields using explicit field-level provenance (`seed`, `learned`, `user`) alongside `seed.verifiedAt` vs. cached `disk.updatedAt`: `user` overrides and custom routines always win, while newer `seed.verifiedAt` releases refresh outdated `seed` selectors and expired/regressed `learned` latency settings without letting transient runtime writes shadow curated seeds.
3. **Pass the Mandatory `PATCH` (`x.y.Z`) Empirical Release Gate (`scripts/check-routine-gate.py`)**:
   - Every `routines/*.json` addition or selector/profile tune must validate `schemaVersion: 2` hygiene (`preferredWaitUntil` in `commit < domcontentloaded < load`, `0 <= hydrationSettleMs <= 600` as the upper cap for `waitForDomQuiet`, valid UTC timestamps, zero unsanitized strings) **plus** `N >= 20` randomized interleaved frozen-profile trials (`_noLearn: true`) confirming `>= 95%` success rate, non-regression on `p50` (`<= +10%`) / `p95` (`<= +15%`) vs. engine-only `S2` (exempting sites where `S2` fails `< 80%` content completeness and `S3` restores `>= 80%` content), and `>= 80%` content completeness vs. `load` baseline:
     ```bash
     PYTHONPATH=python python scripts/benchmark-sites.py --compare-unoptimized --trials 20 --interleave --json-out benchmark-report.json
     python scripts/check-routine-gate.py --routines-dir routines --benchmark-json benchmark-report.json
     ```
4. **Record Measured Multi-Trial Speedups**:
   - Include a factual `"speedupSummary"` in each site JSON and document measured `p50`/`p95` latency and content completeness in `CHANGELOG.md` and `README.md`.
5. **Sanitize-First Release Flow (Mandatory Order)**:
   - Validate all unit tests (`cargo test`, `extension` `npm test`, `python` `unittest`) and live browser E2E (`node e2e/run.mjs`) locally first.
   - **Always sanitize and pass `node scripts/check-sanitized.mjs` BEFORE pushing to any remote repository** — stage and verify the sanitized open-source build (`browser-bridge-oss`) first so private identifiers, internal mirrors, or unverified artifacts are never pushed prematurely, then push the verified release.
