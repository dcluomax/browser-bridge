# Browser Bridge Python SDK

The Python SDK (`0.13.1`) connects directly to the Browser Bridge Named Pipe
(Windows) or Unix Domain Socket (macOS / Linux) with zero intermediate child
process (`~1.1 ms` median roundtrip). Any external language can connect directly over the
same open JSON-line IPC protocol, or optionally launch `BrowserBridge rpc` over
stdio. There is no dependency on Playwright, Selenium, a downloaded browser, a
TCP server or an API token.

## Install once

From the Browser Bridge checkout:

```powershell
scripts\install.ps1
python -m pip install .\python
```

Load the extension in your browser, or click **Reload** after an update. Leave
all-tabs mode and page scripts off for normal automation. A connected browser
is required; the SDK does not launch a new browser or change your profile.
Python 3.10+ is supported. The package has no runtime dependencies.

For an offline local install when setuptools is already available:

```powershell
python -m pip install --no-index --no-build-isolation --no-deps .\python
```

## Smallest script

```python
from browser_bridge import BrowserBridge

with BrowserBridge() as browser:
    page = browser.new_page()
    response = page.goto("https://example.com", wait_until="domcontentloaded")
    print(response.status, page.title(), page.url)
    print(page.locator("h1").first.inner_text())
    page.screenshot("example.png")
```

The context manager starts and stops its local RPC process and closes only tabs
it created. It never shuts down your browser. Existing tabs must be shared from
the extension popup, and a tab controlled by another agent cannot be taken over.
Do not use the same tab concurrently from separate script sessions.

No arguments are normally needed. Optional selectors:

```python
with BrowserBridge(browser="edge") as browser:
    ...

with BrowserBridge(browser="Work", timeout=45_000) as browser:
    ...
```

`browser` accepts a browser name, profile label or instance ID. `host` accepts a
specific host executable. `BROWSER_BRIDGE_BROWSER` and `BROWSER_BRIDGE_HOST` provide
the same overrides for tests or alternate installs; leave them unset normally.
All `timeout` arguments are milliseconds.

## Pages, background tab groups, allowlists, and navigation

```python
# Silent background open by default (active=False) inside a collapsed [Agent] group
page = browser.new_page()
page = browser.new_page(
    "https://docs.google.com/spreadsheets/d/your-doc-id/edit#gid=0",
    active=False,
    name="quarterly-sheet",          # persistent handle reused across scripts (exempt from 10m idle GC)
    group="Agent",
    allowed_origins=["https://docs.google.com"],
)
browser.allowlist(["*.github.com"], tab_id=page.tab_id)
browser.allowlist(clear=True, tab_id=page.tab_id)

available_pages = browser.pages
shared_page = browser.page(tab_id)

# Execute built-in timestamped routines/*.json playbooks (**kwargs, {{url.docId}}, {{url.gid}}, {{url.arxivId}}, {{url.cleanPath}}, op="fetch")
csv_out = page.run_routine("read_sheet_csv")
cell_val = page.run_routine("read_cell", cell="B4")

# Interactive human handoff, password-safe demonstration recorder & redacted diagnostics
# page.handoff("Please complete SSO 2FA, then click Continue")
page.start_network_capture(only_failures=True)
errors = page.console_messages(level="error")
failed_requests = page.stop_network_capture()

response = page.goto(url, wait_until="domcontentloaded", timeout=45_000)
page.wait_for_load_state("load", timeout=30_000)
page.wait_for_url(exact_absolute_url, timeout=30_000)
page.go_back()
page.go_forward()
page.reload()
page.bring_to_front()
print(page.title(), page.url, page.user_agent)
page.close()
```

For a shared-page directory, use `browser.call("tabs.inventory")` with extension
0.3.1+. `status.sharedTabInventory == 1` advertises this additive capability.
Inventory entries include `sharedByUser`, `busy` and `controllable`. A user-shared
tab can remain listed while another session owns it, but reads/actions still
raise `forbidden` until ownership is released. Other agents' private tabs remain
hidden. `browser.pages` and `tabs.list` continue to list actionable pages.
Inventory reads do not claim tabs or change sharing permissions.

`goto` supports `load`, `domcontentloaded` and `commit`. Its `NavigationResponse`
contains `url`, `status` and `ok`. `about:blank` returns `None`; non-HTTP navigation
can have `status=None`. Status is observed from browser network events, never
invented as 200. Redirects and out-of-order Firefox document/network events are
correlated. HTTP errors such as 404 return the actual status; transport/navigation
failures raise exceptions. `networkidle` and glob URL matching are not supported.

