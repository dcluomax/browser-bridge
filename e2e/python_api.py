import argparse
import os
from pathlib import Path
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
            # 1. SiteLearner v2 hysteresis (k >= 3): Visits 1 & 2 record loadTimeouts without single-spike switching;
            #    Visit 3 crosses k=3 and switches preferredWaitUntil="domcontentloaded", so Visit 4 finishes in <0.85s!
            for sample_idx in range(1, 4):
                nav = self.page.goto(args.base + f"/stalled-load.html?visit={sample_idx}", timeout=1_200)
                self.assertEqual(nav.status, 200)
                self.assertEqual(self.page.locator("#ready-title").inner_text(), "Instant DOM Ready")
                prof_i = self.page.access_profile(domain="127.0.0.1")
                self.assertGreaterEqual(prof_i["stats"]["loadTimeouts"], sample_idx)
                if sample_idx < 3:
                    self.assertIsNone(prof_i.get("preferredWaitUntil"), "k < 3 must not switch preferredWaitUntil prematurely")
                else:
                    self.assertEqual(prof_i.get("preferredWaitUntil"), "domcontentloaded")

            t_visit4 = time.perf_counter()
            nav4 = self.page.goto(args.base + "/stalled-load.html?visit=4", timeout=5_000)
            visit4_s = time.perf_counter() - t_visit4
            self.assertEqual(nav4.status, 200)
            self.assertLess(visit4_s, 0.85, f"Learned domcontentloaded profile should skip 4.5s stalled beacon, took {visit4_s:.3f}s")

            # Verify redacted activity.jsonl recorded our visits while stripping ?visit=... query parameters!
            routines_env = os.environ.get("BROWSER_BRIDGE_ROUTINES_DIR", "")
            if routines_env:
                act_path = Path(routines_env).parent / "logs" / "activity.jsonl"
                deadline_log = time.monotonic() + 2.0
                while time.monotonic() < deadline_log and not act_path.is_file():
                    time.sleep(0.05)
                self.assertTrue(act_path.is_file(), f"Expected activity log at {act_path}")
                raw_log = act_path.read_text(encoding="utf-8")
                self.assertIn("/stalled-load.html", raw_log)
                self.assertNotIn("visit=", raw_log, "Query strings must never be written to activity.jsonl")

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

    def test_080_bg_groups_allowlist_challenge_handoff_demo_network_console(self):
        import threading

        # 1. Background silent open (active=False default), collapsed [Agent] group, and persistent named tab reuse
        self.page.bring_to_front()
        named1 = self.browser.new_page(args.base + "/second.html", name="work-doc", group="Agent-Batch")
        try:
            tabs_map = {t["tabId"]: t for t in self.browser.call("tabs.list")["tabs"]}
            self.assertFalse(tabs_map[named1.tab_id]["active"], "Agent tabs must open silently in background by default")
            self.assertEqual(tabs_map[named1.tab_id].get("name"), "work-doc")
            self.assertEqual(tabs_map[named1.tab_id].get("group"), "Agent-Batch")

            # Re-requesting the same named tab reuses it without navigating away from /second.html
            named2 = self.browser.new_page(args.base + "/playwright.html", name="work-doc")
            self.assertEqual(named2.tab_id, named1.tab_id)
            self.assertTrue(named2.url.endswith("/second.html"), named2.url)

            # 2. Per-tab allowedOrigins fence blocks cross-host navigation
            self.browser.allowlist(["127.0.0.1"], tab_id=named1.tab_id)
            port = args.base.rsplit(":", 1)[-1]
            with self.assertRaisesRegex(BridgeError, "allowedOrigins|origin_blocked"):
                named1.goto(f"http://localhost:{port}/frame.html")
            self.browser.allowlist(clear=True, tab_id=named1.tab_id)

            # 3. Bot challenge detection on Cloudflare interstitial
            cf_res = named1._call("page.navigate", {"url": args.base + "/cloudflare-challenge.html"})
            self.assertEqual(cf_res.get("challenge", {}).get("kind"), "cloudflare")
            self.assertTrue(cf_res.get("challenge", {}).get("suggestHandoff"))

            # 4. Interactive Handoff (blocking WAIT state on session 1 + Continue resolution via concurrent session 2)
            named1.goto(args.base + "/diag-probe.html")
            handoff_out: dict = {}

            def wait_handoff():
                handoff_out["res"] = named1.handoff("Complete human check", bring_to_front=False, timeout=10_000)

            t_ho = threading.Thread(target=wait_handoff)
            t_ho.start()
            with BrowserBridge() as helper:
                deadline = time.monotonic() + 5.0
                saw_wait = False
                while time.monotonic() < deadline:
                    active_hos = helper.call("page.handoff", {"action": "status"}).get("handoffs", [])
                    if any(h.get("tabId") == named1.tab_id for h in active_hos):
                        saw_wait = True
                        break
                    time.sleep(0.05)
                self.assertTrue(saw_wait, "Tab should enter WAIT state during handoff")
                helper.call("page.handoff", {"action": "resolve", "tabId": named1.tab_id})
            t_ho.join(timeout=5.0)
            self.assertTrue(handoff_out.get("res", {}).get("completed"))

            # 5. Redacted Network Capture + Console Error Capture + Demonstrate-to-Routine (password-masked)
            named1.clear_console()
            named1.start_network_capture(url_include="/binary")
            named1._call("page.demonstrate", {"action": "start", "instruction": "Run probe flow", "bringToFront": False})

            named1.locator("#secret-pw").fill("MySuperSecretPassword123!")
            named1.locator("#fire-diag").click()
            time.sleep(0.25)
            res_demo = named1.finish_demonstration("finish")
            self.assertTrue(res_demo.get("completed"), res_demo)
            steps = res_demo.get("steps", [])
            serialized_steps = repr(steps)
            self.assertNotIn("MySuperSecretPassword123!", serialized_steps, "Password input must never be recorded!")
            self.assertIn("click", serialized_steps)

            named1.save_routine(
                routine={
                    "name": "taught_probe_flow",
                    "description": "Demonstrated diagnostic flow",
                    "readOnly": False,
                    "params": {},
                    "steps": steps,
                }
            )

            exchanges = named1.stop_network_capture()
            self.assertGreaterEqual(len(exchanges), 1)
            ex = exchanges[-1]
            self.assertIn("api_key=[REDACTED]", ex["url"])
            self.assertNotIn("sk-test-fixture-value-123", ex["url"])
            if ex.get("requestHeaders"):
                self.assertEqual(ex["requestHeaders"].get("authorization"), "[REDACTED]")

            errs = named1.console_messages(level="error")
            self.assertTrue(any("[REDACTED]" in e["text"] and "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" not in e["text"] for e in errs), errs)

            named1.goto(args.base + "/diag-probe.html")
            named1.run_routine("taught_probe_flow")
            self.assertEqual(named1.locator("#fire-diag").inner_text(), "Fired")
        finally:
            try:
                named1.save_routine(delete_routine="taught_probe_flow")
            except Exception:
                pass
            closed_grp = self.browser.call("tabs.close", {"group": "Agent-Batch"})
            self.assertIn(named1.tab_id, closed_grp.get("closedTabs", []))

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

    def test_0110_stable_refs_batch_and_auto_routine_synthesis(self):
        import re as _re

        # 1. Incremental non-destructive refs across locate() + Same-URL Semantic Ref Self-Healing after DOM node replacement!
        self.page.goto(args.base + "/playwright.html")
        snap = self.page.snapshot()
        name_loc = self.page._call("page.locate", {"locator": {"steps": [{"kind": "css", "value": "#name"}]}})
        name_ref = name_loc["elements"][0]["ref"]

        # Calling locate() on unrelated elements must NOT invalidate or renumber name_ref!
        _ = self.page._call("page.locate", {"locator": {"steps": [{"kind": "role", "value": "button"}]}})
        _ = self.page._call("page.locate", {"locator": {"steps": [{"kind": "css", "value": "li"}]}})
        name_loc_again = self.page._call("page.locate", {"locator": {"steps": [{"kind": "css", "value": "#name"}]}})
        self.assertEqual(name_loc_again["elements"][0]["ref"], name_ref)

        # Click "Replace input" (destroys old <input id="name"> node and mounts a brand-new <input id="name"> on same URL)
        self.page.get_by_role("button", name="Replace input").click()
        # Typing via the OLD raw ref must self-heal seamlessly on the same URL!
        self.page._call("page.type", {"ref": name_ref, "text": "SelfHealed", "clear": True})
        self.assertEqual(self.page.locator("#name").input_value(), "SelfHealed")

        # 2. Single-lease multi-step page.batch() execution with variable interpolation and saveAs chaining
        batch_out = self.page.batch(
            [
                {"op": "type", "params": {"locator": {"steps": [{"kind": "css", "value": "#name"}]}, "text": "{{person}}", "clear": True}},
                {"op": "select", "params": {"locator": {"steps": [{"kind": "testId", "value": "color"}]}, "values": ["blue"]}},
                {"op": "check", "params": {"locator": {"steps": [{"kind": "label", "value": "Agree", "exact": True}]}, "checked": True}},
                {"op": "query", "params": {"operation": "inputValue", "locator": {"steps": [{"kind": "css", "value": "#name"}]}}, "saveAs": "typedPerson"},
            ],
            variables={"person": "Alan Turing"},
        )
        self.assertEqual(batch_out["succeeded"], 4)
        self.assertEqual(batch_out["failed"], 0)
        self.assertEqual(batch_out["outputs"]["typedPerson"], "Alan Turing")

        # 3. Live Auto-Routine Trajectory Distillation: explore a 4-step workflow via raw refs (with a failed detour!),
        #    flush via routines(flush_auto=True), verify auto_* routine has zero raw refs, and replay it cleanly!
        auto_tab = self.browser.new_page(args.base + "/playwright.html")
        learned_name = None
        try:
            r_name = auto_tab._call("page.locate", {"locator": {"steps": [{"kind": "css", "value": "#name"}]}})["elements"][0]["ref"]
            r_color = auto_tab._call("page.locate", {"locator": {"steps": [{"kind": "testId", "value": "color"}]}})["elements"][0]["ref"]
            r_agree = auto_tab._call("page.locate", {"locator": {"steps": [{"kind": "label", "value": "Agree", "exact": True}]}})["elements"][0]["ref"]
            r_first_btn = auto_tab._call(
                "page.locate",
                {"locator": {"steps": [{"kind": "role", "value": "region", "name": "Items"}, {"kind": "css", "value": "li"}, {"kind": "nth", "index": 1}, {"kind": "role", "value": "button"}]}},
            )["elements"][0]["ref"]

            # Intentional failed detour (covered button) — must be stripped from distilled routine!
            with self.assertRaises(BridgeError):
                auto_tab.get_by_role("button", name="Covered", exact=True).click(timeout=800)

            auto_tab._call("page.type", {"ref": r_name, "text": "Barbara Liskov", "clear": True})
            auto_tab._call("page.select", {"ref": r_color, "values": ["blue"]})
            auto_tab._call("page.check", {"ref": r_agree, "checked": True})
            auto_tab._call("page.click", {"ref": r_first_btn})

            pb = auto_tab.routines(domain="127.0.0.1", flush_auto=True)
            auto_routines = {
                k: v for k, v in (pb.get("routines") or {}).items()
                if v.get("source") == "auto_learned" and "playwright_html" in k
            }
            self.assertGreaterEqual(len(auto_routines), 1, f"Expected auto-learned routine in {list((pb.get('routines') or {}).keys())}")
            detour_matches = [
                (k, v) for k, v in auto_routines.items()
                if "eliminated 1 failed detour" in v.get("description", "")
            ]
            self.assertEqual(len(detour_matches), 1, f"Expected detour-eliminated routine in {auto_routines}")
            learned_name, learned_def = detour_matches[0]
            self.assertNotIn("'ref'", repr(learned_def["steps"]), "Raw refs must be promoted to semantic locators")

            # Replay the auto-learned routine on a fresh reload with a custom argument override!
            auto_tab.goto(args.base + "/playwright.html")
            param_keys = list((learned_def.get("params") or {}).keys())
            override = {param_keys[0]: "Edsger Dijkstra"} if param_keys else {}
            auto_tab.run_routine(learned_name, override, domain="127.0.0.1")
            self.assertEqual(auto_tab.locator("#name").input_value(), "Edsger Dijkstra")
            self.assertTrue(auto_tab.get_by_label("Agree", exact=True).is_checked())
            self.assertEqual(auto_tab.locator("#chosen").inner_text(), "2")
            _ = snap
            _ = _re
        finally:
            try:
                for k in list((auto_tab.routines(domain="127.0.0.1").get("routines") or {}).keys()):
                    if k.startswith("auto_playwright_html"):
                        auto_tab.save_routine(domain="127.0.0.1", delete_routine=k)
            except Exception:
                pass
            auto_tab.close()

    def test_0120_media_discovery_and_hls_fmp4_video_download(self):
        vid_tab = self.browser.new_page(args.base + "/video-post.html")
        try:
            deadline = time.monotonic() + 5.0
            media_rep = vid_tab.media()
            while time.monotonic() < deadline and not any(c.get("kind") == "hls_master" for c in media_rep.get("candidates", [])):
                time.sleep(0.1)
                media_rep = vid_tab.media()

            self.assertGreaterEqual(len(media_rep["elements"]), 1)
            self.assertEqual(media_rep["elements"][0]["tag"], "video")
            self.assertFalse(media_rep["drmDetected"])
            kinds = [c["kind"] for c in media_rep["candidates"]]
            self.assertIn("hls_master", kinds, media_rep)
            self.assertLess(kinds.index("hls_master"), kinds.index("blob"))

            with tempfile.TemporaryDirectory() as tmp:
                dest = Path(tmp) / "post_video.mp4"
                dl = vid_tab.download_media(dest)
                self.assertEqual(dl["delivery"], "hls_fmp4")
                self.assertEqual(dl["width"], 468)
                self.assertEqual(dl["height"], 720)
                self.assertEqual(dl["segmentsDownloaded"], 2)
                self.assertTrue(dl["validMp4Header"])
                raw = dest.read_bytes()
                self.assertIn(b"ftypisom", raw)
                self.assertIn(b"moofSEG_ONE!", raw)
                self.assertIn(b"moofSEG_TWO!", raw)
        finally:
            vid_tab.close()

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
