# Upgrade Notes — Migrating from `v0.7.0` / `v0.10.x` / `v0.11.x` / `v0.12.0` to `v0.13.1`

**Browser Bridge `v0.13.1`** is a backward-compatible feature and installer-hardening release (`Protocol v1`) delivering **Structured Live-Tab Diagnostics & Reversible Temporary Patches ([`docs/DEBUGGING.md`](DEBUGGING.md))**, **Verified Deterministic Packaging, Transactional Installs & Safe Rollback/Updates ([`docs/INSTALLATION.md`](INSTALLATION.md))**, **Zero-Collision Sub-Millisecond Multi-Browser & Multi-Profile Auto-Routing**, **Zero-Dependency Streaming Media Discovery & HLS/fMP4 Downloader (`browser_media` / `browser_download`)**, **Quality-Constrained `SiteLearner` v2 (`waitForDomQuiet`)**, and **24 timestamped `schemaVersion: 2` site optimization JSON playbooks (`routines/*.json`)**.

---

## 1. Quick Upgrade Steps (60 Seconds)

### Option A: One-Prompt / Zero-Build Prebuilt Upgrade (Recommended)

Paste this prompt into **GitHub Copilot**, **Claude Code**, **Cursor**, **Windsurf**, or **Cline**:

```text
Upgrade Browser Bridge to the latest release (v0.13.1) by following https://raw.githubusercontent.com/dcluomax/browser-bridge/main/docs/INSTALL.md — verify SHA-256 checksums, update BrowserBridge + unpacked extensions + 24 timestamped routines, and confirm `BrowserBridge status` and `BrowserBridge routines` report v0.13.1.
```

Or run the one-line terminal bootstrapper directly:

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.ps1 | iex
```

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.sh | bash
```

### Option B: Upgrade from Local Source Checkout

**Windows (PowerShell):**

```powershell
git pull origin main
.\scripts\install.ps1 -RegisterAllMcp -InstallPythonSdk
```

**macOS / Linux:**

```bash
git pull origin main
./scripts/install.sh --register-all --install-python
```

### Required Browser Step: Click Reload (`↻`) Once

1. Open `edge://extensions` or `chrome://extensions` (or `about:debugging#/runtime/this-firefox` in Firefox).
2. Click the **Reload (`↻`)** icon on the **Browser Bridge** card so your browser loads the `0.10.0` background worker and content engine (`CONTENT_VERSION = '0.10.0'`).
3. **New Chromium `tabGroups` Permission**: Chromium browsers may prompt to approve the new `tabGroups` permission, which allows Browser Bridge to place background agent tabs inside a collapsed `[Agent]` group without stealing window focus. Accept the prompt if shown.
4. Reconnect your MCP client (or start a fresh chat session) so your AI agent discovers the 5 new MCP tools.

Verify your upgrade from a terminal:

```bash
# Windows
"%LOCALAPPDATA%\BrowserBridge\app\BrowserBridge.exe" status
"%LOCALAPPDATA%\BrowserBridge\app\BrowserBridge.exe" routines

# macOS / Linux
~/.browser-bridge/app/BrowserBridge status
~/.browser-bridge/app/BrowserBridge routines
```

---

## 2. How Timestamped `routines/*.json` Auto-Upgrade & `PATCH` (`0.10.Z`) Versioning Work

Per **[`docs/VERSIONING.md`](VERSIONING.md)**, Browser Bridge separates engine/protocol evolution from website playbook updates:
- **3rd SemVer digit (`PATCH`, `0.10.Z`)**: Always incremented when adding or updating `routines/*.json` website optimization playbooks, refreshing selectors after website redesigns, or tuning per-site latency settings.
- **2nd SemVer digit (`MINOR`, `0.Y.0`)**: Incremented for new core engine capabilities, new MCP tools/permissions, or new SDK APIs.
- **1st SemVer digit (`MAJOR`, `X.0.0`)**: Incremented only on breaking wire-protocol or core contract changes.

