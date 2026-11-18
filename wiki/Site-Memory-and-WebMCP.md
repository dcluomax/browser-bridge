# Site Memory and WebMCP

<p align="center">
  <img src="https://raw.githubusercontent.com/dcluomax/browser-bridge/main/docs/assets/site-memory-flow.svg" alt="Adaptive Site Memory learning flow and WebMCP invocation diagram" width="100%" />
</p>

Browser Bridge goes beyond stateless DOM clicking with two complementary acceleration layers: **Adaptive Site Memory (`SiteLearner` + `Routines`)** and **Native W3C WebMCP (`document.modelContext`)**.

---

## 1. Adaptive Error-Driven Site Learning (`SiteLearner`)

Whenever an agent or Python script interacts with a non-loopback domain, `SiteLearner` in `bridge-core` tracks real execution outcomes and persists verified optimizations in `<data_dir>/routines/<domain>.json`:

1. **Stalled Beacon Bypass (`preferredWaitUntil="domcontentloaded"`):** When a page's `DOMContentLoaded` fires quickly (`< 1.5s`) while third-party analytics/ad beacons stall `window.onload` into timeouts or multi-second tails, `SiteLearner` upgrades future navigations on that domain to `domcontentloaded`.
2. **SPA Hydration Stabilization (`hydrationSettleMs`):** When early `stale_ref` or `not_ready` errors occur immediately after client-side routing or React/Next/Vue hydration, `SiteLearner` applies a bounded post-navigation settle window.
3. **Blocker Recovery Triads (`LearnedRecoveryRule`):** When an action fails with `not_actionable: covered by <div#cookie-wall>`, the agent clicks `#accept-cookies`, and the retried target click succeeds, `SiteLearner` records the verified `(blocker, recoveryMethod, recoveryTarget)` triad and surfaces it automatically in future snapshots.
4. **Input Transport Fallback (`preferredInput="dom"`):** If enterprise browser policy blocks `chrome.debugger`, `SiteLearner` remembers to use direct DOM events (with a 24-hour TTL) instead of retrying debugger attachment on every click.
5. **WAF Session Routing (`directHttpBlocked`):** When anonymous host HTTP (`request.fetch`) hits `403` / `429` while in-tab `page.fetch` succeeds, `browser.smart_fetch` routes subsequent requests on that domain directly through the authenticated tab.

Inspect or reset any domain's learned profile from the CLI:

```bash
BrowserBridge routines example.com
BrowserBridge routines example.com --json
BrowserBridge routines example.com --reset-profile
```

---

## 2. Timestamped Site Optimization JSONs (`routines/*.json`, `schemaVersion: 2`)

A **Routine** collapses a 5–10 step UI interaction into a single deterministic tool call (`browser_routine_run` in MCP or `page.run_routine(...)` in Python).

### Built-In 24-Site Timestamped Playbooks (`v0.11.0` · `PATCH x.y.Z` Policy)

