# Structured debugging and reversible fixes

Browser Bridge 0.13.0 adds diagnostics to the existing website-learning workflow.
It uses the user's authorized tab. It does not create an isolated browser context.

## Capability map

| MCP tool | Wire method | Python API |
| --- | --- | --- |
| `browser_styles` | `page.styles` | `computed_styles`, `style_context` |
| `browser_layout` | `page.layout` | `box_model`, `hit_test` |
| `browser_dom_baseline` | `page.domBaseline` | `create_dom_baseline`, `compare_dom_baseline`, `describe_dom_baseline`, `release_dom_baseline` |
| `browser_patch` | `page.patch` | `apply_patch`, `patches`, `rollback_patch`, `commit_patch`, `temporary_patch` |
| `browser_performance` | `page.performance` | `performance` |
| `browser_har` | `page.har` | `export_har` |
| `browser_debugger` | `page.debugger` | `debugger_metrics` |
| `browser_intercept` | `page.intercept` | `interception`, `set_interception`, `clear_interception` |

All tools accept a tab selector. Frame-scoped tools also accept `frameId`.
Use a `ref` or a structured `locator`, not both. Python methods accept the existing
`Locator` objects. Point coordinates use the selected frame's viewport.

Firefox supports styles, layout, baselines, patches, HAR and browser performance
entries. Chromium also supports debugger performance counters and request mocks.
Those debugger-only operations fail explicitly in Firefox. There is no fallback
that executes arbitrary JavaScript or opens another browser.

## Prove a temporary fix

1. Read the target's DOM and CSS.
2. Create a baseline of the relevant subtree.
3. Apply a small patch.
4. Read the actual rendered result.
5. Move the successful change into source.
6. Roll the live patch back.
7. Compare the baseline again.

```python
from browser_bridge import BrowserBridge

with BrowserBridge(browser="firefox") as bridge:
    page = bridge.page(shared_tab_id)
    heading = page.locator("#heading")
    baseline = page.create_dom_baseline(locator=heading)
    print(page.computed_styles(locator=heading, properties=["color", "display"]))

    with page.temporary_patch([
        {"target": heading, "styles": {"color": "rgb(0, 128, 0)"}}
    ]) as patch:
        print(page.computed_styles(locator=heading, properties=["color"]))
        print(page.box_model(locator=heading))

    print(page.compare_dom_baseline(baseline["id"], frame_id=baseline["frameId"]))
    page.release_dom_baseline(baseline["id"], frame_id=baseline["frameId"])
```

The context manager rolls the patch back when its block exits. Cleanup failures
are errors, not successful verification. A semantic DOM baseline is not a
screenshot or a complete CSS/layout baseline. Use the corresponding style/layout
reads to verify visual properties.

## Baseline contract

- Baselines stay in document memory. They do not go into site-memory files.
- Each opaque handle belongs to one session and frame.
- Handles expire after five minutes.
- Navigation and document replacement invalidate handles.
- Detached baseline roots fail instead of being relocated to new elements.
- Capture and comparison limits appear in the result.
- Partial evidence cannot prove that the DOM stayed unchanged.
- Hidden/script data and sensitive control values are not captured.

Do not treat an empty bounded diff as proof without checking its completeness.
Do not use a baseline from one frame in another frame.

The baseline scope is `visible-semantic-light-dom`. Intentional hidden, form-value,
iframe and shadow-interior exclusions do not make that scoped capture incomplete.
`unchanged` compares sanitized evidence in that scope, not pixels or the whole page.
To inspect another frame or an element inside an accessible shadow tree, select
that root explicitly with the existing locator API.

## Patch contract

Each patch contains from 1 to 50 changes. A change targets one element and can
set inline CSS, safe metadata attributes, or plain leaf text. It cannot replace
an HTML subtree, run scripts, change executable URL attributes, or edit sensitive
form controls.

```json
{
  "action": "apply",
  "tabId": 123,
  "changes": [
    {
      "target": {"locator": {"steps": [{"kind": "css", "value": "#heading"}]}},
      "styles": {"color": "green", "margin-top": null},
      "attributes": {"title": "Temporary layout probe"}
    }
  ]
}
```

The engine validates the whole patch before it changes the DOM. It records original
presence, value and CSS priority. A null style/attribute removes the property.
Rollback uses the original element objects. It does not heal a handle into a new
element.

Rollback refuses conflicting application changes. Resolve the reported conflict
instead of retrying blindly. Owner cleanup and expiry attempt safe rollback and
report conflicts. Read-only clients cannot apply, roll back or commit patches.
`commit` discards rollback history and keeps the live changes. It never writes
source code or makes the change survive page reload.

## Reuse a diagnostic recipe

The new wire methods also work as batch/Routine operations:
`styles`, `layout`, `domBaseline`, `patch`, `performance`, `har`, `debugger`,
`intercept`, `network`, and `console`.

Save the output of baseline creation as `baseline`. Use `{{baseline.id}}` in a later
compare/release step. Dotted output bindings preserve JSON types, including numeric
frame IDs. Literal dotted keys such as `url.origin` keep their existing meaning.
Values substituted into a template are not recursively interpreted.

Store locators and recipe parameters for cross-session use. Do not store literal
document handles or element refs. Site-memory saves reject those values in diagnostic
steps. Each new execution must create its own handles.

Website learning, user demonstration and automatic Routine distillation remain
available. Diagnostic reads do not enable page-script evaluation.

## Network and performance evidence

Start a network capture, reproduce the issue, then export:

```python
page.start_network_capture()
# Perform the authorized reproduction.
har = page.export_har()
print(har["log"]["entries"])
page.stop_network_capture()
print(page.performance(include_resources=True))
```

HAR export is a read of this session's existing capture. It does not start, stop
or clear capture. The output omits headers, cookies, bodies, query strings, fragments
and URL credentials. It reports dropped entries. Unknown HAR fields use documented
placeholders and observation flags. Per-phase timings are unavailable, not measured
as zero-cost work. Redirects sharing one request ID are not separate entries.

Browser performance results come from the current document's retained navigation
and resource entries. Unavailable timing remains null. Cross-origin detail requires
the server's Timing-Allow-Origin permission. These point samples are not Web Vitals
or Browser Bridge benchmarks.

## Chromium request mocks

Request interception is an explicit write operation. It uses the existing debugger
permission and displays Chromium's debugger indicator. It does not run when that
access is disabled, dismissed or unavailable.

```python
page.set_interception([
    {
        "urlPattern": "https://example.test/api/*",
        "action": "fulfill",
        "status": 200,
        "body": '{"ok":true}',
        "contentType": "application/json"
    }
])
# Reproduce and inspect the application result.
page.clear_interception()
```

Rules belong to one session and tab. They expire after five minutes. Normal
navigation, revocation and disconnect remove them. URL wildcards are path-only.
Bodies have strict size limits. Interception is limited to eight tabs per session
and 32 tabs overall. Arbitrary response headers, credentials and raw
CDP commands are not exposed.

Input dispatch, a mocked response and a live patch do not prove application success.
Verify the intended DOM/URL/style outcome with a subsequent structured read.
