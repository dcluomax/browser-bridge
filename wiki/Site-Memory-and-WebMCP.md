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

## 2. Executable Multi-Step Routines

A **Routine** collapses a 5–10 step UI interaction into a single deterministic tool call (`browser_routine_run` in MCP or `page.run_routine(...)` in Python).

### Built-In `diagrams.net` Playbook
Out of the box, Browser Bridge ships built-in routines for `app.diagrams.net` / `draw.io` (`read_diagram_xml`, `write_diagram_xml`, `insert_shape`) alongside interactive SVG `role="shape"` snapshot extraction.

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
