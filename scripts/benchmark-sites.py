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
from pathlib import Path
import sys
import time

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "python") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "python"))

from browser_bridge import BrowserBridge  # noqa: E402

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


def read_network_ms(page, captured_requests: list[dict]) -> float:
    info = page._call("page.info", {"document": True})
    nav_timing = (info.get("document") or {}).get("navigationTiming") or info.get("navigationTiming") or {}
    if isinstance(nav_timing.get("networkMs"), (int, float)) and nav_timing["networkMs"] > 0:
        return float(nav_timing["networkMs"])
    main_reqs = [
        r["durationMs"]
        for r in captured_requests
        if r.get("resourceType") == "main_frame" and isinstance(r.get("durationMs"), (int, float))
    ]
    return float(sum(main_reqs)) if main_reqs else 0.0


def measure_pass(page, site: str, url: str, routine_name: str | None, *, unoptimized: bool = False) -> dict:
    page.start_network_capture()
    t0 = time.perf_counter()
    try:
        if unoptimized:
            page.goto(url, wait_until="load", timeout=25_000)
            page._call("page.snapshot", {"maxChars": 20_000, "frames": "all"})
        else:
            page.goto(url, timeout=20_000)
            page.snapshot(max_chars=20_000)
        wall_ms = (time.perf_counter() - t0) * 1000.0
    except Exception as exc:
        wall_ms = (time.perf_counter() - t0) * 1000.0
        reqs = page.stop_network_capture()
        net_ms = read_network_ms(page, reqs)
        return {
            "wall_ms": wall_ms,
            "net_ms": net_ms,
            "engine_ms": max(1.0, wall_ms - net_ms),
            "warm_snap_ms": None,
            "routine_ms": None,
            "error": str(exc),
        }

    reqs = page.stop_network_capture()
    net_ms = read_network_ms(page, reqs)
    engine_ms = max(1.0, wall_ms - net_ms)

    tw0 = time.perf_counter()
    if unoptimized:
        page._call("page.snapshot", {"maxChars": 20_000, "frames": "all"})
    else:
        page.snapshot(max_chars=20_000)
    warm_snap_ms = (time.perf_counter() - tw0) * 1000.0

    routine_ms = None
    if routine_name and not unoptimized:
        tr0 = time.perf_counter()
        page.run_routine(routine_name, domain=site)
        routine_ms = (time.perf_counter() - tr0) * 1000.0

    return {
        "wall_ms": wall_ms,
        "net_ms": net_ms,
        "engine_ms": engine_ms,
        "warm_snap_ms": warm_snap_ms,
        "routine_ms": routine_ms,
        "error": None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", default=None, help="Browser/profile selector (e.g. edge, chrome, firefox)")
    parser.add_argument("--sites", default="", help="Comma-separated subset of site keys to benchmark")
    parser.add_argument("--compare-unoptimized", action="store_true", help="Also run unoptimized load+allFrames baseline")
    args = parser.parse_args()

    wanted = {s.strip().lower() for s in args.sites.split(",") if s.strip()}
    targets = [t for t in DEFAULT_TARGETS if not wanted or t[0] in wanted]

    with BrowserBridge(browser=args.browser) as browser:
        page = browser.new_page("about:blank", active=False, group="Agent-Benchmark")
        try:
            header = (
                f"{'Site':22s} | {'Wall':>8s} | {'Net':>7s} | {'Opt(Excl.Net)':>13s} | "
                f"{'WarmSnap(0-Net)':>15s} | {'Routine(0-Net)':>14s}"
            )
            if args.compare_unoptimized:
                header += f" | {'Unopt(Excl.Net)':>15s} | {'Speedup':>8s}"
            print(header)
            print("-" * len(header))

            for site, url, rname in targets:
                unopt = measure_pass(page, site, url, rname, unoptimized=True) if args.compare_unoptimized else None
                opt = measure_pass(page, site, url, rname, unoptimized=False)
                ws = f"{opt['warm_snap_ms']:.1f} ms" if opt["warm_snap_ms"] is not None else "ERR"
                rt = f"{opt['routine_ms']:.0f} ms" if opt["routine_ms"] is not None else "-"
                row = (
                    f"{site:22s} | {opt['wall_ms']:6.0f} ms | {opt['net_ms']:5.0f} ms | "
                    f"{opt['engine_ms']:10.0f} ms | {ws:>15s} | {rt:>14s}"
                )
                if unopt is not None:
                    gain = unopt["engine_ms"] / max(1.0, opt["engine_ms"])
                    row += f" | {unopt['engine_ms']:12.0f} ms | {gain:7.1f}x"
                print(row)
        finally:
            page.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
