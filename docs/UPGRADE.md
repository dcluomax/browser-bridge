# Upgrade Notes — Migrating from `v0.7.0` to `v0.10.0`

**Browser Bridge `v0.10.0`** is a backward-compatible feature and performance release (`Protocol v1`) introducing **14 timestamped `schemaVersion: 2` site optimization JSON playbooks (`routines/*.json`)**, **5×–31× real-world speedups** across Google Search, Google Docs, Google Sheets / Excel, GitHub, ChatGPT, Amazon, Yahoo Finance, and more, plus **5 new MCP tools** (`browser_handoff`, `browser_demonstrate`, `browser_allowlist`, `browser_network`, `browser_console`) and **silent collapsed `[Agent]` background tab groups**.

---

## 1. Quick Upgrade Steps (60 Seconds)

### Option A: One-Prompt / Zero-Build Prebuilt Upgrade (Recommended)

Paste this prompt into **GitHub Copilot**, **Claude Code**, **Cursor**, **Windsurf**, or **Cline**:

```text
Upgrade Browser Bridge to the latest release (v0.10.0) by following https://raw.githubusercontent.com/dcluomax/browser-bridge/main/docs/INSTALL.md — verify SHA-256 checksums, update BrowserBridge + unpacked extensions + timestamped routines, and confirm `BrowserBridge status` and `BrowserBridge routines` report v0.10.0.
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

## 2. How Timestamped `routines/*.json` Auto-Upgrade Works (`schemaVersion: 2`)

In `v0.7.0`, only `diagrams.net` shipped as a built-in playbook without verification timestamps. In **`v0.10.0`**, Browser Bridge introduces a **git-tracked, timestamped JSON site-optimization system** (`routines/*.json`, 14 built-in playbooks):

1. **ISO-8601 UTC Timestamps (`verifiedAt` & `updatedAt`)**:
   - Every file in `routines/*.json` and every individual `RoutineDefinition` carries `verifiedAt` (when selectors and speedups were verified against the live site) and `updatedAt` (when the entry was last modified), plus a human-readable `speedupSummary`.
2. **Non-Destructive Upgrade Merge (`seed_builtin_playbooks_to_disk`)**:
   - During `BrowserBridge install` (and at runtime via `resolve_playbook`), Browser Bridge compares each built-in routine's `verifiedAt` against your local `%LOCALAPPDATA%\BrowserBridge\routines\*.json` (`~/.browser-bridge/routines/*.json`) `updatedAt`.
   - Built-in routines with a **newer `verifiedAt`** automatically replace outdated local selectors, while **all custom routines you or your agents created, learned `SiteLearner` pitfalls, and custom domain notes are preserved intact**.
3. **Automatic Website-Redesign Drift Guard (`[STALE]`)**:
   - Websites evolve continuously. Whenever any routine hits **`>= 2` consecutive selector or timeout failures**, Browser Bridge automatically marks `stale: true` with `staleReason` and surfaces `[STALE - DOM may have changed]` in `browser_routine_list` and `BrowserBridge routines`.
   - Agents immediately know not to retry broken selectors blindly — instead they inspect a fresh `browser_snapshot` and persist updated steps via `browser_routine_save` (which clears `[STALE]` and stamps a fresh `verifiedAt`).
4. **Multi-App Path Isolation, Aliases & URL Variables**:
   - Multi-product hosts are cleanly isolated (`docs.google.com/document` -> `docs.google.com__document.json` vs `docs.google.com/spreadsheets` -> `docs.google.com__spreadsheets.json`).
   - Friendly domain aliases work out of the box: `google-docs`, `google-sheets`, `google-excel`, `chatgpt`, `google`, `drawio`, `twitter`, `hn`.
   - Routine steps now support `op: "fetch"` (authenticated in-tab HTTP with optional `stripHtml: true`), URL-encoded parameter substitution (`{{query:urlencode}}`), and automatic live-tab URL extraction (`{{url.docId}}`, `{{url.gid}}`, `{{url.repo}}`, `{{url.origin}}`, `{{url.href}}`).

---

## 3. Measured Speedup Summary (`v0.7.0` Unoptimized vs `v0.10.0`)

| Website & Playbook JSON | Key Engine & Routine Optimization | Before (`v0.7.0` Default) | After (`v0.10.0`) | Speedup |
| --- | --- | --- | --- | --- |
| **Google Search**<br>`routines/google.com.json` | `domcontentloaded` + `top`-frame fast path + `search(query)`, `read_results()`, `next_results_page()` | `15,495 ms` | **`1,292–1,423 ms`** | **~11–12×** |
| **Google Docs**<br>`routines/docs.google.com__document.json` | Fast open + native Kix `<canvas>` `DOCS_modelChunk` parser (`10 ms` snapshot, 0 eval/network) + `/mobilebasic` full multi-page `read_document` | `8,218 ms` open / 0-text `<canvas>` | **`1,528 ms`** open · **`10 ms`** snapshot · **`~170–267 ms`** full read | **5.4×** + Canvas unlocked |
| **Google Sheets / Excel**<br>`routines/docs.google.com__spreadsheets.json` | Named `#t-name-box` & `#t-formula-bar-input` controls + `/gviz/tq?tqx=out:csv` full CSV export + coordinate jump `read_cell` / `write_cell` | `8,077 ms` / unreadable `<canvas>` | **`259 ms`** cell R/W · **`~201–325 ms`** full CSV | **31×** |
| **GitHub**<br>`routines/github.com.json` | `domcontentloaded` + `120 ms` Turbo settle + 200-link repo header compaction + `{{url.repo}}` `read_main_content` & `search_repo_issues` | `3,469 ms` nav + truncated `<main>` | **`~920 ms`** nav · **`~50 ms`** full README/PR read | **3.8×** + zero truncation |
| **ChatGPT**<br>`routines/chatgpt.com.json` | Composer `<form>` preservation inside `contentinfo` + `draft_prompt` + deterministic `stop-button` streaming wait (`ask_and_wait`) | Blind sleep loops / clipped input | **`~690–914 ms`** ready · **`117 ms`** safe draft | Deterministic |
| **Amazon**<br>`routines/amazon.com.json` | Soft-gate bypass + `domcontentloaded` + `top`-frame ad-iframe skip (`search_products`, `read_product_details`) | `16,043 ms` | **`2,491 ms`** | **6.4×** |
| **Yahoo Finance**<br>`routines/finance.yahoo.com.json` | `domcontentloaded` + `top`-frame + header menu compaction (`lookup_quote`, `read_quote_summary`) | `8,050 ms+` | **`702 ms`** | **11.5×** |
| **diagrams.net / draw.io**<br>`routines/diagrams.net.json` | Service-worker `#fragment` fast settle + 1-call `<mxGraphModel>` XML read/write/shape routines | `30,000 ms` `#fragment` timeout | **`660 ms`** XML read · **`870 ms`** write · **`1.64 s`** shape | Timeout eliminated |
| **YouTube**<br>`routines/youtube.com.json` | `domcontentloaded` + `250 ms` Polymer hydration (`search_videos`, `open_transcript`) | `8,000–30,000 ms` streaming stall | **`2,042 ms`** | **4–14×** |
| **Wikipedia / HN / SO / Reddit / X**<br>5 domain JSON playbooks | `#cite_note` compression (Wikipedia), `border=0` layout-table flattening (HN 30/30 stories), OneTrust dismiss + 1,200-char code blocks (SO), `403` skip + `shreddit-*` Shadow DOM (Reddit), Cloudflare handoff detection (X) | Truncated outlines or `403` retries | Clean single-call extraction | Zero wasted retries |

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