In **`v0.10.1`**, Browser Bridge ships **24 git-tracked, timestamped JSON site-optimization playbooks** (`routines/*.json`, `schemaVersion: 2`):

1. **ISO-8601 UTC Timestamps (`verifiedAt` & `updatedAt`)**:
   - Every file in `routines/*.json` and every individual `RoutineDefinition` carries `verifiedAt` and `updatedAt` plus `speedupSummary`.
2. **Non-Destructive Upgrade Merge (`seed.verifiedAt >= disk.updatedAt`)**:
   - During `BrowserBridge install` and runtime `resolve_playbook`, built-in routines with a newer `verifiedAt` automatically replace outdated local selectors, and `seed.verifiedAt >= disk.updatedAt` also upgrades cached `accessProfile` latency parameters — while **preserving all custom user routines, learned pitfalls, and domain notes**.
3. **Automatic Website-Redesign Drift Guard (`[STALE]`)**:
   - Whenever any routine hits **`>= 2` consecutive selector or timeout failures**, Browser Bridge marks `stale: true` with `staleReason` (`[STALE - DOM may have changed]`) so agents inspect a fresh `browser_snapshot` and update it via `browser_routine_save`.
4. **Multi-App Path Isolation, Aliases & URL Variables**:
   - Multi-product hosts are cleanly isolated (`docs.google.com/document` vs `docs.google.com/spreadsheets`).
   - Friendly aliases work out of the box: `google-docs`, `google-sheets`, `google-excel`, `gmail`, `chatgpt`, `claude`, `perplexity`, `notion`, `hf`, `npm`, `pypi`, `arxiv`, `linkedin`, `medium`, `google`, `drawio`, `twitter`, `hn`.
   - Routine steps support `op: "fetch"` (`stripHtml: true`), `{{query:urlencode}}`, Python `**kwargs` invocation, and live URL variables (`{{url.docId}}`, `{{url.gid}}`, `{{url.repo}}`, `{{url.arxivId}}`, `{{url.cleanPath}}`, `{{url.origin}}`, `{{url.href}}`).

---

## 3. Network-Excluded Speedup Summary (`Unoptimized` vs `v0.10.1`)

Measurements exclude HTML network download time via W3C `PerformanceNavigationTiming.responseEnd` (`navigationTiming.networkMs`, reproducible with `PYTHONPATH=python python scripts/benchmark-sites.py --compare-unoptimized`):