`page.wait_for_timeout(ms)` is an ordinary local sleep. Prefer observable element
or page conditions. `page.snapshot(max_chars=20000)` returns an outline with refs.
For iframe refs such as `f19327352834e7`, use:

```python
frame = page.in_frame(19327352834)
frame.get_by_role("button", name="Continue", exact=True).click()
```

Frame IDs remain 64-bit/JavaScript-safe values, including Firefox IDs above 2^31.
They are document-specific, not stable across arbitrary frame replacement.

## Locators

```python
page.locator("input[name='name']")
page.get_by_role("button", name="Save", exact=True)
page.get_by_text("Ready", exact=True)
page.get_by_label("Full name")
page.get_by_placeholder("Search")
page.get_by_test_id("result")
page.get_by_alt_text("Chart")
page.get_by_title("Details")

items = page.get_by_role("region", name="Items").locator("li")
items.filter(has_text="Second").get_by_role("button").click()
items.first
items.last
items.nth(1)
```

Finders can be chained. Use `.first`/`.last` properties (not method calls), as in
Playwright's Python interface. A locator resolves again for each operation; it
does not retain an old DOM element after rerendering.

Text matching normalizes whitespace. Defaults are case-insensitive substrings;
`exact=True` uses case-sensitive normalized text. `get_by_test_id` matches
`data-testid` exactly. Role finders omit hidden elements unless
`include_hidden=True`. Role/name computation is the Bridge's DOM-based model,
not a full implementation of Playwright's accessibility engine.

CSS searches each DOM/shadow tree. Use chained locators to cross shadow roots.
XPath, regex locators and Playwright-only CSS pseudo selectors are not implemented.
Actions and scalar reads require one match; ambiguity is an error, not an
implicit first-match selection.

## Interactions

```python
field = page.get_by_label("Full name")
field.fill("Ada")                 # replace
field.clear()
field.type("Ada")                 # append, key by key
field.press_sequentially(" Ada")  # same fixed pacing as type
field.press("Control+A")

button = page.get_by_role("button", name="Search", exact=True)
button.click(timeout=15_000)
button.click(button="right", modifiers=["Shift"])
button.dblclick()
button.hover()

page.get_by_label("Color").select_option("green")
page.locator("select[multiple]").select_option(["red", "blue"])
page.get_by_label("Subscribe").check()
page.get_by_label("Subscribe").uncheck()
page.get_by_label("Subscribe").set_checked(True)
page.locator("#section").scroll_into_view_if_needed()
```

Locator actions wait for a unique visible/enabled/editable target as appropriate.
Clicks and hovers refuse covered targets instead of clicking a different element.
Checkbox changes are verified, including event handlers that prevent the change.
This is not Playwright's complete animation-stability/actionability model.
Edge/Chrome use trusted debugger input when enabled; Firefox uses DOM events.

`select_option` accepts values or visible labels and returns selected labels.
Individual MCP `browser_press_key`/`browser_scroll` operations remain available
through `browser.call` for page-level keyboard and scrolling.

## Reading and waiting

```python
title = page.locator("h1").first.inner_text(timeout=10_000)
raw_text = page.locator("#result").text_content()
value = page.get_by_label("Name").input_value()
href = page.locator("a.download").get_attribute("href")  # None if absent

rows = page.locator("tr").all_text_contents()
visible_rows = page.locator("tr").all_inner_texts()
image_sources = page.locator("img").all_attributes("src")
count = page.locator(".item").count()

target = page.locator("#result")
target.wait_for(state="visible", timeout=15_000)
target.wait_for(state="attached")
target.wait_for(state="hidden")
target.wait_for(state="detached")
target.wait_for(state="enabled")
target.wait_for(state="disabled")
target.wait_for(state="editable")
target.wait_for(state="checked")
target.wait_for(state="unchecked")
```

Boolean methods: `is_visible`, `is_hidden`, `is_enabled`, `is_disabled`,
`is_editable`, `is_checked`. Visibility/hidden checks and `count` are immediate;
missing elements return false/true/0 respectively. Other scalar reads wait for
an attached element. Bulk reads are snapshots, not live lists or assertions.

Password values and password `value` attributes are masked. Read truncation
raises `BridgeError("truncated", ...)`; it is never silently returned as complete
data. String reads allow `max_chars` (currently at most 100000). Bulk reads are
bounded by 10000 items and 500000 text characters; narrow the locator if exceeded.
Locator scopes are bounded to 50000 elements and 16 steps.

Invalid selectors, closed/unshared tabs and failed frame reads are errors, never
evidence that a wait condition succeeded. An unknown ref cannot satisfy a
detached wait; use locators when DOM/document replacement is expected.

## Requests and binary downloads

