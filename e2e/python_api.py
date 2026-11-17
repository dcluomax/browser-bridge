import argparse
import os
import tempfile
import time
import unittest

from browser_bridge import BrowserBridge, BridgeError, BridgeTimeoutError


parser = argparse.ArgumentParser()
parser.add_argument("--base", required=True)
parser.add_argument("--browser", required=True)
parser.add_argument("--host", required=True)
args = parser.parse_args()
os.environ["BROWSER_BRIDGE_HOST"] = args.host
os.environ["BROWSER_BRIDGE_BROWSER"] = args.browser


class ManagedApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.browser = BrowserBridge().start()
        cls.addClassCleanup(cls.browser.close)
        cls.page = cls.browser.new_page()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()

    def setUp(self):
        response = self.page._call("page.navigate", {"url": args.base + "/playwright.html", "waitUntil": "domcontentloaded", "navigationTrace": True})
        self.assertEqual(response["status"], 200, response)

    def test_find_and_read_all_common_locator_kinds(self):
        page = self.page
        locators = [
            page.get_by_role("button", name="Increment", exact=True),
            page.get_by_label("Full name", exact=True),
            page.get_by_placeholder("Your full name"),
            page.get_by_test_id("name"),
            page.get_by_text("First item", exact=True),
            page.get_by_alt_text("Fixture image"),
            page.get_by_title("Name hint"),
            page.locator("shadow-box").get_by_role("button", name="Shadow choice"),
            page.get_by_role("button", name="Long accessible name " + "x" * 180, exact=True),
        ]
        self.assertEqual([locator.count() for locator in locators], [1] * len(locators))
        self.assertEqual(page.get_by_role("button", name="Hidden action", exact=True).count(), 0)
        self.assertEqual(page.get_by_role("button", name="Hidden action", exact=True, include_hidden=True).count(), 1)

    def test_bulk_text_and_attribute_reads(self):
        self.assertEqual(self.page.locator("li span").all_text_contents(), ["First item", "Second item"])
        self.assertEqual(self.page.locator("li").all_attributes("data-testid"), ["item", "item"])
        self.assertEqual(self.page.locator("li").all_attributes("missing"), [None, None])
        self.assertEqual(self.page.locator("li span").all_inner_texts(), ["First item", "Second item"])

    def test_typed_attributes_counts_and_states(self):
        self.assertIsNone(self.page.locator("#name").get_attribute("missing"))
        self.assertEqual(self.page.locator(".duplicate").count(), 2)
        self.assertTrue(self.page.locator("#delayed-input").is_disabled())
        self.assertFalse(self.page.locator("#absent").is_visible())
        self.assertTrue(self.page.locator("#absent").is_hidden())
        self.assertFalse(self.page.locator("#agree").is_checked())

    def test_count_is_exact_when_summaries_are_bounded(self):
        result = self.page._call("page.locate", {"locator": {"steps": [{"kind": "css", "value": "li"}]}, "maxResults": 1})
        self.assertEqual(result["count"], 2)
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["elements"]), 1)

    def test_fill_select_check_keyboard_and_scroll(self):
        name = self.page.get_by_label("Full name")
        name.fill("Ada")
        self.assertEqual(name.input_value(), "Ada")
        name.press("ArrowDown")
        self.assertEqual(self.page.locator("#keys").text_content(), "ArrowDown")
        self.page.get_by_test_id("color").select_option("blue")
        self.assertEqual(self.page.locator("#color").input_value(), "blue")
        agree = self.page.get_by_label("Agree", exact=True)
        agree.check()
        agree.check()
        self.assertTrue(agree.is_checked())
        agree.uncheck()
        self.assertFalse(agree.is_checked())
        self.page.locator("#frame").scroll_into_view_if_needed()

    def test_prevented_checkbox_is_not_reported_as_success(self):
        with self.assertRaisesRegex(BridgeError, "check_failed"):
            self.page.get_by_label("Prevented checkbox").check()

    def test_scoped_filter_and_nth(self):
        items = self.page.get_by_role("region", name="Items").locator("li")
        for locator, expected in [(items.filter(has_text="Second"), "2"), (items.first, "1"), (items.last, "2"), (items.nth(0), "1")]:
            locator.get_by_role("button").click()
            self.assertEqual(self.page.locator("#chosen").inner_text(), expected)

    def test_ambiguous_and_covered_locators_do_not_click(self):
        with self.assertRaisesRegex(BridgeError, "strict_locator"):
            self.page.get_by_role("button", name="Duplicate", exact=True).click()
        with self.assertRaisesRegex(BridgeError, "not_actionable"):
            self.page.get_by_role("button", name="Covered", exact=True).click()
        self.assertEqual(self.page.locator("#count").text_content(), "0")

    def test_locator_re_resolves_after_dom_replacement(self):
        name = self.page.locator("#name")
        name.fill("Before")
        self.page.get_by_role("button", name="Replace input").click()
        name.fill("After")
        self.assertEqual(name.input_value(), "After")

    def test_actions_wait_for_editability(self):
        self.page.get_by_role("button", name="Enable input").click()
        self.page.get_by_label("Delayed input").fill("Ready", timeout=5000)
        self.assertEqual(self.page.get_by_label("Delayed input").input_value(), "Ready")

    def test_element_lifecycle_waits(self):
        target = self.page.locator("#transient")
        target.wait_for(state="attached")
        target.wait_for(state="hidden")
        self.page.get_by_role("button", name="Reveal", exact=True).click()
        target.wait_for(state="visible", timeout=5000)
        self.assertEqual(target.inner_text(), "Transient content")
        self.page.get_by_role("button", name="Remove", exact=True).click()
        target.wait_for(state="detached", timeout=5000)
        self.assertEqual(target.count(), 0)

    def test_wait_failures_and_exact_timeout(self):
        start = time.monotonic()
        with self.assertRaises(BridgeTimeoutError):
            self.page.locator("#absent").wait_for(timeout=100)
        elapsed = time.monotonic() - start
        self.assertGreaterEqual(elapsed, 0.08)
        self.assertLess(elapsed, 5)
        with self.assertRaises(BridgeError) as invalid:
            self.page.locator("[").wait_for(state="hidden", timeout=100)
        self.assertNotEqual(invalid.exception.code, "timeout")
        with self.assertRaises(BridgeError):
            self.page._call("page.waitFor", {"ref": "e999999", "state": "detached"})

    def test_page_metadata_load_and_url_waits(self):
        self.page.wait_for_load_state("domcontentloaded")
        self.page.wait_for_load_state("load")
        self.page.wait_for_url(args.base + "/playwright.html")
        self.assertEqual(self.page.title(), "Playwright subset fixture")
        self.assertEqual(self.page.url, args.base + "/playwright.html")
        self.assertIn("Mozilla", self.page.user_agent)
        self.page.bring_to_front()

    def test_navigation_http_status_and_redirect(self):
        missing = self.page.goto(args.base + "/not-found")
        self.assertEqual(missing.status, 404)
        self.assertFalse(missing.ok)
        redirected = self.page._call("page.navigate", {"url": args.base + "/redirect", "waitUntil": "domcontentloaded", "navigationTrace": True})
        self.assertEqual(redirected["status"], 200, redirected)
        self.assertEqual(redirected["url"], args.base + "/playwright.html")

    def test_repeated_navigation_status(self):
        for _ in range(20):
            response = self.page._call("page.navigate", {"url": args.base + "/playwright.html", "waitUntil": "domcontentloaded", "navigationTrace": True})
            self.assertEqual(response["status"], 200, response)

    def test_password_reads_remain_masked(self):
        password = self.page.locator("#password")
        self.assertEqual(password.input_value(), "[masked]")
        self.assertEqual(password.get_attribute("value"), "[masked]")
        self.assertEqual(password.all_attributes("value"), ["[masked]"])

    def test_screenshot_bytes_and_file(self):
        with tempfile.TemporaryDirectory(prefix="bb-sdk-image-") as directory:
            target = Path(directory).joinpath("viewport.png")
            data = self.page.screenshot(target)
            self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertEqual(data, target.read_bytes())
            vp_w, vp_h = struct.unpack(">II", data[16:24])

            full_target = Path(directory).joinpath("fullpage.png")
            full_data = self.page.screenshot(full_target, full_page=True)
            self.assertTrue(full_data.startswith(b"\x89PNG\r\n\x1a\n"))
            fp_w, fp_h = struct.unpack(">II", full_data[16:24])
            self.assertEqual(fp_w, vp_w)
            self.assertGreater(fp_h, vp_h + 800)

            el_target = Path(directory).joinpath("heading.png")
            el_data = self.page.locator("h1").screenshot(el_target)
            self.assertTrue(el_data.startswith(b"\x89PNG\r\n\x1a\n"))
            el_w, el_h = struct.unpack(">II", el_data[16:24])
            self.assertGreater(el_w, 0)
            self.assertLess(el_h, vp_h)

            fg = self.browser.new_page(args.base + "/second.html")
            try:
                fg.bring_to_front()
                tabs_before = {t["tabId"]: t["active"] for t in self.browser.call("tabs.list")["tabs"]}
                self.assertFalse(tabs_before[self.page.tab_id])
                bg_data = self.page.screenshot()
                self.assertTrue(bg_data.startswith(b"\x89PNG\r\n\x1a\n"))
                tabs_after = {t["tabId"]: t["active"] for t in self.browser.call("tabs.list")["tabs"]}
                self.assertFalse(tabs_after[self.page.tab_id], "Background screenshot must not steal active tab focus")
            finally:
                fg.close()
                self.page.bring_to_front()

    def test_page_fetch_uses_browser_session_without_exporting_cookies(self):
        response = self.page.request.get(args.base + "/authenticated")
        self.assertEqual(response.status, 200)
        self.assertTrue(response.json()["authenticated"])
        anonymous = self.browser.request.get(args.base + "/authenticated")
        self.assertEqual(anonymous.status, 401)
        self.assertFalse(anonymous.json()["authenticated"])
        self.assertNotIn("set-cookie", response.headers)

    def test_fetch_respects_cors_without_silent_privileged_fallback(self):
        other_origin = args.base.replace("127.0.0.1", "localhost") + "/authenticated"
        with self.assertRaisesRegex(BridgeError, "request_failed"):
            self.page.request.get(other_origin)

    def test_typed_fetch_works_without_unsafe_eval_under_csp(self):
        self.page.goto(args.base + "/fetch-csp.html")
        response = self.page.request.get(args.base + "/binary?size=1024")
        self.assertEqual(response.body(), b"a" * 1024)
        self.assertFalse(self.browser.call("status")["allowEvaluate"])

    def test_twenty_mib_download_roundtrips_and_limit_is_exact(self):
        maximum = 20 * 1024 * 1024
        response = self.page.request.get(f"{args.base}/binary?size={maximum}", max_bytes=maximum, timeout=60_000)
        self.assertEqual(len(response.body()), maximum)
        self.assertEqual(hashlib.sha256(response.body()).digest(), hashlib.sha256(b"a" * maximum).digest())
        with self.assertRaisesRegex(BridgeError, "body_too_large"):
            self.page.request.get(f"{args.base}/binary?size={maximum + 1}", max_bytes=maximum)
        with self.assertRaisesRegex(BridgeError, "body_too_large"):
            self.page.request.get(f"{args.base}/binary?size=1025&chunked=1", max_bytes=1024)
        with self.assertRaisesRegex(BridgeError, "body_too_large"):
            self.browser.request.get(f"{args.base}/binary?size=1025&chunked=1", max_bytes=1024)

    def test_cross_origin_iframe_locator_and_large_frame_id(self):
        deadline = time.monotonic() + 15
        frame = None
        while frame is None and time.monotonic() < deadline:
            frame = re.search(r'button "Frame button" \[ref=f(\d+)e\d+\]', self.page.snapshot())
            if frame is None:
                time.sleep(0.1)
        self.assertIsNotNone(frame)
        button = self.page.in_frame(int(frame[1])).get_by_role("button", name="Frame button")
        self.assertEqual(button.count(), 1)
        button.click()
        self.page._call("page.waitFor", {"text": "Frame clicked"})

    def test_unshared_tabs_and_page_script_gate_remain_enforced(self):
        with self.assertRaises(BridgeError):
            self.browser.page(999999)
        with self.assertRaisesRegex(BridgeError, "disabled"):
            self.page.evaluate("1 + 1")
        self.assertFalse(self.browser.call("status")["allowEvaluate"])

    def test_webmcp_read_write_acl_upload_and_dialog(self):
        tools = {t["name"]: t for t in self.page.webmcp_tools()}
        self.assertIn("lookup_quote", tools)
        self.assertEqual(tools["lookup_quote"]["kind"], "declarative")
        self.assertTrue(tools["lookup_quote"]["readOnlyHint"])
        self.assertIn("read_counter", tools)
        self.assertTrue(tools["read_counter"]["readOnlyHint"])
        self.assertIn("bump_counter", tools)
        self.assertFalse(tools["bump_counter"]["readOnlyHint"])

        # Read-only client can read snapshots & call readOnlyHint=True WebMCP tools, but cannot click or call mutating WebMCP tools!
        with BrowserBridge() as creator:
            released = creator.call("tabs.new", {"url": args.base + "/playwright.html", "active": False})["tabId"]
        try:
            with BrowserBridge(read_only=True) as ro:
                ro_page = ro.page(released)
                self.assertIn("Playwright subset fixture", ro_page.snapshot())
                state_res = ro_page.call_webmcp("read_counter")
                self.assertEqual(state_res["kind"], "imperative")
                with self.assertRaisesRegex(BridgeError, "read_only"):
                    ro_page.locator("#increment").click()
                with self.assertRaisesRegex(BridgeError, "read_only"):
                    ro_page.call_webmcp("bump_counter", {"delta": 5})
        finally:
            self.browser.call("tabs.close", {"tabId": released})

        # Read-write client can invoke both imperative and declarative WebMCP tools
        bumped = self.page.call_webmcp("bump_counter", {"delta": 3})
        self.assertEqual(bumped["result"]["count"], 3)
        decl = self.page.call_webmcp("lookup_quote", {"symbol": "MSFT", "range": "1y"}, submit=False)
        self.assertEqual(decl["kind"], "declarative")
        self.assertEqual(self.page.locator("#quote-activated").inner_text(), "lookup_quote:MSFT:1y")

        # Chunked file upload (500 KB > 384 KB single chunk)
        with tempfile.TemporaryDirectory(prefix="bb-upload-") as up_dir:
            payload = b"u" * (500 * 1024)
            sample = Path(up_dir) / "report.txt"
            sample.write_bytes(payload)
            attached = self.page.locator("#upload-file").set_input_files(sample)
            self.assertEqual(attached, ["report.txt"])
            self.assertEqual(self.page.locator("#uploaded-info").inner_text(), f"report.txt:{len(payload)}")

        # Armed dialog handling
        self.page.handle_dialog(accept=True, arm_next=True)
        self.page.locator("#confirm-btn").click()
        self.assertEqual(self.page.locator("#confirm-out").inner_text(), "accepted")

        # SVG diagram shape visibility + drag + #fragment URL fast navigation + Site Routines
        snap_text = self.page.snapshot()
        self.assertIn('shape "Kafka Node"', snap_text)
        self.assertIn('shape "Spark Sink"', snap_text)
        self.assertNotIn("Hidden template", snap_text)
        self.assertEqual(self.page.get_by_role("shape", name="Kafka Node").count(), 1)

        self.page.locator("#drag-src").drag_to(self.page.locator("#drag-dst"))
        self.assertEqual(self.page.locator("#drag-out").inner_text(), "dropped")

        # Same-document #fragment jump (instant, status=None) + cross-document #fragment load (status=200, fast)
        t_hash = time.monotonic()
        same_doc_nav = self.page.goto(args.base + "/playwright.html#diagram-canvas")
        self.assertIsNone(same_doc_nav.status)
        self.assertLess(time.monotonic() - t_hash, 2.0)

        self.page.goto(args.base + "/second.html")
        t_cross_hash = time.monotonic()
        cross_hash_nav = self.page.goto(args.base + "/playwright.html#diagram-canvas")
        self.assertEqual(cross_hash_nav.status, 200)
        self.assertLess(time.monotonic() - t_cross_hash, 5.0)

        # Save, run, and delete a custom parameterized Site Routine
        test_domain = "e2e-routine.example"
        self.page.save_routine(
            domain=test_domain,
            note="Read heading and fill Full name in 1 call.",
            routine={
                "name": "fill_and_read",
                "description": "Fills Full name and reads h1.",
                "readOnly": False,
                "params": {"person": {"type": "string", "required": True}},
                "steps": [
                    {"op": "type", "params": {"text": "{{person}}", "clear": True, "locator": {"steps": [{"kind": "css", "value": "#name"}]}}},
                    {"op": "query", "params": {"operation": "inputValue", "locator": {"steps": [{"kind": "css", "value": "#name"}]}}, "saveAs": "typedName"},
                ],
            },
        )
        try:
            run_out = self.page.run_routine("fill_and_read", {"person": "Grace Hopper"}, domain=test_domain)
            self.assertEqual(run_out["outputs"]["typedName"], "Grace Hopper")
        finally:
            self.page.save_routine(domain=test_domain, delete_routine="fill_and_read")

    def test_adaptive_error_learning_optimizes_perf(self):
        self.page.save_routine(domain="127.0.0.1", reset_access_profile=True)
        try:
            # 1. Stalled window.onload beacon (4.5s) hits 1.2s load timeout on Visit 1, recovers via DOMContentLoaded,
            #    and teaches SiteLearner preferredWaitUntil="domcontentloaded" so Visit 2 finishes in <0.8s!
            nav1 = self.page.goto(args.base + "/stalled-load.html", timeout=1_200)
            self.assertEqual(nav1.status, 200)
            self.assertEqual(self.page.locator("#ready-title").inner_text(), "Instant DOM Ready")

            prof_after_nav1 = self.page.access_profile(domain="127.0.0.1")
            self.assertEqual(prof_after_nav1.get("preferredWaitUntil"), "domcontentloaded")
            self.assertGreaterEqual(prof_after_nav1["stats"]["loadTimeouts"], 1)

            t_visit2 = time.perf_counter()
            nav2 = self.page.goto(args.base + "/stalled-load.html", timeout=5_000)
            visit2_s = time.perf_counter() - t_visit2
            self.assertEqual(nav2.status, 200)
            self.assertLess(visit2_s, 0.85, f"Learned domcontentloaded profile should skip 4.5s stalled beacon, took {visit2_s:.3f}s")

            # 2. Covered button triggers not_actionable -> agent clicks #accept-cookies -> retry #buy-btn succeeds ->
            #    SiteLearner automatically learns blocker <div#cookie-wall> AND the recovery action triad!
            with self.assertRaisesRegex(BridgeError, "covered by <div#cookie-wall>"):
                self.page.locator("#buy-btn").click(timeout=1_500)
            self.page.locator("#accept-cookies").click()
            self.page.locator("#buy-btn").click()
            self.assertEqual(self.page.locator("#buy-btn").inner_text(), "Purchased")

            prof_after_recovery = self.page.access_profile(domain="127.0.0.1")
            self.assertIn("<div#cookie-wall>", prof_after_recovery.get("knownBlockers", []))
            recoveries = prof_after_recovery.get("learnedRecoveries", [])
            self.assertTrue(
                any(r.get("blocker") == "<div#cookie-wall>" and r.get("recoveryMethod") == "page.click" for r in recoveries),
                recoveries,
            )

            # 3. Direct HTTP 403 WAF block -> smart_fetch learns directHttpBlocked=True and routes via browser session!
            waf_resp = self.browser.smart_fetch(args.base + "/waf-protected", page=self.page)
            self.assertEqual(waf_resp.status, 200)
            self.assertTrue(waf_resp.json()["authenticated"])
            prof_after_waf = self.page.access_profile(domain="127.0.0.1")
            self.assertTrue(prof_after_waf.get("directHttpBlocked"))
            self.assertEqual(prof_after_waf.get("directHttpStatus"), 403)
        finally:
            self.page.save_routine(domain="127.0.0.1", reset_access_profile=True)

    def test_shared_inventory_capability_and_agent_private_boundary(self):
        self.assertEqual(self.browser.call("status")["sharedTabInventory"], 1)
        with BrowserBridge() as observer:
            visible = observer.call("tabs.inventory")["tabs"]
            self.assertNotIn(self.page.tab_id, [tab["tabId"] for tab in visible])
            with BrowserBridge() as creator:
                released = creator.call("tabs.new", {"active": False})["tabId"]
            try:
                row = next(tab for tab in observer.call("tabs.inventory")["tabs"] if tab["tabId"] == released)
                self.assertTrue(row["controllable"])
                self.assertFalse(row["busy"])
                self.assertFalse(row["sharedByUser"])
                with BrowserBridge() as owner:
                    owner.call("page.info", {"tabId": released})
                    self.assertNotIn(released, [tab["tabId"] for tab in observer.call("tabs.inventory")["tabs"]])
                self.assertIn(released, [tab["tabId"] for tab in observer.call("tabs.inventory")["tabs"]])
            finally:
                observer.call("tabs.close", {"tabId": released})

    def test_context_closes_only_its_own_tabs(self):
        with BrowserBridge() as other:
            created = other.new_page(args.base + "/second.html")
            self.assertEqual([page.tab_id for page in other.pages], [created.tab_id])
            with self.assertRaisesRegex(BridgeError, "forbidden"):
                other.page(self.page.tab_id)
        self.assertEqual(self.page.title(), "Playwright subset fixture")
        self.assertNotIn(created.tab_id, [page.tab_id for page in self.browser.pages])

    def test_direct_pipe_connection_without_rpc_subprocess(self):
        saved = os.environ.pop("BROWSER_BRIDGE_HOST", None)
        try:
            with BrowserBridge(browser=args.browser) as direct:
                self.assertEqual(direct.call("status")["managedApi"], 1)
                resp = direct.request.get(args.base + "/authenticated")
                self.assertEqual(resp.status, 401)
        finally:
            if saved is not None:
                os.environ["BROWSER_BRIDGE_HOST"] = saved


if __name__ == "__main__":
    unittest.main(argv=["python_api.py"], defaultTest=os.environ.get("BROWSER_BRIDGE_E2E_TEST"), verbosity=2)
