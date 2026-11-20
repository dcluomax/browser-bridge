#!/usr/bin/env python3
"""SemVer PATCH release gate for Browser Bridge `routines/*.json` playbooks.

Zero-dependency Python 3.10+ CLI validating both static playbook schema/hygiene
and empirical multi-trial benchmark gates before any `0.10.Z` / `0.11.Z` release:

  1. Static Playbook Schema & Sanitization Audit (`--routines-dir routines`):
     - `schemaVersion == 2`
     - Valid ISO-8601 UTC `verifiedAt` and `updatedAt` timestamps
     - `preferredWaitUntil` in `{"commit", "domcontentloaded", "load", None}`
     - `0 <= hydrationSettleMs <= 600` (when set)
     - Non-empty `steps` list in every defined routine
     - Zero unsanitized personal handles, paths, corporate emails, or secret tokens

  2. Empirical Benchmark Regression & Completeness Gate (`--benchmark-json <path>`):
     - `trials >= --min-trials` (default 20)
     - `S3` success rate `>= --min-success-rate` (default 0.95)
     - `S3` content ratio vs `S1` `>= --min-content-ratio` (default 0.80)
     - `S3` post-network `p50` does not regress vs `S2` by `> --max-p50-regression-pct`
       (default 10.0%) and `p95` does not regress vs `S2` by `> --max-p95-regression-pct`
       (default 15.0%), UNLESS `S2` itself failed the content floor (`< min_content_ratio`)
       while `S3` restored complete content (`>= min_content_ratio`) — the smart
       quality-aware exemption (e.g. `youtube.com`: S2 9% shell -> S3 94% content).
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
import json
import math
from pathlib import Path
import re
import sys
from typing import Any, Sequence

REPO_ROOT = Path(__file__).resolve().parents[1]

VALID_WAIT_UNTIL: frozenset[str | None] = frozenset({"commit", "domcontentloaded", "load", None})
VALID_SNAPSHOT_FRAMES: frozenset[str | None] = frozenset({"top", "all", None})
MAX_HYDRATION_SETTLE_MS = 600.0


def _build_sanitization_rules() -> list[tuple[str, re.Pattern[str]]]:
    """Builds hygiene regexes dynamically so this file contains zero literal forbidden strings."""
    return [
        (
            "personal-handle",
            re.compile("|".join(["ma" + "luo", "max" + "luo", "dc" + "luo(?!max)"]), re.IGNORECASE),
        ),
        (
            "corporate-email",
            re.compile(r"[A-Za-z0-9._%+-]+@" + r"microsoft\.com", re.IGNORECASE),
        ),
        (
            "corporate-npm-feed",
            re.compile(
                "|".join([
                    r"pkgs\." + r"visualstudio\.com",
                    r"packagefeedproxy\." + r"microsoft\.io",
                    r"pkgs\.dev\." + r"azure\.com",
                ]),
                re.IGNORECASE,
            ),
        ),
        (
            "personal-onedrive-or-converter",
            re.compile(
                "|".join([
                    "One" + r"Drive[\\/]+" + r"Tools",
                    "muse" + "score_" + "to_pdf",
                    "Website" + "Tools",
                    "website-" + "tools",
                    "website_" + "tools",
                ]),
                re.IGNORECASE,
            ),
        ),
        (
            "personal-home-path",
            re.compile(r"(?:[A-Za-z]:\\Users\\|/Users/|/home/)(?!<|user\b|runner\b|ubuntu\b)[A-Za-z0-9._-]+", re.IGNORECASE),
        ),
        (
            "legacy-extension-id",
            re.compile("dmgaljkjepliflkkg" + "pinpkemobomldlf", re.IGNORECASE),
        ),
        (
            "live-instance-leak",
            re.compile("c4226b" + "8c9535|" + "5681b8" + "ee1af5", re.IGNORECASE),
        ),
        (
            "secret-material",
            re.compile(
                "-----BEGIN " + r"(?:RSA |EC |OPENSSH )?PRIVATE KEY-----|"
                + r"\b(?:ghp|gho|ghu|ghs|github_pat)" + r"_[A-Za-z0-9_]{20,}\b"
            ),
        ),
        (
            "ai-coauthor-trailer",
            re.compile(r"Co-authored-by:\s*" + "Copilot", re.IGNORECASE),
        ),
    ]


SANITIZATION_RULES: list[tuple[str, re.Pattern[str]]] = _build_sanitization_rules()


@dataclass
class PlaybookAuditResult:
    file: str
    domain: str
    passed: bool
    routine_count: int = 0
    preferred_wait_until: str | None = None
    hydration_settle_ms: float | None = None
    verified_at: str | None = None
    updated_at: str | None = None
    errors: list[str] = field(default_factory=list)


@dataclass
class StaticGateReport:
    routines_dir: str
    passed: bool
    total_files: int
    passed_files: int
    failed_files: int
    results: list[PlaybookAuditResult] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


@dataclass
class SiteBenchmarkVerdict:
    site: str
    passed: bool
    status: str
    trials: int
    success_rate: float
    s1_median_chars: int | None
    s2_content_ratio: float | None
    s3_content_ratio: float | None
    s2_p50_ms: float | None
    s3_p50_ms: float | None
    p50_regression_pct: float | None
    s2_p95_ms: float | None
    s3_p95_ms: float | None
    p95_regression_pct: float | None
    quality_exempt: bool = False
    exemption_note: str | None = None
    reasons: list[str] = field(default_factory=list)


@dataclass
class EmpiricalGateReport:
    benchmark_json: str
    passed: bool
    total_sites: int
    passed_sites: int
    failed_sites: int
    exempted_sites: list[str]
    raw_p50_regression_sites: list[str]
    unexempted_p50_regression_sites: list[str]
    p95_regression_sites: list[str]
    content_failure_sites: list[str]
    verdicts: list[SiteBenchmarkVerdict] = field(default_factory=list)
    metadata_errors: list[str] = field(default_factory=list)


def is_valid_utc_iso8601(value: Any) -> bool:
    """Validates an explicit UTC ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:SS[.fff]Z` or `+00:00`)."""
    if not isinstance(value, str) or "T" not in value:
        return False
    if not (value.endswith("Z") or value.endswith("+00:00")):
        return False
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        return False
    return dt.tzinfo is not None and dt.utcoffset() == timedelta(0)


def scan_unsanitized_identifiers(raw_text: str) -> list[str]:
    """Scans raw text line-by-line for unsanitized personal handles, paths, or credentials."""
    findings: list[str] = []
    for line_no, line in enumerate(raw_text.splitlines(), start=1):
        for rule_id, pattern in SANITIZATION_RULES:
            if pattern.search(line):
                findings.append(f"line {line_no}: unsanitized identifier [{rule_id}]")
    return findings


def _is_real_number(val: Any) -> bool:
    return isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(float(val))


def audit_playbook_payload(
    data: Any,
    *,
    raw_text: str | None = None,
    file_name: str = "<memory>",
) -> PlaybookAuditResult:
    """Audits one parsed playbook JSON dictionary for schema v2 and hygiene compliance."""
    errors: list[str] = []
    text_to_scan = raw_text if raw_text is not None else json.dumps(data, ensure_ascii=False)
    errors.extend(scan_unsanitized_identifiers(text_to_scan))

    if not isinstance(data, dict):
        return PlaybookAuditResult(
            file=file_name,
            domain="<invalid>",
            passed=False,
            errors=errors + ["root JSON value must be an object"],
        )

    domain = data.get("domain")
    domain_str = domain if isinstance(domain, str) and domain.strip() else "<missing>"
    if not isinstance(domain, str) or not domain.strip():
        errors.append("missing or empty string 'domain'")

    schema_ver = data.get("schemaVersion")
    if type(schema_ver) is not int or schema_ver != 2:
        errors.append(f"schemaVersion must be 2, got {schema_ver!r}")

    verified_at = data.get("verifiedAt")
    if not is_valid_utc_iso8601(verified_at):
        errors.append(f"invalid ISO-8601 UTC verifiedAt: {verified_at!r}")

    updated_at = data.get("updatedAt")
    if not is_valid_utc_iso8601(updated_at):
        errors.append(f"invalid ISO-8601 UTC updatedAt: {updated_at!r}")

    ap = data.get("accessProfile")
    if ap is None:
        ap_dict: dict[str, Any] = {}
    elif isinstance(ap, dict):
        ap_dict = ap
    else:
        ap_dict = {}
        errors.append(f"accessProfile must be an object when present, got {type(ap).__name__}")

    pref_wait = ap_dict.get("preferredWaitUntil")
    if pref_wait not in VALID_WAIT_UNTIL:
        errors.append(
            f"preferredWaitUntil must be one of commit, domcontentloaded, load, or null; got {pref_wait!r}"
        )

    settle_raw = ap_dict.get("hydrationSettleMs")
    settle_val: float | None = None
    if settle_raw is not None:
        if not _is_real_number(settle_raw):
            errors.append(f"hydrationSettleMs must be a finite number <= 600, got {settle_raw!r}")
        else:
            settle_val = float(settle_raw)
            if settle_val < 0.0 or settle_val > MAX_HYDRATION_SETTLE_MS:
                errors.append(
                    f"hydrationSettleMs must satisfy 0 <= hydrationSettleMs <= {int(MAX_HYDRATION_SETTLE_MS)}, got {settle_raw!r}"
                )

    pref_frames = ap_dict.get("preferredSnapshotFrames")
    if pref_frames not in VALID_SNAPSHOT_FRAMES:
        errors.append(f"preferredSnapshotFrames must be 'top', 'all', or null; got {pref_frames!r}")

    routines = data.get("routines")
    routine_count = 0
    if not isinstance(routines, dict):
        errors.append(f"routines must be an object mapping routine name to definition, got {type(routines).__name__}")
    else:
        routine_count = len(routines)
        for r_key, r_spec in routines.items():
            if not isinstance(r_spec, dict):
                errors.append(f"routine {r_key!r} must be an object")
                continue
            steps = r_spec.get("steps")
            if not isinstance(steps, list) or len(steps) == 0:
                errors.append(f"routine {r_key!r} must have a non-empty 'steps' array")
            else:
                for step_idx, step in enumerate(steps, start=1):
                    if not isinstance(step, dict) or not isinstance(step.get("op"), str) or not step["op"].strip():
                        errors.append(f"routine {r_key!r} step #{step_idx} is missing a valid string 'op'")
            for r_ts_field in ("verifiedAt", "updatedAt"):
                r_ts = r_spec.get(r_ts_field)
                if r_ts is not None and not is_valid_utc_iso8601(r_ts):
                    errors.append(f"routine {r_key!r} has invalid ISO-8601 UTC {r_ts_field}: {r_ts!r}")

    return PlaybookAuditResult(
        file=file_name,
        domain=domain_str,
        passed=len(errors) == 0,
        routine_count=routine_count,
        preferred_wait_until=pref_wait if isinstance(pref_wait, str) else None,
        hydration_settle_ms=settle_val,
        verified_at=verified_at if isinstance(verified_at, str) else None,
        updated_at=updated_at if isinstance(updated_at, str) else None,
        errors=errors,
    )


def audit_playbook_file(path: Path) -> PlaybookAuditResult:
    try:
        raw_text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return PlaybookAuditResult(
            file=path.name,
            domain="<unreadable>",
            passed=False,
            errors=[f"could not read file: {exc}"],
        )
    san_errors = scan_unsanitized_identifiers(raw_text)
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        return PlaybookAuditResult(
            file=path.name,
            domain="<invalid-json>",
            passed=False,
            errors=san_errors + [f"invalid JSON: {exc}"],
        )
    return audit_playbook_payload(parsed, raw_text=raw_text, file_name=path.name)


def audit_routines_dir(routines_dir: Path) -> StaticGateReport:
    if not routines_dir.is_dir():
        return StaticGateReport(
            routines_dir=str(routines_dir),
            passed=False,
            total_files=0,
            passed_files=0,
            failed_files=0,
            errors=[f"routines directory does not exist: {routines_dir}"],
        )
    files = sorted(p for p in routines_dir.glob("*.json") if p.is_file())
    if not files:
        return StaticGateReport(
            routines_dir=str(routines_dir),
            passed=False,
            total_files=0,
            passed_files=0,
            failed_files=0,
            errors=[f"no *.json routine files found in {routines_dir}"],
        )
    results = [audit_playbook_file(p) for p in files]
    passed_count = sum(1 for r in results if r.passed)
    failed_count = len(results) - passed_count
    return StaticGateReport(
        routines_dir=str(routines_dir),
        passed=failed_count == 0,
        total_files=len(results),
        passed_files=passed_count,
        failed_files=failed_count,
        results=results,
    )


def _extract_content_ratio(
    stage_row: dict[str, Any] | None,
    s1_chars: float | None,
) -> float | None:
    if stage_row is None:
        return None
    explicit = stage_row.get("content_ratio_vs_s1")
    if _is_real_number(explicit):
        return float(explicit)
    med = stage_row.get("medianChars", stage_row.get("median_chars"))
    if _is_real_number(med) and s1_chars is not None and s1_chars > 0:
        return float(med) / float(s1_chars)
    return None


def _extract_post_net_quantile(stage_row: dict[str, Any] | None, quantile_key: str) -> float | None:
    if stage_row is None:
        return None
    pn = stage_row.get("totalPostNetMs")
    if isinstance(pn, dict) and _is_real_number(pn.get(quantile_key)):
        return float(pn[quantile_key])
    return None


def evaluate_benchmark_report(
    report_data: dict[str, Any],
    *,
    source_label: str = "<memory>",
    sites_filter: set[str] | None = None,
    min_trials: int = 20,
    max_p50_regression_pct: float = 10.0,
    max_p95_regression_pct: float = 15.0,
    min_content_ratio: float = 0.80,
    min_success_rate: float = 0.95,
    candidate_stage: str = "S3_adaptive_profile",
) -> EmpiricalGateReport:
    """Evaluates an empirical ablation/benchmark JSON report against PATCH release gates."""
    metadata_errors: list[str] = []
    if not isinstance(report_data, dict):
        return EmpiricalGateReport(
            benchmark_json=source_label,
            passed=False,
            total_sites=0,
            passed_sites=0,
            failed_sites=0,
            exempted_sites=[],
            raw_p50_regression_sites=[],
            unexempted_p50_regression_sites=[],
            p95_regression_sites=[],
            content_failure_sites=[],
            metadata_errors=["benchmark JSON root must be an object"],
        )

    if report_data.get("mode") != "online_convergence":
        drift_count = report_data.get("profile_drift_count")
        if _is_real_number(drift_count) and int(drift_count) != 0:
            metadata_errors.append(
                f"frozen benchmark reported profile_drift_count={int(drift_count)} (expected 0)"
            )

    summary_rows = report_data.get("summary")
    if not isinstance(summary_rows, list) or not summary_rows:
        return EmpiricalGateReport(
            benchmark_json=source_label,
            passed=False,
            total_sites=0,
            passed_sites=0,
            failed_sites=0,
            exempted_sites=[],
            raw_p50_regression_sites=[],
            unexempted_p50_regression_sites=[],
            p95_regression_sites=[],
            content_failure_sites=[],
            metadata_errors=metadata_errors + ["benchmark JSON contains no 'summary' rows"],
        )

    by_site: dict[str, dict[str, dict[str, Any]]] = {}
    site_order: list[str] = []
    for row in summary_rows:
        if not isinstance(row, dict) or not isinstance(row.get("site"), str) or not isinstance(row.get("stage"), str):
            continue
        site = row["site"]
        if sites_filter and site.lower() not in sites_filter:
            continue
        if site not in by_site:
            by_site[site] = {}
            site_order.append(site)
        by_site[site][row["stage"]] = row

    if not site_order:
        return EmpiricalGateReport(
            benchmark_json=source_label,
            passed=False,
            total_sites=0,
            passed_sites=0,
            failed_sites=0,
            exempted_sites=[],
            raw_p50_regression_sites=[],
            unexempted_p50_regression_sites=[],
            p95_regression_sites=[],
            content_failure_sites=[],
            metadata_errors=metadata_errors + ["no gated sites matched filter"],
        )

    verdicts: list[SiteBenchmarkVerdict] = []
    exempted_sites: list[str] = []
    raw_p50_regression_sites: list[str] = []
    unexempted_p50_regression_sites: list[str] = []
    p95_regression_sites: list[str] = []
    content_failure_sites: list[str] = []

    for site in site_order:
        stages = by_site[site]
        s1 = stages.get("S1_unoptimized")
        s2 = stages.get("S2_engine_only")
        s3 = stages.get(candidate_stage) or stages.get("S3_v2_bandit")

        reasons: list[str] = []
        if s3 is None:
            verdicts.append(
                SiteBenchmarkVerdict(
                    site=site,
                    passed=False,
                    status="FAIL",
                    trials=0,
                    success_rate=0.0,
                    s1_median_chars=None,
                    s2_content_ratio=None,
                    s3_content_ratio=None,
                    s2_p50_ms=None,
                    s3_p50_ms=None,
                    p50_regression_pct=None,
                    s2_p95_ms=None,
                    s3_p95_ms=None,
                    p95_regression_pct=None,
                    reasons=[f"missing candidate stage {candidate_stage!r}"],
                )
            )
            continue

        trials = int(s3.get("trials") or 0)
        if trials < min_trials:
            reasons.append(f"S3 trials {trials} < {min_trials}")
        if s2 is not None and int(s2.get("trials") or 0) < min_trials:
            reasons.append(f"S2 trials {int(s2.get('trials') or 0)} < {min_trials}")

        succ_raw = s3.get("successRate", 0.0)
        success_rate = float(succ_raw) if _is_real_number(succ_raw) else 0.0
        if success_rate < min_success_rate:
            reasons.append(f"S3 success {success_rate * 100.0:.1f}% < {min_success_rate * 100.0:.1f}%")

        s1_chars_val: float | None = None
        if s1 is not None and _is_real_number(s1.get("medianChars", s1.get("median_chars"))):
            s1_chars_val = float(s1.get("medianChars", s1.get("median_chars")))
        elif _is_real_number(s3.get("s1_median_chars")):
            s1_chars_val = float(s3["s1_median_chars"])

        s2_ratio = _extract_content_ratio(s2, s1_chars_val)
        s3_ratio = _extract_content_ratio(s3, s1_chars_val)

        if s3_ratio is None:
            reasons.append("missing S1 baseline character count for content ratio")
            content_failure_sites.append(site)
        elif s3_ratio < min_content_ratio:
            reasons.append(f"S3 content {s3_ratio * 100.0:.1f}% < {min_content_ratio * 100.0:.0f}%")
            content_failure_sites.append(site)

        s2_p50 = _extract_post_net_quantile(s2, "p50")
        s3_p50 = _extract_post_net_quantile(s3, "p50")
        s2_p95 = _extract_post_net_quantile(s2, "p95")
        s3_p95 = _extract_post_net_quantile(s3, "p95")

        p50_reg_pct: float | None = None
        p95_reg_pct: float | None = None

        if s2 is None or s2_p50 is None or s3_p50 is None:
            reasons.append("missing S2/S3 p50 post-network latency")
        else:
            p50_reg_pct = round(((s3_p50 - s2_p50) / max(1e-9, s2_p50)) * 100.0, 2)

        if s2 is not None and s2_p95 is not None and s3_p95 is not None:
            p95_reg_pct = round(((s3_p95 - s2_p95) / max(1e-9, s2_p95)) * 100.0, 2)

        # Smart quality-aware exemption: when S2 failed the content floor (< min_content_ratio)
        # because it captured an unhydrated shell, while S3 restored content (>= min_content_ratio),
        # S3's extra wait bought legitimate content completeness rather than blind regression.
        s2_failed_content = s2_ratio is not None and s2_ratio < min_content_ratio
        s3_passed_content = s3_ratio is not None and s3_ratio >= min_content_ratio
        quality_restoration_applicable = s2_failed_content and s3_passed_content

        raw_p50_bad = p50_reg_pct is not None and p50_reg_pct > max_p50_regression_pct
        raw_p95_bad = p95_reg_pct is not None and p95_reg_pct > max_p95_regression_pct

        if raw_p50_bad:
            raw_p50_regression_sites.append(site)

        quality_exempt = False
        exemption_note: str | None = None
        if (raw_p50_bad or raw_p95_bad) and quality_restoration_applicable:
            quality_exempt = True
            exempted_sites.append(site)
            assert s2_ratio is not None and s3_ratio is not None
            exemption_note = (
                f"quality restoration exempt (S2 {s2_ratio * 100.0:.0f}% < "
                f"{min_content_ratio * 100.0:.0f}% floor -> S3 {s3_ratio * 100.0:.0f}%)"
            )
        else:
            if raw_p50_bad and p50_reg_pct is not None:
                unexempted_p50_regression_sites.append(site)
                reasons.append(f"p50 {p50_reg_pct:+.1f}% > +{max_p50_regression_pct:.1f}%")
            if raw_p95_bad and p95_reg_pct is not None:
                p95_regression_sites.append(site)
                reasons.append(f"p95 {p95_reg_pct:+.1f}% > +{max_p95_regression_pct:.1f}%")

        passed = len(reasons) == 0
        status = "PASS (EXEMPT)" if (passed and quality_exempt) else ("PASS" if passed else "FAIL")
        verdicts.append(
            SiteBenchmarkVerdict(
                site=site,
                passed=passed,
                status=status,
                trials=trials,
                success_rate=round(success_rate, 4),
                s1_median_chars=int(round(s1_chars_val)) if s1_chars_val is not None else None,
                s2_content_ratio=round(s2_ratio, 4) if s2_ratio is not None else None,
                s3_content_ratio=round(s3_ratio, 4) if s3_ratio is not None else None,
                s2_p50_ms=round(s2_p50, 2) if s2_p50 is not None else None,
                s3_p50_ms=round(s3_p50, 2) if s3_p50 is not None else None,
                p50_regression_pct=p50_reg_pct,
                s2_p95_ms=round(s2_p95, 2) if s2_p95 is not None else None,
                s3_p95_ms=round(s3_p95, 2) if s3_p95 is not None else None,
                p95_regression_pct=p95_reg_pct,
                quality_exempt=quality_exempt,
                exemption_note=exemption_note,
                reasons=reasons,
            )
        )

    passed_sites = sum(1 for v in verdicts if v.passed)
    failed_sites = len(verdicts) - passed_sites
    overall_passed = failed_sites == 0 and len(metadata_errors) == 0
    return EmpiricalGateReport(
        benchmark_json=source_label,
        passed=overall_passed,
        total_sites=len(verdicts),
        passed_sites=passed_sites,
        failed_sites=failed_sites,
        exempted_sites=exempted_sites,
        raw_p50_regression_sites=raw_p50_regression_sites,
        unexempted_p50_regression_sites=unexempted_p50_regression_sites,
        p95_regression_sites=p95_regression_sites,
        content_failure_sites=content_failure_sites,
        verdicts=verdicts,
        metadata_errors=metadata_errors,
    )


def format_static_gate_table(report: StaticGateReport) -> str:
    lines = [
        f"Static Playbook Schema & Hygiene Gate ({report.routines_dir})",
        f"{'File':36s} | {'Status':6s} | {'WaitUntil':16s} | {'Settle':>7s} | {'Routines':>8s} | Details",
        "-" * 105,
    ]
    for err in report.errors:
        lines.append(f"[ERROR] {err}")
    for res in report.results:
        status = "PASS" if res.passed else "FAIL"
        wait_s = res.preferred_wait_until or "default"
        settle_s = f"{int(res.hydration_settle_ms)} ms" if res.hydration_settle_ms is not None else "-"
        detail = "ok" if res.passed else "; ".join(res.errors)
        lines.append(
            f"{res.file:36s} | {status:6s} | {wait_s:16s} | {settle_s:>7s} | {res.routine_count:8d} | {detail}"
        )
    verdict = "PASS" if report.passed else "FAIL"
    lines.append(
        f"Static Gate Summary: {verdict} ({report.passed_files}/{report.total_files} playbooks passed)"
    )
    return "\n".join(lines)


def format_empirical_gate_table(report: EmpiricalGateReport) -> str:
    lines = [
        f"Empirical Benchmark Regression & Content Gate ({report.benchmark_json})",
        (
            f"{'Site':28s} | {'Verdict':13s} | {'N':>3s} | {'Succ':>5s} | "
            f"{'S2->S3 Chars':>12s} | {'S2->S3 p50 (Delta)':>26s} | {'p95 Delta':>9s} | Notes"
        ),
        "-" * 136,
    ]
    for m_err in report.metadata_errors:
        lines.append(f"[METADATA FAIL] {m_err}")

    for v in report.verdicts:
        succ_s = f"{v.success_rate * 100.0:4.0f}%"
        c2 = f"{v.s2_content_ratio * 100.0:.0f}%" if v.s2_content_ratio is not None else "-"
        c3 = f"{v.s3_content_ratio * 100.0:.0f}%" if v.s3_content_ratio is not None else "-"
        chars_s = f"{c2:>4s}->{c3:<4s}"
        if v.s2_p50_ms is not None and v.s3_p50_ms is not None and v.p50_regression_pct is not None:
            p50_s = f"{v.s2_p50_ms:6.0f}->{v.s3_p50_ms:6.0f}ms ({v.p50_regression_pct:+6.1f}%)"
        else:
            p50_s = "-"
        p95_s = f"{v.p95_regression_pct:+8.1f}%" if v.p95_regression_pct is not None else "        -"
        note = v.exemption_note if v.quality_exempt and v.passed else ("; ".join(v.reasons) if v.reasons else "ok")
        lines.append(
            f"{v.site:28s} | {v.status:13s} | {v.trials:3d} | {succ_s:>5s} | "
            f"{chars_s:>12s} | {p50_s:>26s} | {p95_s:>9s} | {note}"
        )

    verdict = "PASS" if report.passed else "FAIL"
    lines.append(
        f"Empirical Gate Summary: {verdict} ({report.passed_sites}/{report.total_sites} sites passed, "
        f"{len(report.raw_p50_regression_sites)} raw p50 > threshold [{len(report.exempted_sites)} quality-exempt, "
        f"{len(report.unexempted_p50_regression_sites)} unexempted], "
        f"{len(report.content_failure_sites)} content-floor failure(s))"
    )
    return "\n".join(lines)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--routines-dir",
        default="",
        help="Directory of routines/*.json playbooks to audit statically",
    )
    parser.add_argument(
        "--benchmark-json",
        default="",
        help="Path to empirical ablation/benchmark JSON report to gate",
    )
    parser.add_argument(
        "--sites",
        default="",
        help="Optional comma-separated site subset for empirical benchmark gating",
    )
    parser.add_argument(
        "--min-trials",
        type=int,
        default=20,
        help="Minimum trial count required per site/stage (default: 20)",
    )
    parser.add_argument(
        "--max-p50-regression-pct",
        type=float,
        default=10.0,
        help="Maximum allowed S3 vs S2 post-net p50 regression percentage unless quality-exempt (default: 10.0)",
    )
    parser.add_argument(
        "--max-p95-regression-pct",
        type=float,
        default=15.0,
        help="Maximum allowed S3 vs S2 post-net p95 regression percentage unless quality-exempt (default: 15.0)",
    )
    parser.add_argument(
        "--min-content-ratio",
        type=float,
        default=0.80,
        help="Minimum S3 vs S1 median extracted character ratio (default: 0.80)",
    )
    parser.add_argument(
        "--min-success-rate",
        type=float,
        default=0.95,
        help="Minimum S3 trial success rate in [0, 1] (default: 0.95)",
    )
    parser.add_argument(
        "--candidate-stage",
        default="S3_adaptive_profile",
        help="Candidate adaptive stage key in benchmark summary (default: S3_adaptive_profile)",
    )
    parser.add_argument(
        "--json-out",
        default="",
        help="Optional output path to write structured gate evaluation JSON",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    routines_dir_arg = args.routines_dir.strip()
    bench_json_arg = args.benchmark_json.strip()

    if not routines_dir_arg and not bench_json_arg:
        default_dir = REPO_ROOT / "routines"
        if default_dir.is_dir():
            routines_dir_arg = str(default_dir)
        else:
            parser.error("Provide at least one of --routines-dir or --benchmark-json.")

    overall_ok = True
    static_report: StaticGateReport | None = None
    empirical_report: EmpiricalGateReport | None = None

    if routines_dir_arg:
        static_report = audit_routines_dir(Path(routines_dir_arg))
        print(format_static_gate_table(static_report))
        overall_ok = overall_ok and static_report.passed

    if bench_json_arg:
        if static_report is not None:
            print()
        b_path = Path(bench_json_arg)
        if not b_path.is_file():
            print(f"[ERROR] Benchmark JSON file not found: {b_path}", file=sys.stderr)
            return 1
        try:
            report_data = json.loads(b_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[ERROR] Could not parse benchmark JSON {b_path}: {exc}", file=sys.stderr)
            return 1
        sites_filter = {s.strip().lower() for s in args.sites.split(",") if s.strip()} or None
        empirical_report = evaluate_benchmark_report(
            report_data,
            source_label=str(b_path),
            sites_filter=sites_filter,
            min_trials=args.min_trials,
            max_p50_regression_pct=args.max_p50_regression_pct,
            max_p95_regression_pct=args.max_p95_regression_pct,
            min_content_ratio=args.min_content_ratio,
            min_success_rate=args.min_success_rate,
            candidate_stage=args.candidate_stage,
        )
        print(format_empirical_gate_table(empirical_report))
        overall_ok = overall_ok and empirical_report.passed

    if args.json_out:
        out_path = Path(args.json_out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(
                {
                    "passed": overall_ok,
                    "staticGate": asdict(static_report) if static_report is not None else None,
                    "empiricalGate": asdict(empirical_report) if empirical_report is not None else None,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    return 0 if overall_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