Two deliberately different request contexts prevent accidental cookie export:

```python
# Real browser request, with its current login state and normal CORS rules.
response = page.request.get(asset_url, timeout=30_000, max_bytes=20 * 1024 * 1024)
response.raise_for_status()
svg_bytes = response.body()

# Anonymous HTTP performed by the local host, without browser cookies.
public_file = browser.request.get(
    public_cdn_url,
    headers={"User-Agent": page.user_agent, "Referer": page.url},
)
public_file.raise_for_status()
data = public_file.body()
```

`page.request` runs a fixed, typed fetch in the page; it does not need arbitrary
page-script permission and works under a script-blocking page CSP. It keeps
browser credentials in the browser and honors CORS. A CORS failure is **not**
silently retried using the more privileged host. `browser.request` has no cookie
jar and is appropriate for already-public assets.

Both contexts support `.get`, `.post` and
`.fetch(url, method="GET", headers=None, data=None, timeout=30000, max_bytes=...)`.
`data` is a string body, not a multipart file-upload API. HTTP(S) URLs without
embedded credentials are required.

Responses provide `status`, `url`, `headers`, `ok`, `body()`, `text(encoding="utf-8")`,
`json()` and `raise_for_status()`. 4xx/5xx are observable responses; network errors
and oversize bodies raise exceptions. Exact bytes are transported as base64,
not truncated evaluate/text output. The default response limit is 20 MiB
(configurable up to 32 MiB); streaming reads enforce the limit even when there is
no Content-Length. Tests verify a complete 20 MiB body and rejection at 20 MiB + 1.

## Screenshots and optional page JavaScript

```python
png_bytes = page.screenshot()
page.screenshot("viewport.png")
page.screenshot("fullpage.png", full_page=True)
page.locator("#chart").screenshot("chart.png")
page.screenshot("viewport.jpg", quality=80, max_width=1920)
```

Screenshots capture the viewport, full scrollable page (`full_page=True`), or a
specific element (`locator.screenshot(...)`). On Edge/Chrome (with Trusted Input
enabled) and Firefox (`tabs.captureTab`), screenshots execute in the background
without stealing tab focus. PDF printing and browser-download event APIs are not
implemented.

When the user has explicitly enabled **Allow agents to run page scripts**:

```python
answer = page.evaluate("(value) => ({answer: value + 1})", 41)
page.wait_for_function(
    "() => document.querySelector('#ready') !== null",
    timeout=15_000,
)
```

These are ordinary page JavaScript, not a restricted expression grammar.
`evaluate` runs an expression or invokes its resulting function with the
JSON-serializable `arg`; promises are awaited. It does not expose Python/Node
files or local host APIs to the page. The SDK does not turn on the popup setting.
The separate MCP `browser_evaluate` also retains its host `--allow-evaluate` gate.

## Direct API, MCP and other local languages

Every extension method can be called without waiting for a Python wrapper:

```python
result = browser.call("page.queryAll", {
    "tabId": page.tab_id,
    "locator": {"steps": [{"kind": "css", "value": "tr"}]},
    "operation": "textContent",
})
print(result["values"])
```

This is a method transport, not permission to call unsupported features.
Unknown methods and invalid parameters return explicit errors.

The individual MCP tools use the same command implementation:

| MCP | Native API |
| --- | --- |
| `browser_tabs`, `browser_allowlist` | `tabs.list/new/select/close`, `session.allowlist` |
| `browser_navigate`, `browser_history` | `page.navigate/history` |
| `browser_snapshot`, `browser_get_text` | `page.snapshot/text` |
| `browser_locate`, `browser_get_element` | `page.locate/query` |
| `browser_network`, `browser_console` | `page.network/console` |
| `browser_click/hover/drag/type/fill_form/select_option/press_key/scroll` | `page.click/hover/drag/type/fill/select/press/scroll` |
| `browser_set_checked`, `browser_wait_for`, `browser_screenshot` | `page.check/waitFor/screenshot` |
| `browser_handoff`, `browser_demonstrate` | `page.handoff/demonstrate` |
| `browser_routine_list/run/save`, `browser_webmcp_list/call` | `site.routines`, `routine.run`, `site.save`, `page.webmcp.list/call` |
| optional `browser_evaluate` | gated `page.evaluate` |

MCP actions accept `ref` or `locator`, never both. Structured locator examples:

```json
{"steps":[{"kind":"role","value":"button","name":"Save","exact":true}],"frameId":0}
```

To use another language, launch the installed `BrowserBridge.exe rpc` with piped
UTF-8 stdin/stdout. Send one JSON object per line, with unique positive integer IDs:

