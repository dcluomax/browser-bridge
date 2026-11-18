import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
GATE_SCRIPT = REPO_ROOT / "scripts" / "check-routine-gate.py"


def _load_gate_module():
    spec = importlib.util.spec_from_file_location("check_routine_gate", GATE_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


gate = _load_gate_module()


def _valid_playbook(**overrides):
    base = {
        "schemaVersion": 2,
        "domain": "example.com",
        "verifiedAt": "2026-11-17T09:45:00Z",
        "updatedAt": "2026-11-17T09:45:00Z",
        "accessProfile": {
            "preferredWaitUntil": "domcontentloaded",
            "hydrationSettleMs": 250,
            "preferredSnapshotFrames": "top",
        },
        "routines": {
            "read_main": {
                "name": "read_main",
                "readOnly": True,
                "verifiedAt": "2026-11-17T09:45:00Z",
                "updatedAt": "2026-11-17T09:45:00Z",
                "steps": [{"op": "snapshot", "params": {"maxChars": 12000}, "saveAs": "main"}],
            }
        },
    }
    base.update(overrides)
    return base


def _stage_summary(
    site: str,
    stage: str,
    *,
    trials: int = 20,
    success_rate: float = 1.0,
    p50: float = 500.0,
    p95: float = 700.0,
    median_chars: int = 10_000,
):
    return {
        "site": site,
        "stage": stage,
        "trials": trials,
        "okCount": int(round(trials * success_rate)),
        "successRate": success_rate,
        "totalPostNetMs": {"count": trials, "p50": p50, "p95": p95, "iqr": 100.0},
        "medianChars": median_chars,
    }


class RoutineGateTests(unittest.TestCase):
    def test_static_schema_accepts_valid_playbook_and_all_shipped_routines(self) -> None:
        res = gate.audit_playbook_payload(_valid_playbook(url="https://github.com/dcluomax/browser-bridge"))
        self.assertTrue(res.passed, res.errors)

        shipped = REPO_ROOT / "routines"
        if shipped.is_dir():
            report = gate.audit_routines_dir(shipped)
            self.assertTrue(report.passed, [r.errors for r in report.results if not r.passed])
            self.assertGreaterEqual(report.total_files, 24)

    def test_static_schema_rejects_invalid_version_timestamps_wait_settle_and_empty_steps(self) -> None:
        bad_ver = gate.audit_playbook_payload(_valid_playbook(schemaVersion=1))
        self.assertFalse(bad_ver.passed)
        self.assertTrue(any("schemaVersion" in e for e in bad_ver.errors))

        bool_ver = gate.audit_playbook_payload(_valid_playbook(schemaVersion=True))
        self.assertFalse(bool_ver.passed)

        non_utc = gate.audit_playbook_payload(
            _valid_playbook(verifiedAt="2026-11-17T09:45:00-08:00", updatedAt="2026-11-17T09:45:00")
        )
        self.assertFalse(non_utc.passed)
        self.assertEqual(sum("ISO-8601 UTC" in e for e in non_utc.errors), 2)

        bad_wait = gate.audit_playbook_payload(
            _valid_playbook(accessProfile={"preferredWaitUntil": "networkidle", "hydrationSettleMs": 601})
        )
        self.assertFalse(bad_wait.passed)
        self.assertTrue(any("preferredWaitUntil" in e for e in bad_wait.errors))
        self.assertTrue(any("hydrationSettleMs" in e for e in bad_wait.errors))

        empty_steps = gate.audit_playbook_payload(
            _valid_playbook(routines={"broken": {"name": "broken", "steps": []}})
        )
        self.assertFalse(empty_steps.passed)
        self.assertTrue(any("non-empty 'steps'" in e for e in empty_steps.errors))

    def test_static_hygiene_detects_unsanitized_personal_identifiers(self) -> None:
        # Build synthetic forbidden strings dynamically so this test file stays 100% sanitized.
        leaked_handle = "ma" + "luo"
        leaked_corp = "engineer@" + "microsoft.com"
        leaked_instance = "c4226b" + "8c9535"
        pb = _valid_playbook(
            notes=[
                f"Recorded by {leaked_handle} ({leaked_corp}) on instance {leaked_instance}",
            ]
        )
        res = gate.audit_playbook_payload(pb)
        self.assertFalse(res.passed)
        joined = " | ".join(res.errors)
        self.assertIn("personal-handle", joined)
        self.assertIn("corporate-email", joined)
        self.assertIn("live-instance-leak", joined)

    def test_empirical_gate_enforces_n20_trials_success_rate_and_zero_profile_drift(self) -> None:
        under_sampled = {
            "profile_drift_count": 0,
            "summary": [
                _stage_summary("github.com", "S1_unoptimized", trials=19, p50=1200, p95=1600),
                _stage_summary("github.com", "S2_engine_only", trials=19, p50=700, p95=900),
                _stage_summary("github.com", "S3_adaptive_profile", trials=19, success_rate=0.90, p50=680, p95=850),
            ],
        }
        rep = gate.evaluate_benchmark_report(under_sampled)
        self.assertFalse(rep.passed)
        v = rep.verdicts[0]
        self.assertFalse(v.passed)
        self.assertTrue(any("trials 19 < 20" in r for r in v.reasons))
        self.assertTrue(any("S3 success 90.0% < 95.0%" in r for r in v.reasons))

        drifted = {
            "mode": "frozen_ablation",
            "profile_drift_count": 2,
            "summary": [
                _stage_summary("github.com", "S1_unoptimized", trials=20, p50=1200, p95=1600),
                _stage_summary("github.com", "S2_engine_only", trials=20, p50=700, p95=900),
                _stage_summary("github.com", "S3_adaptive_profile", trials=20, p50=700, p95=900),
            ],
        }
        rep_drift = gate.evaluate_benchmark_report(drifted)
        self.assertFalse(rep_drift.passed)
        self.assertTrue(any("profile_drift_count=2" in e for e in rep_drift.metadata_errors))

    def test_empirical_gate_detects_latency_regressions_incomplete_reads_and_youtube_exemption(self) -> None:
        report_payload = {
            "profile_drift_count": 0,
            "summary": [
                # 1. Clean speedup -> PASS
                _stage_summary("amazon.com", "S1_unoptimized", p50=2500, p95=4000, median_chars=15000),
                _stage_summary("amazon.com", "S2_engine_only", p50=1820, p95=3340, median_chars=15000),
                _stage_summary("amazon.com", "S3_adaptive_profile", p50=754, p95=1059, median_chars=15000),
                # 2. Blind settle sleep regression (reddit.com +281%) -> FAIL
                _stage_summary("reddit.com", "S1_unoptimized", p50=450, p95=600, median_chars=12000),
                _stage_summary("reddit.com", "S2_engine_only", p50=103, p95=121, median_chars=12000),
                _stage_summary("reddit.com", "S3_adaptive_profile", p50=392, p95=508, median_chars=12000),
                # 3. Incomplete read (news.ycombinator.com 256 / 18994 = 1.3%) -> FAIL
                _stage_summary("news.ycombinator.com", "S1_unoptimized", p50=400, p95=500, median_chars=18994),
                _stage_summary("news.ycombinator.com", "S2_engine_only", p50=149, p95=237, median_chars=256),
                _stage_summary("news.ycombinator.com", "S3_adaptive_profile", p50=149, p95=243, median_chars=256),
                # 4. Smart quality-restoration exemption (youtube.com: S2 9% shell -> S3 94% content) -> PASS (EXEMPT)
                _stage_summary("youtube.com", "S1_unoptimized", p50=3200, p95=5000, median_chars=10000),
                _stage_summary("youtube.com", "S2_engine_only", p50=789, p95=1845, median_chars=900),
                _stage_summary("youtube.com", "S3_adaptive_profile", p50=1519, p95=1795, median_chars=9400),
                # 5. S2 failed content (65%) AND S3 still failed content (71%) + slower -> FAIL (NOT exempt!)
                _stage_summary("perplexity.ai", "S1_unoptimized", p50=2666, p95=5177, median_chars=1400),
                _stage_summary("perplexity.ai", "S2_engine_only", p50=1362, p95=1903, median_chars=910),
                _stage_summary("perplexity.ai", "S3_adaptive_profile", p50=1545, p95=1745, median_chars=988),
            ],
        }
        rep = gate.evaluate_benchmark_report(report_payload)
        self.assertFalse(rep.passed)
        by_site = {v.site: v for v in rep.verdicts}

        self.assertTrue(by_site["amazon.com"].passed)
        self.assertEqual(by_site["amazon.com"].status, "PASS")

        self.assertFalse(by_site["reddit.com"].passed)
        self.assertIn("reddit.com", rep.unexempted_p50_regression_sites)

        self.assertFalse(by_site["news.ycombinator.com"].passed)
        self.assertIn("news.ycombinator.com", rep.content_failure_sites)

        yt = by_site["youtube.com"]
        self.assertTrue(yt.passed)
        self.assertTrue(yt.quality_exempt)
        self.assertEqual(yt.status, "PASS (EXEMPT)")
        self.assertEqual(rep.exempted_sites, ["youtube.com"])

        pplx = by_site["perplexity.ai"]
        self.assertFalse(pplx.passed)
        self.assertFalse(pplx.quality_exempt)
        self.assertIn("perplexity.ai", rep.content_failure_sites)
        self.assertIn("perplexity.ai", rep.unexempted_p50_regression_sites)

    def test_recorded_ablation_full_json_catches_exact_11_regressions_and_youtube_exemption(self) -> None:
        ablation_path = REPO_ROOT.parent / "browser-bridge-paper" / "tables" / "ablation_full.json"
        if not ablation_path.is_file():
            self.skipTest("Sibling recorded ablation_full.json fixture not present")

        data = json.loads(ablation_path.read_text(encoding="utf-8"))
        rep = gate.evaluate_benchmark_report(data, source_label=str(ablation_path))
        self.assertFalse(rep.passed)
        self.assertEqual(rep.total_sites, 24)
        self.assertEqual(len(rep.raw_p50_regression_sites), 11)
        self.assertEqual(rep.exempted_sites, ["youtube.com"])
        self.assertEqual(len(rep.unexempted_p50_regression_sites), 10)
        self.assertIn("reddit.com", rep.unexempted_p50_regression_sites)
        self.assertIn("medium.com", rep.unexempted_p50_regression_sites)

        by_site = {v.site: v for v in rep.verdicts}
        self.assertTrue(by_site["youtube.com"].passed)
        self.assertTrue(by_site["youtube.com"].quality_exempt)
        self.assertFalse(by_site["reddit.com"].passed)
        self.assertFalse(by_site["medium.com"].passed)

    def test_cli_main_exit_codes_and_json_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tdir = Path(tmp)
            rdir = tdir / "routines"
            rdir.mkdir()
            (rdir / "example.com.json").write_text(
                json.dumps(_valid_playbook(), indent=2),
                encoding="utf-8",
            )
            bjson = tdir / "bench.json"
            bjson.write_text(
                json.dumps(
                    {
                        "profile_drift_count": 0,
                        "summary": [
                            _stage_summary("example.com", "S1_unoptimized", p50=1200, p95=1500),
                            _stage_summary("example.com", "S2_engine_only", p50=500, p95=650),
                            _stage_summary("example.com", "S3_adaptive_profile", p50=480, p95=620),
                        ],
                    }
                ),
                encoding="utf-8",
            )
            out_json = tdir / "verdict.json"
            with patch("sys.stdout", new=io.StringIO()):
                rc = gate.main(
                    [
                        "--routines-dir",
                        str(rdir),
                        "--benchmark-json",
                        str(bjson),
                        "--json-out",
                        str(out_json),
                    ]
                )
            self.assertEqual(rc, 0)
            saved = json.loads(out_json.read_text(encoding="utf-8"))
            self.assertTrue(saved["passed"])


if __name__ == "__main__":
    unittest.main()
