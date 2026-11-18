#!/usr/bin/env python3
"""Network-excluded website optimization benchmark harness for Browser Bridge.

Separates browser HTML network download latency (`networkMs` from W3C
`PerformanceNavigationTiming.responseEnd`, with `webRequest` main_frame fallback)
from pure Browser Bridge automation & page-readiness overhead:

  1. Post-Network Engine Overhead = (goto + snapshot wall time) - networkMs
  2. Zero-Network Warm Snapshot   = snapshot() on the already-open tab (0 ms network)
  3. Zero-Network Warm Routine    = in-DOM run_routine() on the open tab (0 ms network)

Usage:
  PYTHONPATH=python python scripts/benchmark-sites.py
  PYTHONPATH=python python scripts/benchmark-sites.py --compare-unoptimized --sites medium.com,pypi.org,google.com
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import random
import sys
import time
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "python") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "python"))

from browser_bridge import BridgeTimeoutError, BrowserBridge  # noqa: E402

DEFAULT_TARGETS: list[tuple[str, str, str | None]] = [
    ("google.com", "https://www.google.com/search?q=model+context+protocol&hl=en", "read_results"),
    ("github.com", "https://github.com/dcluomax/browser-bridge", "read_main_content"),
    ("perplexity.ai", "https://www.perplexity.ai/", None),
    ("medium.com", "https://medium.com/", None),
    ("arxiv.org", "https://arxiv.org/abs/1706.03762", "read_abstract"),
    ("pypi.org", "https://pypi.org/project/requests/", "read_package_docs"),
    ("npmjs.com", "https://www.npmjs.com/package/typescript", "read_package_readme"),
    ("huggingface.co", "https://huggingface.co/openai-community/gpt2", "read_model_card"),
    ("wikipedia.org", "https://en.wikipedia.org/wiki/Model_Context_Protocol", "read_article"),
    ("news.ycombinator.com", "https://news.ycombinator.com/", "read_front_page"),
]


def percentile(values: list[float], q: float) -> float | None:
    clean = sorted(float(v) for v in values if v is not None and not math.isnan(float(v)))
    if not clean:
        return None
    if len(clean) == 1:
        return clean[0]
    pos = (len(clean) - 1) * (q / 100.0)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return clean[lo]
    return clean[lo] + (clean[hi] - clean[lo]) * (pos - lo)


def summarize_metric(values: list[float | None]) -> dict[str, float | int | None]:
    nums = [float(v) for v in values if isinstance(v, (int, float)) and not math.isnan(float(v))]
    p50 = percentile(nums, 50.0)
    p95 = percentile(nums, 95.0)
    return {
        "count": len(nums),
        "p50": round(p50, 2) if p50 is not None else None,
        "p95": round(p95, 2) if p95 is not None else None,
    }


def interleaved_pass_order(site: str, trial_idx: int, *, interleave: bool, seed: int = 42) -> list[bool]:
    """Returns ordered `unoptimized` flags (`True` = baseline, `False` = optimized) for `(site, trial_idx)`."""
    if not interleave:
        return [True, False]
    pair_idx = (trial_idx - 1) // 2
    rng = random.Random(f"{seed}:{site}:{pair_idx}")
    first_pair = [True, False] if rng.random() < 0.5 else [False, True]
    if (trial_idx - 1) % 2 == 1:
        return [not first_pair[0], not first_pair[1]]
    return first_pair


def _run_routine_no_learn(page: Any, routine_name: str, *, domain: str) -> dict[str, Any]:
    orig_call = getattr(page, "_call", None)
    browser_obj = getattr(page, "browser", None)
    orig_browser_call = getattr(browser_obj, "call", None) if browser_obj is not None else None

    def _wrapped_page_call(method: str, params: dict[str, Any] | None = None, **kwargs: Any) -> Any:
        merged = dict(params or {})
        merged["_noLearn"] = True
        return orig_call(method, merged, **kwargs)

    def _wrapped_browser_call(method: str, params: dict[str, Any] | None = None, **kwargs: Any) -> Any:
        merged = dict(params or {})
        if method != "request.fetch":
            merged["_noLearn"] = True
        return orig_browser_call(method, merged, **kwargs)

    try:
        if callable(orig_call):
            page._call = _wrapped_page_call
        if browser_obj is not None and callable(orig_browser_call):
            browser_obj.call = _wrapped_browser_call
        return page.run_routine(routine_name, domain=domain)
    finally:
        if callable(orig_call):
            page._call = orig_call
        if browser_obj is not None and callable(orig_browser_call):
            browser_obj.call = orig_browser_call


def read_network_ms_and_diag(
    page: Any,
    captured_requests: list[dict[str, Any]],
    *,
    nav_status: int | None = None,
) -> tuple[float, dict[str, Any]]:
    ready_state: str | None = None
    nav_timing: dict[str, Any] = {}
    status = nav_status
    try:
        info = page._call("page.info", {"document": True, "_noLearn": True})
        if isinstance(info, dict):
            doc = info.get("document") if isinstance(info.get("document"), dict) else {}
            nav_timing = doc.get("navigationTiming") or info.get("navigationTiming") or {}
            ready_state = doc.get("readyState") or info.get("readyState")
            if status is None and isinstance(info.get("status"), int):
                status = info["status"]
    except Exception:
        pass

    net_ms = 0.0
    if isinstance(nav_timing, dict) and isinstance(nav_timing.get("networkMs"), (int, float)) and nav_timing["networkMs"] > 0:
        net_ms = float(nav_timing["networkMs"])
    else:
        main_reqs = [
            float(r["durationMs"])
            for r in captured_requests
            if r.get("resourceType") == "main_frame" and isinstance(r.get("durationMs"), (int, float))
        ]
        if main_reqs:
            net_ms = float(sum(main_reqs))

    if status is None:
        for req in reversed(captured_requests):
            if req.get("resourceType") == "main_frame" and isinstance(req.get("status"), int):
                status = int(req["status"])
                break

    return net_ms, {
        "status": status,
        "readyState": ready_state,
        "navigationTiming": nav_timing if isinstance(nav_timing, dict) else {},
    }


def read_network_ms(page: Any, captured_requests: list[dict[str, Any]]) -> float:
    net_ms, _ = read_network_ms_and_diag(page, captured_requests)
    return net_ms


def measure_pass(page: Any, site: str, url: str, routine_name: str | None, *, unoptimized: bool = False) -> dict[str, Any]:
    try:
        page._call(
            "page.navigate",
            {"url": "about:blank", "waitUntil": "commit", "timeoutMs": 5_000, "_siteProfile": {}, "_noLearn": True},
        )
    except Exception:
        pass

    page._call("page.network", {"action": "start", "maxEntries": 200, "clear": True, "_noLearn": True})
    t0 = time.perf_counter()
    nav_status: int | None = None
    snap_text = ""
    error_msg: str | None = None

    try:
        if unoptimized:
            nav_res = page._call(
                "page.navigate",
                {"url": url, "waitUntil": "load", "timeoutMs": 25_000, "_siteProfile": {}, "_noLearn": True},
                timeout=30_000,
            )
            if isinstance(nav_res, dict):
                if isinstance(nav_res.get("status"), int):
                    nav_status = nav_res["status"]
                if nav_res.get("loaded") is not True:
                    error_msg = "load timeout after 25000 ms (DOM ready, onload stalled)"
            snap = page._call(
                "page.snapshot",
                {"maxChars": 20_000, "frames": "all", "_siteProfile": {}, "_noLearn": True},
                timeout=30_000,
            )
        else:
            nav_res = page._call(
                "page.navigate",
                {"url": url, "timeoutMs": 20_000, "_noLearn": True},
                timeout=25_000,
            )
            if isinstance(nav_res, dict):
                if isinstance(nav_res.get("status"), int):
                    nav_status = nav_res["status"]
                if nav_res.get("loaded") is not True:
                    raise BridgeTimeoutError("timeout", "Navigation started but did not reach the requested load state.")
            snap = page._call("page.snapshot", {"maxChars": 20_000, "_noLearn": True}, timeout=25_000)

        snap_text = (snap.get("text") or "") if isinstance(snap, dict) else str(snap or "")
        wall_ms = (time.perf_counter() - t0) * 1000.0
    except Exception as exc:
        wall_ms = (time.perf_counter() - t0) * 1000.0
        reqs = (page._call("page.network", {"action": "stop", "onlyFailures": False, "limit": 200, "_noLearn": True}) or {}).get("exchanges") or []
        net_ms, diag = read_network_ms_and_diag(page, reqs, nav_status=nav_status)
        return {
            "wall_ms": wall_ms,
            "net_ms": net_ms,
            "engine_ms": max(1.0, wall_ms - net_ms),
            "warm_snap_ms": None,
            "routine_ms": None,
            "chars": len(snap_text),
            "diagnostic_preview": {
                "status": diag["status"],
                "readyState": diag["readyState"],
                "textPreview": snap_text[:300],
            },
            "error": str(exc),
        }

    reqs = (page._call("page.network", {"action": "stop", "onlyFailures": False, "limit": 200, "_noLearn": True}) or {}).get("exchanges") or []
    net_ms, diag = read_network_ms_and_diag(page, reqs, nav_status=nav_status)
    engine_ms = max(1.0, wall_ms - net_ms)
    chars = len(snap_text)

    diagnostic_preview: dict[str, Any] | None = None
    if chars < 400:
        diagnostic_preview = {
            "status": diag["status"],
            "readyState": diag["readyState"],
            "navigationTiming": diag["navigationTiming"],
            "textPreview": snap_text[:300],
        }

    tw0 = time.perf_counter()
    if unoptimized:
        page._call(
            "page.snapshot",
            {"maxChars": 20_000, "frames": "all", "_siteProfile": {}, "_noLearn": True},
        )
    else:
        page._call("page.snapshot", {"maxChars": 20_000, "_noLearn": True})
    warm_snap_ms = (time.perf_counter() - tw0) * 1000.0

    routine_ms = None
    if routine_name and not unoptimized:
        try:
            tr0 = time.perf_counter()
            _run_routine_no_learn(page, routine_name, domain=site)
            routine_ms = (time.perf_counter() - tr0) * 1000.0
        except Exception as r_exc:
            if error_msg is None:
                error_msg = f"routine {routine_name}: {r_exc}"

    return {
        "wall_ms": wall_ms,
        "net_ms": net_ms,
        "engine_ms": engine_ms,
        "warm_snap_ms": warm_snap_ms,
        "routine_ms": routine_ms,
        "chars": chars,
        "diagnostic_preview": diagnostic_preview,
        "error": error_msg,
    }


def _fmt_ms(stat: dict[str, Any], *, trials: int, decimals: int = 0, empty: str = "-") -> str:
    p50 = stat.get("p50")
    p95 = stat.get("p95")
    if p50 is None:
        return empty
    fmt = f"{{:.{decimals}f}}"
    if trials <= 1 or p95 is None:
        return f"{fmt.format(p50)} ms"
    return f"{fmt.format(p50)}/{fmt.format(p95)} ms"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", default=None, help="Browser/profile selector (e.g. edge, chrome, firefox)")
    parser.add_argument("--sites", default="", help="Comma-separated subset of site keys to benchmark")
    parser.add_argument("--compare-unoptimized", action="store_true", help="Also run unoptimized load+allFrames baseline")
    parser.add_argument("--trials", type=int, default=1, help="Trials per site (default: 1; >=2 reports p50/p95)")
    parser.add_argument(
        "--interleave",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Randomize/alternate unoptimized vs optimized pass order per trial (default: True with --compare-unoptimized)",
    )
    parser.add_argument("--seed", type=int, default=42, help="Deterministic RNG seed for interleaved trial order (default: 42)")
    parser.add_argument(
        "--min-content-ratio",
        type=float,
        default=0.80,
        help="Minimum optimized/baseline snapshot character ratio before flagging [INCOMPLETE READ] (default: 0.80)",
    )
    parser.add_argument("--json-out", "--out-json", dest="json_out", default="", help="Optional path to write JSON benchmark report")
    args = parser.parse_args(argv)

    if args.trials < 1:
        raise SystemExit("--trials must be >= 1")
    if not (0.0 < args.min_content_ratio <= 1.0):
        raise SystemExit("--min-content-ratio must be in (0.0, 1.0]")

    use_interleave = bool(args.compare_unoptimized) if args.interleave is None else bool(args.interleave)
    wanted = {s.strip().lower() for s in args.sites.split(",") if s.strip()}
    targets = [t for t in DEFAULT_TARGETS if not wanted or t[0] in wanted]

    opt_runs: dict[str, list[dict[str, Any]]] = {t[0]: [] for t in targets}
    unopt_runs: dict[str, list[dict[str, Any]]] = {t[0]: [] for t in targets}

    with BrowserBridge(browser=args.browser) as browser:
        page = browser.new_page("about:blank", active=False, group="Agent-Benchmark")
        try:
            for trial_idx in range(1, args.trials + 1):
                for site, url, rname in targets:
                    if args.compare_unoptimized:
                        for is_unopt in interleaved_pass_order(
                            site,
                            trial_idx,
                            interleave=use_interleave,
                            seed=args.seed,
                        ):
                            res = measure_pass(page, site, url, rname, unoptimized=is_unopt)
                            res["trial"] = trial_idx
                            if is_unopt:
                                unopt_runs[site].append(res)
                            else:
                                opt_runs[site].append(res)
                    else:
                        res = measure_pass(page, site, url, rname, unoptimized=False)
                        res["trial"] = trial_idx
                        opt_runs[site].append(res)
        finally:
            page.close()

    multi = args.trials > 1
    opt_col = "Opt p50/p95" if multi else "Opt(Excl.Net)"
    header = (
        f"{'Site':22s} | {'Wall':>12s} | {'Net':>10s} | {opt_col:>14s} | "
        f"{'WarmSnap(0-Net)':>15s} | {'Routine(0-Net)':>14s}"
    )
    if args.compare_unoptimized:
        unopt_col = "Unopt p50/p95" if multi else "Unopt(Excl.Net)"
        header += f" | {unopt_col:>15s} | {'Speedup':>8s} | {'Content Ratio':>13s}"
    print(header)
    print("-" * len(header))

    json_sites: list[dict[str, Any]] = []
    diag_notes: list[str] = []

    for site, url, rname in targets:
        o_list = opt_runs[site]
        u_list = unopt_runs[site]
        o_wall = summarize_metric([r["wall_ms"] for r in o_list])
        o_net = summarize_metric([r["net_ms"] for r in o_list])
        o_eng = summarize_metric([r["engine_ms"] for r in o_list])
        o_warm = summarize_metric([r["warm_snap_ms"] for r in o_list])
        o_rout = summarize_metric([r["routine_ms"] for r in o_list])
        o_chars = summarize_metric([float(r["chars"]) for r in o_list])

        ws = _fmt_ms(o_warm, trials=args.trials, decimals=1, empty="ERR")
        rt = _fmt_ms(o_rout, trials=args.trials, decimals=0, empty="-")
        row = (
            f"{site:22s} | {_fmt_ms(o_wall, trials=args.trials):>12s} | "
            f"{_fmt_ms(o_net, trials=args.trials):>10s} | "
            f"{_fmt_ms(o_eng, trials=args.trials):>14s} | {ws:>15s} | {rt:>14s}"
        )

        content_ratio: float | None = None
        incomplete_read = False
        gain: float | None = None
        u_eng: dict[str, Any] | None = None
        u_chars: dict[str, Any] | None = None

        if args.compare_unoptimized and u_list:
            u_eng = summarize_metric([r["engine_ms"] for r in u_list])
            u_chars = summarize_metric([float(r["chars"]) for r in u_list])
            if o_eng["p50"] is not None and u_eng["p50"] is not None:
                gain = round(float(u_eng["p50"]) / max(1.0, float(o_eng["p50"])), 2)
            if o_chars["p50"] is not None and u_chars["p50"] is not None and u_chars["p50"] > 0:
                content_ratio = round(float(o_chars["p50"]) / float(u_chars["p50"]), 4)
                incomplete_read = content_ratio < args.min_content_ratio

            gain_s = f"{gain:7.1f}x" if gain is not None else "       -"
            ratio_s = f"{content_ratio * 100.0:12.0f}%" if content_ratio is not None else "            -"
            row += f" | {_fmt_ms(u_eng, trials=args.trials):>15s} | {gain_s} | {ratio_s}"
            if incomplete_read:
                row += " [INCOMPLETE READ]"
        elif o_chars["p50"] is not None and o_chars["p50"] < 400:
            row += f" [LOW CONTENT: {int(o_chars['p50'])} chars]"

        print(row)

        previews = [r["diagnostic_preview"] for r in o_list if r.get("diagnostic_preview")]
        if previews:
            sample = previews[0]
            flat = " ".join(str(sample.get("textPreview") or "").split())[:140]
            diag_notes.append(
                f"  [diag {site}] chars<400 status={sample.get('status')} "
                f"readyState={sample.get('readyState')} preview={flat!r}"
            )

        json_sites.append(
            {
                "site": site,
                "url": url,
                "routine": rname,
                "trials": args.trials,
                "optimized": {
                    "wallMs": o_wall,
                    "netMs": o_net,
                    "enginePostNetMs": o_eng,
                    "warmSnap0NetMs": o_warm,
                    "routine0NetMs": o_rout,
                    "chars": o_chars,
                    "rawTrials": o_list,
                },
                "unoptimized": (
                    {
                        "enginePostNetMs": u_eng,
                        "chars": u_chars,
                        "rawTrials": u_list,
                    }
                    if args.compare_unoptimized
                    else None
                ),
                "speedupP50": gain,
                "contentRatio": content_ratio,
                "qualityPass": not incomplete_read,
                "incompleteRead": incomplete_read,
                "diagnosticPreview": previews[0] if previews else None,
            }
        )

    if diag_notes:
        print("\nLow-character (<400 chars) diagnostic previews:")
        for line in diag_notes:
            print(line)

    if args.json_out:
        out_path = Path(args.json_out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(
                {
                    "generatedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "isolatedNoLearn": True,
                    "trials": args.trials,
                    "compareUnoptimized": bool(args.compare_unoptimized),
                    "interleave": use_interleave,
                    "seed": args.seed,
                    "minContentRatio": args.min_content_ratio,
                    "sites": json_sites,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
