# Upgrade Notes (`v0.7.0` → `v0.10.0`)

**Browser Bridge `v0.10.0`** introduces **14 git-tracked, timestamped `schemaVersion: 2` site optimization JSON playbooks (`routines/*.json`)**, **5×–31× measured speedups** across Google Search, Google Docs, Google Sheets / Excel, GitHub, ChatGPT, Amazon, Yahoo Finance, and more, plus **5 new MCP tools** (`browser_handoff`, `browser_demonstrate`, `browser_allowlist`, `browser_network`, `browser_console`) and **silent collapsed `[Agent]` background tab groups**.

---

## 1. Upgrade in 60 Seconds

### One-Prompt / Prebuilt Release Upgrade (No Build Tools Needed)

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.ps1 | iex
```

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.sh | bash
```

### Source Checkout Upgrade

```powershell
# Windows
git pull origin main
.\scripts\install.ps1 -RegisterAllMcp -InstallPythonSdk
```

```bash
# macOS / Linux
git pull origin main
./scripts/install.sh --register-all --install-python
```

### Reload the Browser Extension (`↻`)

1. Open `edge://extensions` or `chrome://extensions` (or `about:debugging#/runtime/this-firefox` in Firefox).
2. Click **Reload (`↻`)** once on the **Browser Bridge** extension card.
3. Accept the new Chromium **`tabGroups`** permission if prompted (enables silent collapsed `[Agent]` tab groups).
4. Verify from a terminal with `BrowserBridge status` and `BrowserBridge routines`.

---

## 2. Timestamped `routines/*.json` Auto-Refresh & `[STALE]` Drift Guard

- **ISO-8601 UTC Timestamps (`verifiedAt` & `updatedAt`)**: Every playbook in `routines/*.json` and every individual routine carries verification and update timestamps plus `speedupSummary`.
- **Upgrade-Aware Non-Destructive Merge**: On `BrowserBridge install` (and runtime resolution), built-in routines whose `verifiedAt` is newer than an older local copy's `updatedAt` refresh automatically — **without overwriting custom user routines, learned pitfalls, or notes**.
- **Website Redesign Drift Detection (`[STALE]`)**: Whenever any routine fails `>= 2` consecutive times with selector or timeout errors, Browser Bridge marks it `[STALE - DOM may have changed]` with `staleReason`, prompting the agent to inspect a fresh `browser_snapshot` and save updated steps via `browser_routine_save`.
- **Path Isolation, Aliases & Dynamic URL Variables**: Isolates `docs.google.com/document` vs `docs.google.com/spreadsheets`, supports aliases (`google-docs`, `google-sheets`, `google-excel`, `chatgpt`, `drawio`, `hn`), `op: "fetch"` (`stripHtml`), `{{param:urlencode}}`, and automatic `{{url.docId}}`, `{{url.gid}}`, `{{url.repo}}`, `{{url.origin}}`.

---

## 3. Measured Speedup Benchmarks (`v0.7.0` vs `v0.10.0`)

| Site & Playbook | Key Engine + Routine Optimizations | Before | After (`v0.10.0`) | Gain |
| --- | --- | --- | --- | --- |
| **Google Search** (`google.com.json`) | `domcontentloaded` + `top`-frame + `search`, `read_results`, `next_results_page` | `15,495 ms` | **`1,292–1,423 ms`** | **~11–12×** |
| **Google Docs** (`docs.google.com__document.json`) | Fast open + `10 ms` Kix `<canvas>` `DOCS_modelChunk` parser + `/mobilebasic` `read_document` | `8,218 ms` / blank `<canvas>` | **`1,528 ms`** open · **`10 ms`** snapshot · **`~170–267 ms`** full doc | **5.4×** + Canvas text |
| **Google Sheets / Excel** (`docs.google.com__spreadsheets.json`) | Named `#t-name-box` & `#t-formula-bar-input` + `/gviz/tq?tqx=out:csv` + coordinate jump R/W | `8,077 ms` / opaque `<canvas>` | **`259 ms`** cell R/W · **`~201–325 ms`** CSV | **31×** |
| **GitHub** (`github.com.json`) | `domcontentloaded` + `120 ms` Turbo + 200-link header compaction + `{{url.repo}}` `read_main_content` | `3,469 ms` + truncated | **`~920 ms`** nav · **`~50 ms`** README/PR | **3.8×** + untruncated |
| **ChatGPT** (`chatgpt.com.json`) | Protected `contentinfo` composer `<form>` + `117 ms` `draft_prompt` + deterministic `stop-button` wait | Clipped input / sleep polling | **`~690–914 ms`** ready · **`117 ms`** draft | Deterministic |
| **Amazon** (`amazon.com.json`) | Soft-gate bypass + `domcontentloaded` + `top`-frame ad skip | `16,043 ms` | **`2,491 ms`** | **6.4×** |
| **Yahoo Finance** (`finance.yahoo.com.json`) | `domcontentloaded` + `top`-frame + header compaction | `8,050 ms+` | **`702 ms`** | **11.5×** |
| **diagrams.net** (`diagrams.net.json`) | PWA `#fragment` fast settle + `<mxGraphModel>` XML read/write/shape | `30,000 ms` timeout | **`660 ms`** read · **`870 ms`** write · **`1.64 s`** shape | Timeout eliminated |
| **YouTube** (`youtube.com.json`) | `domcontentloaded` + `250 ms` Polymer hydration (`search_videos`, `open_transcript`) | `8s–30s` stall | **`2,042 ms`** | **4–14×** |
| **Wikipedia / HN / SO / Reddit / X** | `#cite_note` compression, `border=0` layout-table flatten (30/30 stories), OneTrust dismiss + 1.2k code blocks, `403` skip + `shreddit-*` Shadow DOM, Cloudflare handoff | Truncation / `403` retries | Single-call clean extraction | Zero retries |
