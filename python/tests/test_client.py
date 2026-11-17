import base64
import os
import subprocess
import unittest
from unittest.mock import patch

from browser_bridge import BrowserBridge, BridgeError, BridgeTimeoutError, Page, Response
from browser_bridge.client import _DirectTransport, _IpcPeer, _Transport, _timeout


class RecordingBridge(BrowserBridge):
    def __init__(self):
        super().__init__()
        self.calls = []
        self.result = {"value": "value"}

    def call(self, method, params=None, *, timeout=None):
        self.calls.append((method, params, timeout))
        if method == "page.waitFor":
            return {"state": "attached"}
        return self.result


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.browser = RecordingBridge()
        self.page = Page(self.browser, 17)

    def test_locator_chains_are_immutable_and_frame_ids_are_preserved(self):
        root = self.page.in_frame(19_327_352_834).get_by_role("region", name="Items")
        child = root.locator("li").filter(has_text="Second").first.get_by_role("button", exact=True)
        child.click()
        method, params, timeout = self.browser.calls[-1]
        self.assertEqual(method, "page.click")
        self.assertEqual(params["tabId"], 17)
        self.assertEqual(params["locator"]["frameId"], 19_327_352_834)
        self.assertEqual(len(root._steps), 1)
        self.assertEqual(len(params["locator"]["steps"]), 5)

    def test_reads_wait_and_return_null_without_success_fallbacks(self):
        self.browser.result = {"value": None}
        self.assertIsNone(self.page.locator("a").get_attribute("missing", timeout=250))
        self.assertEqual(self.browser.calls[0][0], "page.waitFor")
        self.assertEqual(self.browser.calls[0][1]["timeoutSeconds"], 0.25)
        self.assertEqual(self.browser.calls[-1][1]["attribute"], "missing")

    def test_truncated_reads_are_not_treated_as_complete(self):
        self.browser.result = {"value": "partial", "truncated": True}
        with self.assertRaisesRegex(BridgeError, "truncated"):
            self.page.locator("body").inner_text()
        self.browser.result = {"values": ["partial"], "truncated": True}
        with self.assertRaisesRegex(BridgeError, "truncated"):
            self.page.locator("tr").all_text_contents()

    def test_large_http_body_roundtrips_exactly(self):
        data = bytes(range(256)) * 8192
        response = Response({"status": 200, "url": "https://example.test/", "headers": {}, "data": base64.b64encode(data).decode(), "byteLength": len(data)})
        self.assertEqual(response.body(), data)
        self.assertTrue(response.ok)
        with self.assertRaisesRegex(BridgeError, "byte length"):
            Response({"status": 200, "url": "x", "headers": {}, "data": "YQ==", "byteLength": 0})

    def test_authenticated_and_anonymous_requests_are_explicit(self):
        self.browser.result = {"status": 200, "url": "https://example.test/", "headers": {}, "data": "", "byteLength": 0}
        self.page.request.get("https://example.test/", max_bytes=20 * 1024 * 1024)
        self.assertEqual(self.browser.calls[-1][0], "page.fetch")
        self.assertEqual(self.browser.calls[-1][1]["tabId"], 17)
        self.browser.request.get("https://example.test/")
        self.assertEqual(self.browser.calls[-1][0], "request.fetch")
        self.assertNotIn("tabId", self.browser.calls[-1][1])

    def test_goto_preserves_missing_http_status(self):
        self.browser.result = {"url": "https://example.test/", "loaded": True, "status": None}
        response = self.page.goto("https://example.test/", wait_until="domcontentloaded", timeout=45_000)
        self.assertIsNone(response.status)
        self.assertFalse(response.ok)
        self.assertEqual(self.browser.calls[-1][1]["timeoutMs"], 45_000)
        self.browser.result = {"url": "https://example.test/", "loaded": False}
        with self.assertRaises(BridgeTimeoutError):
            self.page.goto("https://example.test/")

    def test_evaluate_passes_code_and_arguments_as_data(self):
        self.browser.result = {"result": '{"answer":42}'}
        value = self.page.evaluate("(arg) => ({answer: arg})", 42)
        self.assertEqual(value, {"answer": 42})
        self.assertEqual(self.browser.calls[-1][1]["arg"], 42)
        self.assertTrue(self.browser.calls[-1][1]["invoke"])

    def test_closing_page_does_not_close_the_browser(self):
        self.browser._owned_pages[17] = self.page
        self.page.close()
        self.page.close()
        self.assertEqual([call[0] for call in self.browser.calls], ["tabs.close"])
        self.assertNotIn(17, self.browser._owned_pages)
        with self.assertRaisesRegex(BridgeError, "closed"):
            self.page.title()

    def test_timeout_validation(self):
        for value in (0, -1, float("inf"), float("nan"), True, 600_001):
            with self.subTest(value=value), self.assertRaises(ValueError):
                _timeout(value)
        self.assertEqual(_timeout(120_000), 120_000)

    def test_screenshot_rejects_an_unsupported_format_before_calling_browser(self):
        with self.assertRaises(ValueError):
            self.page.screenshot(type="pdf")
        with self.assertRaises(ValueError):
            self.page.locator("#card").screenshot(type="pdf")
        self.assertEqual(self.browser.calls, [])

    def test_full_page_and_locator_screenshots_forward_options_and_infer_format(self):
        self.browser.result = {"data": base64.b64encode(b"img").decode()}
        self.assertEqual(self.page.screenshot(full_page=True), b"img")
        self.assertEqual(self.browser.calls[-1][0], "page.screenshot")
        self.assertTrue(self.browser.calls[-1][1]["fullPage"])
        self.assertEqual(self.browser.calls[-1][1]["format"], "png")

        self.assertEqual(self.page.locator("#chart").screenshot(), b"img")
        self.assertEqual(self.browser.calls[-1][0], "page.screenshot")
        self.assertEqual(self.browser.calls[-1][1]["locator"]["steps"][0]["value"], "#chart")

    def test_read_only_client_blocks_mutations_locally(self):
        ro = BrowserBridge(read_only=True)
        with self.assertRaisesRegex(BridgeError, "read_only"):
            ro.call("page.click", {"tabId": 1, "ref": "e1"})
        with self.assertRaisesRegex(BridgeError, "read_only"):
            ro.call("page.fetch", {"tabId": 1, "url": "https://example.test/", "method": "POST"})

    def test_old_extension_fails_with_update_instruction(self):
        with patch("browser_bridge.client._DirectTransport") as transport:
            transport.return_value.connect.return_value = {"protocol": 1, "status": {}}
            with self.assertRaisesRegex(BridgeError, "reload"):
                BrowserBridge().start()
            transport.return_value.close.assert_called_once()

    def test_explicit_host_uses_rpc_transport_and_rejects_old_extension(self):
        with patch("browser_bridge.client._host_path", return_value="host"), patch("browser_bridge.client._Transport") as transport:
            transport.return_value.call.return_value = {"protocol": 1, "status": {}}
            with self.assertRaisesRegex(BridgeError, "reload"):
                BrowserBridge(host="host").start()
            transport.return_value.close.assert_called_once()

    def test_rpc_does_not_open_a_console_window_from_a_desktop_client(self):
        with patch("browser_bridge.client.subprocess.Popen") as process, patch("browser_bridge.client.threading.Thread"):
            transport = _Transport("BrowserBridge.exe")
            expected = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            self.assertEqual(process.call_args.kwargs["creationflags"], expected)
            transport.close()

    def test_direct_transport_skips_events_and_enforces_timeout_without_self_closing_on_app_error(self):
        class FakeStream:
            _accepts_deadline = True

            def __init__(self, chunks):
                self._chunks = list(chunks)
                self.writes = []
                self.closed = False

            def read(self, _size, deadline=0.0):
                if self._chunks:
                    return self._chunks.pop(0)
                import time
                if time.monotonic() >= deadline or True:
                    raise TimeoutError("simulated timeout")

            def write(self, data):
                self.writes.append(data)

            def flush(self):
                pass

            def close(self):
                self.closed = True

        stream = FakeStream([
            b'{"type":"event","event":"tabs.changed"}\n{"id":1,"ok":false,"error":{"code":"not_found","message":"Missing element"}}\n',
            b'{"id":2,"ok":true,"result":{"value":"ok"}}',
            b"\n",
        ])
        transport = _DirectTransport()
        transport._peer = _IpcPeer(stream, None)
        try:
            with self.assertRaisesRegex(BridgeError, "Missing element"):
                transport.call("page.click", {"tabId": 1}, 500)
            self.assertFalse(transport._closed, "Application-level BridgeError must not tear down the transport!")
            res = transport.call("page.get", {"tabId": 1}, 500)
            self.assertEqual(res, {"value": "ok"})
            with self.assertRaises(BridgeTimeoutError):
                transport.call("page.waitFor", {"tabId": 1}, 50)
            self.assertTrue(transport._closed)
        finally:
            transport.close()

    def test_adaptive_goto_omits_default_wait_until_and_smart_fetch_uses_learned_profile(self):
        self.browser.result = {"url": "https://example.test/", "loaded": True, "status": 200}
        self.page.goto("https://example.test/")
        self.assertNotIn("waitUntil", self.browser.calls[-1][1])
        self.page.goto("https://example.test/", wait_until="load")
        self.assertEqual(self.browser.calls[-1][1]["waitUntil"], "load")

        class ProfileBridge(RecordingBridge):
            def start(self):
                return self

            def site_profile(self, _url):
                return {"accessProfile": {"directHttpBlocked": True, "directHttpStatus": 403}}

        pb = ProfileBridge()
        pb.result = {"status": 200, "url": "https://waf.example.test/api", "headers": {}, "data": "e30=", "byteLength": 2}
        pg = Page(pb, 42)
        resp = pb.smart_fetch("https://waf.example.test/api", page=pg)
        self.assertEqual(resp.status, 200)
        self.assertEqual([c[0] for c in pb.calls], ["page.fetch"])

    def test_010_new_page_allowlist_url_vars_urlencode_and_timestamped_routines(self):
        import json
        from pathlib import Path

        self.browser.result = {"tabId": 88, "reused": True, "url": "https://docs.google.com/spreadsheets/d/sheet-abc-123/edit#gid=42"}
        reused_page = self.browser.new_page(
            "https://docs.google.com/spreadsheets/d/sheet-abc-123/edit#gid=42",
            active=False,
            name="finance-sheet",
            group="Agent",
            allowed_origins=["https://docs.google.com"],
        )
        self.assertEqual(reused_page.tab_id, 88)
        self.assertEqual(self.browser.calls[-1][0], "tabs.new")
        self.assertEqual(
            self.browser.calls[-1][1],
            {
                "active": False,
                "name": "finance-sheet",
                "group": "Agent",
                "allowedOrigins": ["https://docs.google.com"],
            },
        )
        self.assertNotIn(88, self.browser._owned_pages, "Named persistent tabs must not be auto-closed on exit")

        self.browser.allowlist(["*.github.com"], tab_id=88)
        self.assertEqual(self.browser.calls[-1][0], "session.allowlist")
        self.assertEqual(self.browser.calls[-1][1], {"origins": ["*.github.com"], "tabId": 88})

        # Verify automatic {{url.docId}}, {{url.gid}}, {{param:urlencode}}, and op="fetch" (raw + stripHtml)
        class RoutineMockBridge(RecordingBridge):
            def call(self, method, params=None, *, timeout=None):
                self.calls.append((method, params, timeout))
                if method == "page.info":
                    return {"url": "https://docs.google.com/spreadsheets/d/doc_999/edit#gid=7"}
                if method == "page.fetch":
                    url_s = params["url"]
                    raw = b"<html><head><style>body{}</style></head><body><h1>Doc Title</h1><p>Hello &amp; world</p></body></html>" if "mobilebasic" in url_s else b"colA,colB\n1,2\n"
                    return {
                        "status": 200,
                        "url": url_s,
                        "headers": {"content-type": "text/csv"},
                        "data": base64.b64encode(raw).decode(),
                        "byteLength": len(raw),
                    }
                return super().call(method, params, timeout=timeout)

        rb = RoutineMockBridge()
        rpage = Page(rb, 88)
        rpage.routines = lambda **_kw: {
            "domain": "docs.google.com/spreadsheets",
            "routines": {
                "export_csv": {
                    "name": "export_csv",
                    "readOnly": True,
                    "params": {"query": {"default": "select A, B"}},
                    "steps": [
                        {
                            "op": "fetch",
                            "params": {
                                "url": "{{url.origin}}/spreadsheets/d/{{url.docId}}/gviz/tq?tqx=out:csv&gid={{url.gid}}&tq={{query:urlencode}}",
                                "stripHtml": False,
                            },
                            "saveAs": "csv",
                        },
                        {
                            "op": "fetch",
                            "params": {
                                "url": "{{url.origin}}/document/d/{{url.docId}}/mobilebasic",
                                "stripHtml": True,
                            },
                            "saveAs": "docText",
                        },
                    ],
                }
            },
        }
        out = rpage.run_routine("export_csv")
        self.assertEqual(out["outputs"]["csv"], "colA,colB\n1,2\n")
        self.assertEqual(out["outputs"]["docText"], "Doc Title\n\nHello & world")
        fetch_calls = [c for c in rb.calls if c[0] == "page.fetch"]
        self.assertEqual(
            fetch_calls[0][1]["url"],
            "https://docs.google.com/spreadsheets/d/doc_999/gviz/tq?tqx=out:csv&gid=7&tq=select%20A%2C%20B",
        )

        # Verify all 14 repository routines/*.json files follow schemaVersion 2 with ISO-8601 timestamps
        routines_dir = Path(__file__).resolve().parents[2] / "routines"
        routine_files = sorted(routines_dir.glob("*.json"))
        self.assertEqual(len(routine_files), 14)
        for rf in routine_files:
            doc = json.loads(rf.read_text(encoding="utf-8"))
            self.assertEqual(doc.get("schemaVersion"), 2, rf.name)
            self.assertTrue(doc.get("verifiedAt", "").endswith("Z"), rf.name)
            self.assertTrue(doc.get("updatedAt", "").endswith("Z"), rf.name)
            self.assertTrue(doc.get("speedupSummary"), rf.name)
            self.assertGreaterEqual(len(doc.get("routines", {})), 2, rf.name)


if __name__ == "__main__":
    unittest.main()