| Website & Playbook JSON | Non-Network Bottleneck Solved | Unoptimized *(Excl. Network)* | `v0.10.1` *(Excl. Network)* | Warm `0-Net` Read / Action | Net-Excluded Gain |
| --- | --- | --- | --- | --- | --- |
| **Perplexity** (`perplexity.ai.json`) | SSE stream hangs MV3 `document_idle` | `18,945–29,000 ms` | **`~450–840 ms`** (`injectImmediately`) | **`4–7.8 ms`** snap | **>2,400× (`0-Net`) / ~35×** |
| **Medium** (`medium.com.json`) | Google One-Tap GSI + iframe hang | `23,163 ms` (`12,825 ms` `0-Net` snap) | **`586 ms`** | **`5.7–7 ms`** snap | **>1,800× (`0-Net`) / 39×** |
| **Google Sheets / Excel** (`docs.google.com__spreadsheets.json`) | `<canvas>` grid & UI coordinate detours | `8,077 ms` (`0-Net` detours) | **`~200 ms`** | **`180–259 ms`** cell R/W · **`~201–325 ms`** CSV | **31×–45× (`0-Net`)** |
| **Google Search** (`google.com.json`) | Stalled `onload` beacons + ad iframes | `~14,978 ms` | **`532 ms`** | **`36 ms`** snap · **`41 ms`** `read_results` | **28× post-net** |
| **Google Docs** (`docs.google.com__document.json`) | `0`-text Kix `<canvas>` + sync `onload` | `~6,690 ms` + `0 chars` `<canvas>` | **`~350 ms`** | **`10 ms`** `0-Net` `DOCS_modelChunk` · **`~170 ms`** `/mobilebasic` | **`10 ms` `0-Net` Canvas** |
| **arXiv** (`arxiv.org.json`) | MathJax/font `onload` stall + PDF friction | `~10,100 ms` | **`~550 ms`** | **`12 ms`** `read_abstract` + `{{url.arxivId}}` HTML | **18× post-net** |
| **PyPI** (`pypi.org.json`) | External badge/ad script `onload` stall | `~7,320 ms` | **`491 ms`** | **`15.4 ms`** snap · **`40–50 ms`** `read_package_docs` | **14.9× post-net** |
| **LinkedIn & Gmail** (`linkedin.com.json`, `mail.google.com.json`) | Multi-hop `3xx`/client redirect + `/bind` poll | `>8,500 ms` stall | **`~450–950 ms`** | **`6–29 ms`** snap + safe `draft_compose` | **~10×–18× post-net** |
| **Yahoo Finance & Amazon** (`finance.yahoo.com.json`, `amazon.com.json`) | 20+ ad iframes + soft-gate wall | `~7,500–14,500 ms` | **`~350–950 ms`** | **`51 ms`** `read_quote_summary` | **11.5×–140×** |
| **GitHub, HF, npm & Notion** (4 JSONs) | 200+ header links truncating `<main>` | `1,900–2,800 ms` + truncated | **`~120–350 ms`** | **`13 ms`** npm · **`18 ms`** HF · **`50 ms`** GitHub/Notion | **13–50 ms `0-Net`** |
| **ChatGPT & Claude** (`chatgpt.com.json`, `claude.ai.json`) | Clipped composer + fixed `5–15 s` sleeps | Clipped input + blind polling | **`~200–350 ms`** | **`35–37 ms`** read · **`117 ms`** draft · Stop-btn wait | **Deterministic** |
| **Reddit, X, draw.io, Wiki, HN, SO & YouTube** (7 JSONs) | `shreddit-*` virtualization, `#fragment` `30s` timeout, `border=0` tables, `#cite_note`, OneTrust, Polymer | `8,000–30,000 ms` stalls / truncation | **`~250–650 ms`** | **`5 ms`** X · **`32 ms`** HN · **`52 ms`** Wiki · **`99 ms`** Reddit JSON · **`660 ms`** draw.io XML | **Zero timeouts** |

---

## 4. Behavioral Changes to Note

- **`browser_tabs(action="new")` & `browser.new_page(...)` Now Open Silently in Background**:
  - `active` defaults to `false` (`False` in Python) so opening tabs never steals keyboard/window focus while you work. Pass `active: true` (`active=True`) only when you explicitly want the new tab brought to the foreground.
  - On Chromium browsers, agent-opened tabs are automatically grouped into a collapsed **`[Agent]`** tab group (toggleable in Popup **Settings → Collapse agent tabs in background group**).
  - Unnamed idle agent-opened tabs automatically close after **10 minutes** of inactivity (configurable to `10m`, `30m`, `60m`, or `Never` in Popup Settings; tabs you shared manually and named tabs created with `name="..."` are never auto-closed).
- **5 New MCP Tools**:
  - `browser_handoff`: Displays a floating Continue card (`WAIT` badge) for human-only steps (login, MFA, CAPTCHA, payment) and resumes automatically once you click **Continue**.
  - `browser_demonstrate`: Records a workflow you demonstrate on the page (never recording passwords or OTP inputs) and saves it straight into `Site Memory`.
  - `browser_allowlist`: Restricts a session or tab to `allowedOrigins` (exact origins, bare hosts, or `*.domain.com` wildcards).
  - `browser_network`: Captures HTTP/XHR/fetch traffic with automatic `[REDACTED]` scrubbing of `Authorization`, `Cookie`, API keys, passwords, and JWTs.
  - `browser_console`: Reads `console.log/info/warn/error` and uncaught page exceptions captured from `document_start`.