Browser Bridge ships **24 standalone, git-tracked JSON playbooks** in [`routines/*.json`](https://github.com/dcluomax/browser-bridge/tree/main/routines), governed by [[Versioning and Site JSON Policy]] (adding or updating `routines/*.json` increments the **3rd SemVer digit `PATCH 0.10.Z`** with refreshed ISO-8601 UTC `verifiedAt` and `updatedAt` timestamps):

- **Upgrade Auto-Merge (`seed.verifiedAt >= disk.updatedAt`):** Refreshes outdated built-in routines and `accessProfile` latency settings automatically while keeping custom user routines, learned pitfalls, and notes untouched.
- **Website-Redesign Drift Detection (`[STALE]`):** After `>= 2` consecutive selector or timeout failures on a routine, Browser Bridge flags it `[STALE - DOM may have changed]` with `staleReason`.
- **Path-Scoped Apps, Aliases & Dynamic URL Variables:** Distinguishes `docs.google.com/document` vs `docs.google.com/spreadsheets`, resolves friendly aliases (`google-docs`, `google-sheets`, `google-excel`, `gmail`, `chatgpt`, `claude`, `perplexity`, `notion`, `hf`, `npm`, `pypi`, `arxiv`, `linkedin`, `medium`, `drawio`, `hn`), supports `op: "fetch"` (`stripHtml`), `{{param:urlencode}}`, Python `**kwargs`, and injects `{{url.docId}}`, `{{url.gid}}`, `{{url.repo}}`, `{{url.arxivId}}`, `{{url.cleanPath}}`, and `{{url.origin}}`.

| Playbook JSON | Built-in Routines | Network-Excluded / `0-Net` Speedup |
| --- | --- | --- |
| `perplexity.ai.json` | `draft_query`, `ask_search`, `read_answer` | `18.9s` SSE `document_idle` hang → **`4–7.8 ms` `0-Net` snap (>2,400×)** · **`~450–840 ms` post-net** |
| `medium.com.json` | `read_article`, `dismiss_meter_modal`, `search_stories` | `12,825 ms` One-Tap iframe hang → **`5.7–7 ms` `0-Net` snap (>1,800×)** · **`586 ms` post-net (39×)** |
| `docs.google.com__spreadsheets.json` | `read_sheet_csv`, `read_cell`, `write_cell`, `select_range`, `rename_spreadsheet` | `8,077 ms` UI detours → **`180–259 ms` `0-Net` cell R/W (31×–45×)** · **`~201–325 ms`** CSV |
| `google.com.json` | `search`, `read_results`, `next_results_page` | `~14,978 ms` post-net → **`532 ms` post-net (28×)** · **`41 ms` `0-Net` `read_results`** |
| `docs.google.com__document.json` | `read_document`, `append_text`, `replace_text`, `rename_document` | **`10 ms` `0-Net` Kix `<canvas>` `DOCS_modelChunk` snap** + **`~170–267 ms`** `/mobilebasic` |
| `arxiv.org.json` | `read_abstract`, `open_html_paper`, `search_papers` | `~10,100 ms` MathJax stall → **`~550 ms` post-net (18×)** · **`12 ms` `0-Net` `read_abstract`** |
| `pypi.org.json` | `read_package_docs`, `search_packages` | `~7,320 ms` post-net → **`491 ms` post-net (14.9×)** · **`40–50 ms` `0-Net` docs read** |
| `linkedin.com.json`, `mail.google.com.json` | `search_jobs`, `search_people`, `read_main_content` / `search_mail`, `read_open_thread`, `draft_compose` | `>8,500 ms` redirect/`/bind` stall → **`~450–950 ms` post-net** · **`6–29 ms` `0-Net` snap** |
| `github.com.json`, `huggingface.co.json`, `npmjs.com.json`, `notion.so.json` | `read_main_content`, `search_repo_issues` / `read_model_card` / `read_package_readme` / `read_page`, `quick_find` | **`13 ms`** npm · **`18 ms`** HF · **`50 ms`** GitHub/Notion `0-Net` full read (0 header truncation) |
| `chatgpt.com.json`, `claude.ai.json` | `draft_prompt`, `ask_and_wait`, `read_conversation`, `new_chat` | **`35–37 ms` `0-Net` read** · **`117 ms` safe draft** · deterministic Stop-button wait |
| `reddit.com.json`, `x.com.json` | `browse_subreddit`, `fetch_subreddit_json`, `read_thread_json` / `search_posts`, `read_timeline_posts`, `draft_post`, `draft_reply` | **`99 ms`** Reddit `.json?raw_json=1` · **`5–6 ms` `0-Net` snap** · **`~45 ms` X timeline read** |
| `diagrams.net.json`, `amazon.com.json`, `finance.yahoo.com.json`, `youtube.com.json`, `wikipedia.org.json`, `news.ycombinator.com.json`, `stackoverflow.com.json` | Diagram XML R/W, product search, ticker quote, video transcript, Wiki prose, HN 30 stories, SO Q&A | **`660 ms`** draw.io XML · **`51 ms` `0-Net`** Yahoo quote · **`52 ms` `0-Net`** 35k-char Wiki · **`32 ms` `0-Net`** HN 30/30 |

### Defining Custom Domain Routines
Agents (or users) can save reusable routines via `browser_routine_save`:

```json
{
  "domain": "issues.example.com",
  "routine": {
    "name": "filter_open_bugs",
    "description": "Filters the issue table by query text and returns matching titles",
    "readOnly": false,
    "params": {
      "query": { "type": "string", "required": true, "description": "Search filter text" }
    },
    "steps": [
      {
        "op": "type",
        "params": {
          "locator": { "steps": [{ "kind": "placeholder", "value": "Filter issues" }] },
          "text": "{{query}}",
          "clear": true,
          "submit": true
        }
      },
      {
        "op": "waitFor",
        "params": {
          "locator": { "steps": [{ "kind": "css", "value": ".issue-row" }] },
          "state": "visible"
        }
      },
      {
        "op": "queryAll",
        "params": {
          "locator": { "steps": [{ "kind": "css", "value": ".issue-row .title" }] },
          "operation": "innerText"
        },
        "saveAs": "titles"
      }
    ]
  }
}
```

---

## 3. Native W3C WebMCP (`document.modelContext`)

Web applications adopting the emerging **WebMCP** standard register structured tools directly in page JavaScript (`navigator.modelContext.registerTool` / `document.modelContext.registerTool`) or declarative HTML forms (`<form toolname="search_docs" tooldescription="...">`).

Browser Bridge injects a zero-privilege collector at `document_start` across **Edge, Chrome, and Firefox**:
- Call `browser_webmcp_list` to inspect available page tools, JSON input schemas, and `readOnlyHint` / `consequentialHint` flags.
- Call `browser_webmcp_call({ "name": "...", "arguments": { ... } })` to invoke the page's structured tool directly without brittle DOM scraping.
- When a tab or MCP server is in `Read-Only` mode, Browser Bridge refuses any WebMCP tool that does not declare `readOnlyHint: true`.
