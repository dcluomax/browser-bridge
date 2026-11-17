# Python SDK and Local IPC

The `browser-bridge` Python package (`python/`, zero external dependencies, Python `3.10+`) connects directly to Browser Bridge's Named Pipe (Windows) or Unix Domain Socket (macOS / Linux) with a **`~1.1 ms` median round-trip** and zero intermediate subprocesses.

---

## Installation

```bash
python -m pip install ./python
```

---

## Quickstart Example

```python
from browser_bridge import BrowserBridge

with BrowserBridge() as browser:
    # Opens silently in background (active=False default) inside a collapsed [Agent] group; closed on exit
    page = browser.new_page("https://example.com")
    print(page.title(), page.url)
    print(page.locator("h1").first.inner_text())

    # Persistent named tab + allowedOrigins fence + 1-call timestamped routines/*.json execution
    # sheet = browser.new_page("https://docs.google.com/spreadsheets/d/.../edit#gid=0", name="kpi-sheet", allowed_origins=["https://docs.google.com"])
    # csv_text = sheet.run_routine("read_sheet_csv")["outputs"]["csv"]

    # Capture viewport, full-page, or element screenshots in the background
    page.screenshot("viewport.png")
    page.screenshot("fullpage.png", full_page=True)
    page.locator("h1").first.screenshot("heading.png")
```

To attach to an existing tab you shared from the toolbar popup (released, **never closed**, on exit):

```python
with BrowserBridge(browser="Work") as browser:
    shared = browser.page(42)
    print(shared.snapshot())
```

---

## Chained Locators & Actionability

```python
page.get_by_role("button", name="Save", exact=True).click()
page.get_by_label("Email").fill("ada@example.com")
page.get_by_placeholder("Search...").type("latency")
page.get_by_test_id("env-select").select_option("production")
page.get_by_label("Enable alerts").check()

# Chaining across regions or open Shadow DOM boundaries
row = page.get_by_role("region", name="Deployments").locator("tr").filter(has_text="v0.7.0")
row.get_by_role("button", name="Inspect").click()
```

- Scalar reads and actions enforce **strict uniqueness** (`strict_locator` if `> 1` elements match; narrow with `.first`, `.last`, or `.nth(i)`).
- Covered elements fail explicitly with `not_actionable` rather than clicking an unexpected modal overlay.
- Cross-origin iframe access: `page.in_frame(frame_id).get_by_role("button", name="Continue").click()`.

---

## Three Distinct HTTP Fetch Modes (Zero Cookie Export)

```python
# 1. Authenticated in-tab fetch (uses browser login state + normal browser CORS; needs NO page-script eval toggle)
auth_resp = page.request.get("https://app.example.com/api/me")
print(auth_resp.status, auth_resp.json())

# 2. Anonymous Rust-host HTTP fetch (zero browser cookies; ideal for public CDNs)
cdn_resp = browser.request.get("https://cdn.example.com/public-asset.svg")
raw_bytes = cdn_resp.body()

# 3. Adaptive smart_fetch (tries fast host HTTP first; learns 403 WAF domains and falls back to page.request)
smart_resp = browser.smart_fetch("https://app.example.com/data.json", page=page)
```

---

## Building Clients in Other Languages (Go / Node / Rust / C#)

Any local language can either:
1. Connect directly to `\\.\pipe\browser-bridge.<SID>.<browser>.<instance>` (Windows) or `$XDG_RUNTIME_DIR/browser-bridge/browser-bridge.<user>.<browser>.<instance>` (Unix) and send `{"type":"hello","clientName":"my-client"}\n` followed by `{"id":1,"method":"page.snapshot","params":{"tabId":42}}\n`.
2. Spawn `BrowserBridge rpc` over UTF-8 `stdin`/`stdout` (`{"id":1,"method":"bridge.connect","params":{}}`).

See **[docs/IPC_PROTOCOL.md](https://github.com/dcluomax/browser-bridge/blob/main/docs/IPC_PROTOCOL.md)** for full wire framing and error codes.
