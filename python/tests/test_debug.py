import unittest
from unittest.mock import Mock, patch

from browser_bridge import BrowserBridge, BridgeError, Page
from test_client import RecordingBridge


class DebugClientTests(unittest.TestCase):
    def setUp(self):
        self.browser = RecordingBridge()
        self.page = Page(self.browser, 17)

    def test_diagnostics_reuse_structured_locators_and_large_frame_ids(self):
        target = self.page.in_frame(19_327_352_834).locator("#target")
        self.page.computed_styles(locator=target, properties=["display", "color"], pseudo="::before")
        method, params, _ = self.browser.calls[-1]
        self.assertEqual(method, "page.styles")
        self.assertEqual(params["locator"]["frameId"], 19_327_352_834)
        self.assertEqual(params["properties"], ["display", "color"])
        self.page.box_model(ref="e12")
        self.assertEqual(self.browser.calls[-1][0], "page.layout")
        self.assertEqual(self.browser.calls[-1][1]["action"], "box")
        with self.assertRaises(ValueError):
            self.page.computed_styles(ref="e1", locator=target)
        with self.assertRaises(ValueError):
            self.page.patches(frame_id=True)

    def test_temporary_patch_rolls_back_on_error_without_changing_source_inputs(self):
        target = self.page.locator("#target")
        change = {"target": target, "styles": {"color": "red"}}
        self.browser.result = {"id": "patch-handle", "frameId": 0}
        with self.assertRaisesRegex(ValueError, "probe failed"):
            with self.page.temporary_patch([change]) as handle:
                self.assertEqual(handle["id"], "patch-handle")
                raise ValueError("probe failed")
        self.assertIs(change["target"], target)
        self.assertEqual(self.browser.calls[0][0], "page.patch")
        self.assertEqual(self.browser.calls[0][1]["changes"][0]["target"]["locator"]["steps"][0]["value"], "#target")
        self.assertEqual(self.browser.calls[-1][1]["action"], "rollback")
        self.assertEqual(self.browser.calls[-1][1]["id"], "patch-handle")

    def test_baseline_lifecycle_and_har_validate_response_shape(self):
        self.page.create_dom_baseline(locator=self.page.locator("main"), max_nodes=50)
        self.assertEqual(self.browser.calls[-1][1]["maxNodes"], 50)
        self.page.compare_dom_baseline("baseline-handle", max_changes=3)
        self.assertEqual(self.browser.calls[-1][1]["action"], "compare")
        self.page.release_dom_baseline("baseline-handle")
        self.assertEqual(self.browser.calls[-1][1]["action"], "release")
        with self.assertRaisesRegex(BridgeError, "HAR 1.2"):
            self.page.export_har()
        self.browser.result = {"log": {"version": "1.2", "entries": []}}
        self.assertEqual(self.page.export_har()["log"]["version"], "1.2")
        self.browser.result = []
        with self.assertRaisesRegex(BridgeError, "did not return an object"):
            self.page.performance()

    def test_new_debug_batch_operations_and_typed_nested_output_bindings(self):
        self.browser.result = {"id": "baseline-live", "frameId": 0}
        result = self.page.batch([
            {"op": "domBaseline", "params": {"action": "create"}, "saveAs": "baseline"},
            {"op": "domBaseline", "params": {"action": "compare", "id": "{{baseline.id}}", "frameId": "{{baseline.frameId}}"}},
            {"op": "styles", "params": {"properties": ["display"]}},
        ])
        self.assertEqual(result["succeeded"], 3)
        self.assertEqual(self.browser.calls[1][1]["id"], "baseline-live")
        self.assertIsInstance(self.browser.calls[1][1]["frameId"], int)
        self.assertEqual(self.browser.calls[-1][0], "page.styles")
        variables = {"baseline": {"id": "a b", "frameId": 19_327_352_834}, "literal": "{{baseline.id}}"}
        self.assertEqual(Page._interpolate_step("{{baseline.frameId}}", variables), 19_327_352_834)
        self.assertEqual(Page._interpolate_step("id={{baseline.id:urlencode}}", variables), "id=a%20b")
        self.assertEqual(Page._interpolate_step("{{literal}}", variables), "{{baseline.id}}")

    def test_document_handles_are_not_persisted_in_cross_session_routines(self):
        with self.assertRaisesRegex(BridgeError, "live document handle"):
            self.page.batch([
                {"op": "patch", "params": {"action": "rollback", "id": "patch-live"}}
            ], save_as_routine="unsafe")
        self.assertEqual(self.browser.calls, [])
        with self.assertRaisesRegex(BridgeError, "live document handle"):
            self.page.save_routine(routine={
                "name": "cached_baseline",
                "params": {"saved": {"default": "db_old_document"}},
                "steps": [{"op": "domBaseline", "params": {"action": "compare", "id": "{{saved}}"}}],
            })
        self.assertEqual(self.browser.calls, [])
        Page._validate_debug_routine_steps([
            {"op": "domBaseline", "params": {"action": "compare", "id": "{{baseline.id}}"}}
        ])
        Page._validate_debug_routine_steps([
            {"op": "patch", "params": {"changes": [{"attributes": {"id": "target-id"}, "target": {"locator": {}}}]}}
        ])

    def test_read_only_gate_blocks_patches_and_interception_before_connection(self):
        browser = BrowserBridge(read_only=True)
        with patch.object(browser, "start", return_value=browser) as start:
            for method, params in [
                ("page.patch", {"action": "apply"}),
                ("page.patch", {"action": "rollback"}),
                ("page.patch", {"action": "commit"}),
                ("page.intercept", {"action": "set"}),
                ("page.intercept", {"action": "clear"}),
            ]:
                with self.subTest(method=method, params=params), self.assertRaises(BridgeError):
                    browser.call(method, params)
            start.assert_not_called()
            transport = Mock()
            transport.call.return_value = {"active": False}
            browser._transport = transport
            browser.call("page.patch", {"action": "list"})
            browser.call("page.styles", {})
            self.assertTrue(transport.call.call_args.args[1]["readOnly"])
            browser._transport = None


if __name__ == "__main__":
    unittest.main()
