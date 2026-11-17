# Contributing to Browser Bridge

Thank you for contributing to Browser Bridge! This guide covers workspace layout, local builds, testing, security hygiene, and pull request expectations.

---

## Development Prerequisites

- **Rust** `1.85+` (`rustup component add clippy rustfmt`)
- **Node.js** `20+` and `npm`
- **Python** `3.10+` (for SDK unit tests and real-browser E2E suites)

---

## Workspace Structure

```text
browser-bridge/
├── extension/                  # TypeScript + React 19 + Astryx cross-browser extension
│   ├── src/background/         # Service worker / background host, tab grants, CDP, WebMCP, commands
│   ├── src/content/            # On-demand isolated-world DOM snapshot/locator engine + MAIN-world WebMCP
│   ├── src/popup/              # Toolbar popup UI & agent prompt builder
│   ├── src/shared/             # Wire protocol, locators, key combos & i18n
│   └── test/                   # Node test runner unit suites
├── rust/
│   └── crates/
│       ├── bridge-core/        # Named Pipe / Unix Socket IPC, Native Messaging, HTTP, SiteLearner
│       └── browser-bridge/     # Standalone Native Host, MCP server, stdio RPC, installer & CLI
├── python/                     # Pure-Python zero-dependency SDK (`browser_bridge`)
├── e2e/                        # Real-browser MCP + Python SDK integration test harness
├── scripts/                    # Turnkey installers, uninstallers & sanitization audit
├── docs/                       # Usage, feature, MCP client, security & IPC protocol docs
└── wiki/                       # GitHub Wiki source pages (synced on push to main)
```

---

## Building & Running Tests Locally

Install extension dependencies once:

```bash
cd extension
npm ci
cd ..
```

Run the full fast verification suite from the repository root:

```bash
# Runs sanitization check + TypeScript check + Extension tests + Rust workspace tests
npm test

# Run Python SDK unit tests
python -m unittest discover -s python/tests -v

# Build unpacked extensions + release Rust binary
npm run build

# Lint the Firefox MV2 bundle with Mozilla web-ext
npm --prefix extension run lint:firefox
```

### Real-Browser End-to-End Tests

After running `./scripts/install.sh` or `.\scripts\install.ps1` once to register the native transport:

```bash
node e2e/run.mjs --browser edge --host rust/target/release/BrowserBridge
# Also supports: --browser chrome | chromium | firefox, plus --headful
```

The E2E harness launches a throwaway browser profile with local HTTP fixtures — it never touches your live browser profile or shared tabs.

---

## Security & Sanitization Rules

1. **Zero network ports** — Never introduce a localhost HTTP/WebSocket listener in the host or extension.
2. **Preserve 3-layer Read-Only gates** — Any new mutating command or tool must be gated in `Commands.isReadSafeMethod`, `TabRegistry.requireTabWrite`, and `mcp.rs` `read_only` mode.
3. **Never leak personal/machine paths or internal registries** — Always run `npm run sanitize:check` before committing. Ensure `package-lock.json` resolves exclusively against `https://registry.npmjs.org/`.
4. **Cross-platform line endings** — Keep `.sh` files LF-terminated (`.gitattributes` enforces this automatically).

---

## Submitting a Pull Request

1. Fork the repository and create a focused topic branch (`feat/...`, `fix/...`, `docs/...`).
2. Add or update unit tests covering your change in `extension/test/`, `rust/crates/*/src/`, or `python/tests/`.
3. Update relevant documentation in `README.md`, `docs/`, and `wiki/` when adding tools, flags, or protocol fields.
4. Confirm `npm test` and `python -m unittest discover -s python/tests -v` pass cleanly.