```json
{"id":1,"method":"bridge.connect","params":{}}
{"id":2,"method":"tabs.new","params":{}}
{"id":3,"method":"page.navigate","params":{"tabId":123,"url":"https://example.com","waitUntil":"domcontentloaded","timeoutMs":30000},"timeoutMs":35000}
```

`bridge.connect` optionally takes an envelope-level `browser` selector and pins
the connection. Its result has `protocol`, `hostVersion`, `browser` and `status`;
require `protocol=1` and `status.managedApi=1`. Substitute the returned tab ID,
not the illustrative 123 above. Response shapes are:

```json
{"id":2,"ok":true,"result":{"tabId":123,"url":"about:blank","title":""}}
{"id":3,"ok":false,"error":{"code":"timeout","message":"..."}}
```

`request.fetch` is the anonymous host API; `page.fetch` uses the authorized tab.
`page.info` exposes tab metadata, with `document:true` for document readiness and
user agent. `page.activate`, `page.queryAll` and all existing action commands are
also available. Close created tabs with `tabs.close` and close stdin to release
the session. RPC never automatically replays an action after connection loss.
No server port is opened.

## Failures and lifecycle

```python
from browser_bridge import BridgeError, BridgeTimeoutError

try:
    with BrowserBridge() as browser:
        page = browser.new_page("https://example.com")
        page.locator("#result").wait_for(timeout=5000)
except BridgeTimeoutError as error:
    print("Inspect before retrying:", error)
except BridgeError as error:
    print(error.code, str(error))
```

Common codes: `not_installed`, `update_required`, `unavailable`, `forbidden`,
`no_tab`, `strict_locator`, `not_actionable`, `timeout`, `request_failed`,
`body_too_large`, `disabled`, `truncated`, `connection_lost`.

Default action/read readiness timeout is 30 seconds; operation budgets are finite
and bounded to 600 seconds. `timeout=0` is not an unlimited wait. Allow transport
and navigation-completion overhead around readiness waits. An in-flight browser
action may finish after a timeout; there is no rollback or automatic replay.
The context manager surfaces cleanup errors without silently discarding them.

Sign-ins, MFA and CAPTCHAs remain manual. Confirm consequential account actions.
No stealth, fingerprint spoofing, challenge solving or subscription bypass exists.

## Adaptive Site Memory, Routines, and `smart_fetch`

Browser Bridge learns per-domain access profiles (`preferredWaitUntil`, SPA
hydration settles, blocker recovery rules, and `directHttpBlocked` WAF
routing) and supports multi-step reusable routines:

```python
# Adaptive HTTP fetch: tries fast direct HTTP first, automatically routes via
# the authenticated browser session when a WAF/403 blocks plain HTTP!
resp = browser.smart_fetch("https://app.example.com/api/items", page=page)
print(resp.status, resp.json())

# Inspect or invoke Site Memory routines:
playbook = page.routines()
profile = page.access_profile()
result = page.run_routine("read_diagram_xml", {})
```

## Structured debugging and temporary patches

The Python API exposes the same diagnostics as MCP and direct IPC:
`computed_styles`, `style_context`, `box_model`, `hit_test`, DOM baseline lifecycle,
temporary patches, `performance`, and `export_har`.

```python
heading = page.locator("#heading")
baseline = page.create_dom_baseline(locator=heading)
with page.temporary_patch([{"target": heading, "styles": {"color": "green"}}]):
    print(page.computed_styles(locator=heading, properties=["color"]))
    print(page.box_model(locator=heading))
print(page.compare_dom_baseline(baseline["id"], frame_id=baseline["frameId"]))
page.release_dom_baseline(baseline["id"], frame_id=baseline["frameId"])
```

Handles belong to one session and frame. They expire and do not survive navigation.
The context manager attempts conflict-safe rollback on exit. It does not change
source. Read-only clients can inspect but cannot apply, commit or roll back patches.

The new methods also work in batches and site routines. Use nested runtime output
bindings such as `{{baseline.id}}`. Do not persist literal document handles or refs
in reusable diagnostic steps.

Chromium also exposes `debugger_metrics` and explicit bounded
`set_interception` / `clear_interception` request mocks. Firefox rejects those
debugger-only operations. See [Structured debugging](../docs/DEBUGGING.md) for
output, privacy, limits and lifecycle details.

## Compatibility, not blanket equivalence

This SDK provides a familiar Playwright-inspired locator and page model over
your live browser tabs. It is not the Playwright package or a promise of
complete, per-API compatibility. Isolated contexts, launch flags, proxies,
arbitrary CDP sessions, Playwright Test, and
browser-download event streams are not implemented. Use reported capabilities
and explicit failures rather than silently treating these different browser
models as equivalent.
