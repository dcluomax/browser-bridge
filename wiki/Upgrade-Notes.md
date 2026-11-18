# Upgrade Notes (`v0.7.0` / `v0.10.x` → `v0.11.0`)

**Browser Bridge `v0.11.0`** introduces **Quality-Constrained `SiteLearner` v2** (route-scoped `>= 85%` content-completeness bandit, ordered wait modes, `k >= 3` hysteresis, clean-streak settle decay, `_noLearn` benchmark isolation, field provenance, and semantic relocation auto-repair), **Event-Driven DOM Readiness (`waitForDomQuiet`)**, **`browser_batch` / `Page.batch(...)`**, **Auto-Routine Trajectory Distillation**, a **streamlined Astryx Popup UI**, and the **`N >= 20` `PATCH` Release Gate (`scripts/check-routine-gate.py`)** alongside **24 built-in timestamped playbooks (`routines/*.json`)**.

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

## 3. Network-Excluded Speedup Benchmarks (`Unoptimized` vs `v0.10.1`)

HTML network download latency (`navigationTiming.networkMs` via W3C `PerformanceNavigationTiming.responseEnd`) is subtracted so ISP/Wi-Fi speed does not skew comparisons:

| Site & Playbook | Non-Network Bottleneck Solved | Unoptimized *(Excl. Net)* | `v0.10.1` *(Excl. Net)* | Warm `0-Net` Read | Gain |
| --- | --- | --- | --- | --- | --- |
| **Perplexity** (`perplexity.ai.json`) | SSE stream hangs MV3 `document_idle` | `18,945–29,000 ms` | **`~450–840 ms`** | **`4–7.8 ms`** snap | **>2,400× (`0-Net`) / ~35×** |
| **Medium** (`medium.com.json`) | Google One-Tap GSI + iframe hang | `23,163 ms` (`12.8s` snap) | **`586 ms`** | **`5.7–7 ms`** snap | **>1,800× (`0-Net`) / 39×** |
| **Google Sheets / Excel** (`docs.google.com__spreadsheets.json`) | `<canvas>` grid & UI coordinate detours | `8,077 ms` (`0-Net`) | **`~200 ms`** | **`180–259 ms`** cell R/W | **31×–45× (`0-Net`)** |
| **Google Search** (`google.com.json`) | `onload` beacons + ad iframes | `~14,978 ms` | **`532 ms`** | **`41 ms`** `read_results` | **28× post-net** |
| **Google Docs** (`docs.google.com__document.json`) | `0`-text Kix `<canvas>` + sync `onload` | `~6,690 ms` + `0` text | **`~350 ms`** | **`10 ms`** `DOCS_modelChunk` | **`10 ms` `0-Net` Canvas** |
| **arXiv** (`arxiv.org.json`) | MathJax/font `onload` stall + PDF friction | `~10,100 ms` | **`~550 ms`** | **`12 ms`** `read_abstract` | **18× post-net** |
| **PyPI** (`pypi.org.json`) | External badge/ad script `onload` stall | `~7,320 ms` | **`491 ms`** | **`40–50 ms`** docs read | **14.9× post-net** |
| **LinkedIn & Gmail** (`linkedin.com.json`, `mail.google.com.json`) | Multi-hop `3xx`/client redirect + `/bind` | `>8,500 ms` stall | **`~450–950 ms`** | **`6–29 ms`** snap | **~10×–18× post-net** |
| **GitHub, HF, npm & Notion** (4 JSONs) | 200+ header links truncating `<main>` | `1.9–2.8 s` + truncated | **`~120–350 ms`** | **`13–50 ms`** full read | **Sub-50 ms `0-Net`** |
| **ChatGPT & Claude** (`chatgpt.com.json`, `claude.ai.json`) | Clipped composer + `5–15 s` blind sleeps | Clipped / blind polling | **`~200–350 ms`** | **`35–37 ms`** read · **`117 ms`** draft | **Deterministic** |
| **Yahoo, Amazon, Reddit, X, draw.io, Wiki, HN, SO, YouTube** (9 JSONs) | Ad iframes, soft-gate, `shreddit-*`, `#fragment` `30s`, `border=0` tables, `#cite_note`, OneTrust, Polymer | `7.5–30 s` stalls / `403` | **`~250–950 ms`** | **`5 ms`** X · **`32 ms`** HN · **`52 ms`** Wiki · **`99 ms`** Reddit JSON | **Zero timeouts** |
