# Contributing and Development

Contributions are welcome! Below is the complete developer workflow for building, testing, and verifying Browser Bridge across all three components.

---

## Local Setup & Fast Test Loop

```bash
# 1. Install extension build/test dependencies
cd extension && npm ci && cd ..

# 2. Run the full verification gate (Sanitization + Typecheck + Extension tests + Cargo tests)
npm test

# 3. Install and test the zero-dependency Python SDK
python -m pip install ./python
python -m unittest discover -s python/tests -v

# 4. Build unpacked extensions + Rust release binary
npm run build
```

---

## Running Real-Browser End-to-End Suites

Once the native host registration is installed (`.\scripts\install.ps1` or `./scripts/install.sh`), run the automated real-browser harness against Edge, Chrome, Chromium, or Firefox:

```bash
node e2e/run.mjs --browser edge --host rust/target/release/BrowserBridge
node e2e/run.mjs --browser firefox --host rust/target/release/BrowserBridge
# Add --headful to watch the throwaway browser window interactively
```

The harness starts a local fixture HTTP server (`127.0.0.1:<ephemeral>`) and verifies 36 MCP end-to-end assertions (Shadow DOM, cross-origin iframes, password masking, form submission, `contenteditable`, delayed waits, background element/full-page screenshots, MCP resources/prompts, `diagrams.net` routines, stale ref rejection, tab isolation) plus the full Python SDK integration suite (direct IPC vs `rpc` parity, chained locators, adaptive `SiteLearner` beacon bypass, blocker recovery learning, `403` WAF `smart_fetch`, and streaming binary bounds).

---

## Sanitization & Secret Hygiene Gate

Before opening a pull request, always run:

```bash
npm run sanitize:check
```

`scripts/check-sanitized.mjs` runs automatically in CI (`.github/workflows/ci.yml`) to guarantee that personal paths, private domains, internal package registries, credentials, or unwanted trailers never enter the repository.

---

## Synchronizing Wiki Documentation

Pages under `wiki/` in the main repository are automatically mirrored to the GitHub Wiki (`browser-bridge.wiki.git`) by `.github/workflows/wiki-sync.yml` whenever changes land on `main`. Edit files in `wiki/` as part of normal pull requests!
