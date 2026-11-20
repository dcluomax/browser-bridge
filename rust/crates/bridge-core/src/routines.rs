use crate::client::{BridgeClient, BridgeError};
use crate::data_directory;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_PITFALLS_PER_SITE: usize = 30;
const MAX_NOTES_PER_SITE: usize = 30;
const MAX_TRACE_ENTRIES: usize = 80;
const STALE_VERIFICATION_SECS: u64 = 90 * 86_400;

pub fn now_epoch_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Formats Unix epoch seconds into an ISO-8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`) with zero external dependencies.
pub fn epoch_to_iso8601(epoch_s: u64) -> String {
    let days = (epoch_s / 86_400) as i64;
    let rem = epoch_s % 86_400;
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;

    // Howard Hinnant's civil_from_days algorithm (proleptic Gregorian calendar)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    if m <= 2 {
        y += 1;
    }
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Parses an ISO-8601 UTC timestamp (`YYYY-MM-DD...`) back into Unix epoch seconds.
pub fn iso8601_to_epoch(ts: &str) -> Option<u64> {
    let s = ts.trim();
    if s.len() < 10 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    if s.as_bytes().get(4) != Some(&b'-') || s.as_bytes().get(7) != Some(&b'-') {
        return None;
    }
    let month: u64 = s.get(5..7)?.parse().ok()?;
    let day: u64 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (hour, minute, second): (u64, u64, u64) = if s.len() >= 19 {
        (
            s.get(11..13).and_then(|v| v.parse().ok()).unwrap_or(0),
            s.get(14..16).and_then(|v| v.parse().ok()).unwrap_or(0),
            s.get(17..19).and_then(|v| v.parse().ok()).unwrap_or(0),
        )
    } else {
        (0, 0, 0)
    };
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + (doe as i64) - 719_468;
    if days < 0 {
        return None;
    }
    Some((days as u64) * 86_400 + hour.min(23) * 3_600 + minute.min(59) * 60 + second.min(59))
}

pub fn now_iso8601() -> String {
    epoch_to_iso8601(now_epoch_s())
}

#[cfg(test)]
thread_local! {
    static TEST_ROUTINES_DIR: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

pub fn routines_directory() -> PathBuf {
    #[cfg(test)]
    if let Some(dir) = TEST_ROUTINES_DIR.with(|cell| cell.borrow().clone()) {
        return dir;
    }
    if let Some(custom) = std::env::var_os("BROWSER_BRIDGE_ROUTINES_DIR") {
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    data_directory().join("routines")
}

fn resolve_site_alias(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "google-docs" | "gdocs" | "docs.google.com/document" | "docs.google.com__document" => {
            Some("docs.google.com/document")
        }
        "google-sheets"
        | "google-excel"
        | "gsheets"
        | "sheets.google.com"
        | "docs.google.com/spreadsheets"
        | "docs.google.com__spreadsheets" => Some("docs.google.com/spreadsheets"),
        "gmail" | "gmail.com" | "www.gmail.com" => Some("mail.google.com"),
        "chatgpt" | "chat.openai.com" | "www.chatgpt.com" => Some("chatgpt.com"),
        "claude" => Some("claude.ai"),
        "perplexity" | "www.perplexity.ai" => Some("perplexity.ai"),
        "notion" | "notion.com" | "www.notion.com" | "www.notion.so" => Some("notion.so"),
        "hf" | "huggingface" => Some("huggingface.co"),
        "npm" | "www.npmjs.com" => Some("npmjs.com"),
        "pypi" => Some("pypi.org"),
        "arxiv" => Some("arxiv.org"),
        "linkedin" | "www.linkedin.com" => Some("linkedin.com"),
        "medium" | "www.medium.com" => Some("medium.com"),
        "google" | "google-search" => Some("google.com"),
        "drawio" | "draw.io" | "www.draw.io" => Some("diagrams.net"),
        "twitter" | "twitter.com" | "www.twitter.com" => Some("x.com"),
        "hn" | "hackernews" => Some("news.ycombinator.com"),
        _ => None,
    }
}

fn extract_path(url_or_domain: &str) -> String {
    let trimmed = url_or_domain.trim();
    let without_scheme = if let Some((_, rest)) = trimmed.split_once("://") {
        rest
    } else {
        trimmed
    };
    let before_qh = without_scheme.split(['?', '#']).next().unwrap_or("");
    if let Some((_, path)) = before_qh.split_once('/') {
        format!("/{}", path.trim_start_matches('/'))
    } else {
        String::new()
    }
}

/// Extracts a clean lowercase hostname (or canonical path-scoped site key for multi-app hosts like `docs.google.com/document`).
pub fn extract_domain(url_or_domain: &str) -> Option<String> {
    if let Some(alias) = resolve_site_alias(url_or_domain) {
        return Some(alias.to_string());
    }
    let trimmed = url_or_domain.trim().replace("__", "/");
    if trimmed.is_empty() {
        return None;
    }
    if let Some(alias) = resolve_site_alias(&trimmed) {
        return Some(alias.to_string());
    }
    let without_scheme = if let Some((_, rest)) = trimmed.split_once("://") {
        rest
    } else {
        trimmed.as_str()
    };
    let authority = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .trim();
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = if host_port.starts_with('[') {
        return None;
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    let clean: String = host
        .trim_matches('.')
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '.')
        .collect();
    if clean.is_empty() || (!clean.contains('.') && clean != "localhost") {
        return None;
    }
    let path = extract_path(&trimmed).to_ascii_lowercase();
    if clean == "docs.google.com" {
        if path == "/document" || path.starts_with("/document/") {
            return Some("docs.google.com/document".to_string());
        }
        if path == "/spreadsheets" || path.starts_with("/spreadsheets/") {
            return Some("docs.google.com/spreadsheets".to_string());
        }
    } else if clean == "sheets.google.com" {
        return Some("docs.google.com/spreadsheets".to_string());
    } else if clean == "chat.openai.com" {
        return Some("chatgpt.com".to_string());
    } else if clean == "notion.com" || clean == "www.notion.com" || clean.ends_with(".notion.site") {
        return Some("notion.so".to_string());
    }
    Some(clean)
}

pub fn is_loopback_domain(domain: &str) -> bool {
    let host = domain.split('/').next().unwrap_or(domain);
    host == "localhost"
        || host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| ip.is_loopback())
}

pub fn should_persist_domain(domain: &str) -> bool {
    #[cfg(test)]
    if TEST_ROUTINES_DIR.with(|cell| cell.borrow().is_some()) {
        return true;
    }
    !is_loopback_domain(domain)
        || std::env::var_os("BROWSER_BRIDGE_ROUTINES_DIR").is_some_and(|v| !v.is_empty())
}

/// Host-or-app canonical key for learned access profiles (strips leading `www.`, preserves `docs.google.com/document` vs `/spreadsheets`).
pub fn canonical_site_key(url_or_domain: &str) -> Option<String> {
    let extracted = extract_domain(url_or_domain)?;
    if extracted.contains('/') {
        return Some(extracted);
    }
    if let Some(bkey) = builtin_domain_key(&extracted) {
        return Some(bkey.to_string());
    }
    if let Some(alias) = resolve_site_alias(&extracted) {
        return Some(alias.to_string());
    }
    if let Some(stripped) = extracted.strip_prefix("www.") {
        if stripped.contains('.') {
            return Some(stripped.to_string());
        }
    }
    Some(extracted)
}

fn is_uuid_like(seg: &str) -> bool {
    if seg.len() == 36 {
        let b = seg.as_bytes();
        if b[8] == b'-' && b[13] == b'-' && b[18] == b'-' && b[23] == b'-' {
            return seg.chars().all(|c| c == '-' || c.is_ascii_hexdigit());
        }
    }
    seg.len() >= 32 && seg.chars().all(|c| c == '-' || c.is_ascii_hexdigit())
}

fn is_dynamic_route_segment(seg: &str) -> bool {
    if seg.is_empty() {
        return false;
    }
    if seg.len() > 24 {
        return true;
    }
    if seg.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    if is_uuid_like(seg) {
        return true;
    }
    if seg.len() >= 8 && seg.chars().all(|c| c.is_ascii_hexdigit()) {
        return true;
    }
    let has_digit = seg.chars().any(|c| c.is_ascii_digit());
    let has_hyphen = seg.contains('-');
    let has_dot = seg.contains('.');
    if has_digit && (has_hyphen || has_dot || seg.len() >= 6) {
        return true;
    }
    if seg.len() > 20 && !seg.chars().all(|c| c.is_ascii_alphabetic()) {
        return true;
    }
    false
}

/// Normalizes a URL path into a bounded route template (up to 3 path segments, parameterizing dynamic IDs/slugs as `:id`).
pub fn normalize_route_template(url: &str) -> String {
    let path = extract_path(url);
    if path.is_empty() || path == "/" {
        return "/".to_string();
    }
    let raw_segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).take(3).collect();
    if raw_segs.is_empty() {
        return "/".to_string();
    }
    let mut out: Vec<String> = Vec::with_capacity(raw_segs.len());
    for (idx, seg) in raw_segs.iter().enumerate() {
        let prev = idx.checked_sub(1).and_then(|p| raw_segs.get(p)).copied();
        let parameterized_by_parent = prev.is_some_and(|p| {
            matches!(
                p.to_ascii_lowercase().as_str(),
                "r" | "dp" | "quote" | "abs" | "project" | "package" | "d"
            )
        });
        if parameterized_by_parent || is_dynamic_route_segment(seg) {
            out.push(":id".to_string());
        } else {
            out.push(seg.to_ascii_lowercase());
        }
    }
    format!("/{}", out.join("/"))
}

/// Returns candidate lookup keys from most specific to registrable base (e.g. `["app.diagrams.net", "diagrams.net"]`).
pub fn domain_candidates(url_or_domain: &str) -> Vec<String> {
    let Some(primary) = extract_domain(url_or_domain) else {
        return Vec::new();
    };
    if primary.contains('/') {
        return vec![primary];
    }
    let mut out = vec![primary.clone()];
    if is_loopback_domain(&primary) {
        return out;
    }
    if let Some(stripped) = primary.strip_prefix("www.") {
        if stripped.contains('.') && !out.contains(&stripped.to_string()) {
            out.push(stripped.to_string());
        }
    }
    if let Some(alias) = resolve_site_alias(&primary) {
        if !out.contains(&alias.to_string()) {
            out.push(alias.to_string());
        }
    }
    let parts: Vec<&str> = primary.split('.').collect();
    if parts.len() >= 3 {
        let tail2 = format!("{}.{}", parts[parts.len() - 2], parts[parts.len() - 1]);
        let is_multi_app_umbrella = matches!(
            tail2.as_str(),
            "google.com" | "github.io" | "googleusercontent.com" | "amazonaws.com" | "azurewebsites.net"
        ) && !primary.starts_with("www.");
        if tail2.len() >= 5 && !is_multi_app_umbrella && !out.contains(&tail2) {
            out.push(tail2);
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PitfallRecord {
    pub code: String,
    pub method: String,
    #[serde(default)]
    pub target: String,
    pub summary: String,
    pub count: u64,
    pub last_seen_epoch_s: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineParamSpec {
    #[serde(rename = "type", default = "default_string_type")]
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<Value>,
}

fn default_string_type() -> String {
    "string".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineStep {
    pub op: String,
    #[serde(default = "empty_object")]
    pub params: Value,
    #[serde(default)]
    pub save_as: Option<String>,
    #[serde(default)]
    pub optional: bool,
}

fn empty_object() -> Value {
    json!({})
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_succeeded_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_failed_at: Option<String>,
    #[serde(default)]
    pub consecutive_failures: u32,
    #[serde(default)]
    pub stale: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale_reason: Option<String>,
    #[serde(default)]
    pub params: BTreeMap<String, RoutineParamSpec>,
    pub steps: Vec<RoutineStep>,
}

const INPUT_FALLBACK_TTL_S: u64 = 86_400;
pub const LEARNED_PROFILE_TTL_S: u64 = 7 * 86_400;
const MIN_POLICY_SWITCH_SAMPLES: u64 = 3;
const CLEAN_NAV_DECAY_STREAK: u32 = 5;
const MAX_ROUTES_PER_SITE: usize = 24;
const MAX_ARM_LATENCY_SAMPLES: usize = 32;
const MAX_ARM_CHAR_SAMPLES: usize = 16;
const MAX_BLOCKERS_PER_SITE: usize = 12;
const MAX_RECOVERIES_PER_SITE: usize = 16;

pub const ARM_COMMIT_0_TOP: &str = "commit_0_top";
pub const ARM_DCL_0_TOP: &str = "dcl_0_top";
pub const ARM_DCL_200_TOP: &str = "dcl_200_top";
pub const ARM_SAFE_LOAD_ALL: &str = "safe_load_all";
pub const ARM_BASE: &str = "base";

pub const STANDARD_BANDIT_ARMS: [&str; 4] = [
    ARM_COMMIT_0_TOP,
    ARM_DCL_0_TOP,
    ARM_DCL_200_TOP,
    ARM_SAFE_LOAD_ALL,
];

fn is_zero_u64(v: &u64) -> bool {
    *v == 0
}

fn is_zero_u32(v: &u32) -> bool {
    *v == 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldProvenance {
    Seed,
    Learned,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum WaitLevel {
    Commit = 0,
    DomContentLoaded = 1,
    Load = 2,
}

impl WaitLevel {
    pub fn from_opt_str(s: Option<&str>) -> Self {
        match s {
            Some("commit") => Self::Commit,
            Some("domcontentloaded") => Self::DomContentLoaded,
            _ => Self::Load,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Commit => "commit",
            Self::DomContentLoaded => "domcontentloaded",
            Self::Load => "load",
        }
    }
}

fn exact_median_u64(samples: &[u64]) -> u64 {
    if samples.is_empty() {
        return 0;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 0 {
        sorted[mid - 1] / 2 + sorted[mid] / 2 + ((sorted[mid - 1] % 2 + sorted[mid] % 2) / 2)
    } else {
        sorted[mid]
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmStats {
    #[serde(default)]
    pub pulls: u32,
    #[serde(default)]
    pub successes: u32,
    #[serde(default)]
    pub failures: u32,
    #[serde(default)]
    pub quality_violations: u32,
    #[serde(default)]
    pub consecutive_failures: u32,
    #[serde(default)]
    pub samples_ms: Vec<u64>,
    #[serde(default)]
    pub median_chars: u64,
    #[serde(default)]
    pub char_samples: Vec<u64>,
}

impl ArmStats {
    pub fn p50_ms(&self) -> u64 {
        exact_median_u64(&self.samples_ms)
    }

    pub fn p95_ms(&self) -> u64 {
        if self.samples_ms.is_empty() {
            return 0;
        }
        let mut sorted = self.samples_ms.to_vec();
        sorted.sort_unstable();
        let idx = ((sorted.len() * 95).div_ceil(100)).saturating_sub(1);
        sorted[idx.min(sorted.len() - 1)]
    }

    pub fn push_latency_ms(&mut self, ms: u64) {
        if self.samples_ms.len() >= MAX_ARM_LATENCY_SAMPLES {
            self.samples_ms.remove(0);
        }
        self.samples_ms.push(ms);
    }

    pub fn push_chars(&mut self, chars: u64) {
        if self.char_samples.len() >= MAX_ARM_CHAR_SAMPLES {
            self.char_samples.remove(0);
        }
        self.char_samples.push(chars);
        self.median_chars = exact_median_u64(&self.char_samples);
    }

    pub fn is_feasible(&self, reference_chars: u64) -> bool {
        if self.consecutive_failures >= 2 {
            return false;
        }
        let p = self.pulls as u64;
        let s = self.successes as u64;
        if (s + 2) * 100 < (p + 2) * 95 {
            return false;
        }
        if self.pulls >= 20 && s * 100 < p * 95 {
            return false;
        }
        if (self.quality_violations as u64) * 5 > p.max(1) {
            return false;
        }
        if reference_chars >= 300 && self.median_chars > 0 && self.median_chars * 100 < reference_chars * 85 {
            return false;
        }
        true
    }
}

fn arm_speed_tier(arm_id: &str, base_tier: u8) -> u8 {
    match arm_id {
        ARM_COMMIT_0_TOP => 0,
        ARM_DCL_0_TOP => 1,
        ARM_DCL_200_TOP => 2,
        ARM_BASE => base_tier,
        ARM_SAFE_LOAD_ALL => 4,
        _ => 3,
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteBandit {
    #[serde(default)]
    pub reference_chars: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reference_samples: Vec<u64>,
    #[serde(default)]
    pub total_pulls: u32,
    #[serde(default)]
    pub arms: BTreeMap<String, ArmStats>,
    #[serde(default)]
    pub safe_fallback_pending: bool,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub last_used_epoch_s: u64,
}

impl RouteBandit {
    pub fn is_quality_violation(&self, content_chars: u64) -> bool {
        self.reference_chars >= 300
            && content_chars > 0
            && content_chars.saturating_mul(100) < self.reference_chars.saturating_mul(85)
    }

    fn update_reference_chars(&mut self, clean_chars: u64) {
        if clean_chars == 0 || self.is_quality_violation(clean_chars) {
            return;
        }
        if self.reference_chars < 300 && clean_chars >= 300 {
            self.reference_samples.retain(|c| *c >= 300);
        }
        if self.reference_samples.len() >= MAX_ARM_CHAR_SAMPLES {
            self.reference_samples.remove(0);
        }
        self.reference_samples.push(clean_chars);
        let med = exact_median_u64(&self.reference_samples);
        // Rolling high-water median resists transient rate-limit / partial-render dips while adapting smoothly.
        self.reference_chars = med.max(self.reference_chars.saturating_mul(95) / 100);
    }

    pub fn observe_content_quality(&mut self, arm_id: &str, content_chars: u64, base_arm_id: &str) -> bool {
        if content_chars == 0 {
            return false;
        }
        if self.arms.get(arm_id).is_none_or(|a| a.pulls == 0) {
            return false;
        }
        let violated = self.is_quality_violation(content_chars);
        let bootstrap_upgrade = !violated && self.reference_chars < 300 && content_chars >= 300;
        let arm = self.arms.entry(arm_id.to_string()).or_default();
        if bootstrap_upgrade && arm.quality_violations == 0 {
            arm.char_samples.retain(|c| *c >= 300);
        }
        arm.push_chars(content_chars);
        if violated {
            arm.quality_violations = arm.quality_violations.saturating_add(1);
            if arm_id != base_arm_id && arm_id != ARM_SAFE_LOAD_ALL {
                self.safe_fallback_pending = true;
            }
            return true;
        }
        self.update_reference_chars(content_chars);
        false
    }

    pub fn record_navigation(
        &mut self,
        arm_id: &str,
        latency_ms: u64,
        ok: bool,
        clean_content_chars: Option<u64>,
        base_arm_id: &str,
    ) {
        self.total_pulls = self.total_pulls.saturating_add(1);
        {
            let arm = self.arms.entry(arm_id.to_string()).or_default();
            arm.pulls = arm.pulls.saturating_add(1);
            if ok {
                arm.successes = arm.successes.saturating_add(1);
                arm.consecutive_failures = 0;
                arm.push_latency_ms(latency_ms);
            } else {
                arm.failures = arm.failures.saturating_add(1);
                arm.consecutive_failures = arm.consecutive_failures.saturating_add(1);
                if arm_id != base_arm_id && arm_id != ARM_SAFE_LOAD_ALL {
                    self.safe_fallback_pending = true;
                }
            }
        }
        if ok {
            if let Some(chars) = clean_content_chars.filter(|c| *c > 0) {
                let _ = self.observe_content_quality(arm_id, chars, base_arm_id);
            }
        }
    }

    fn candidate_arms(base_arm_id: &str) -> Vec<&str> {
        let mut list = vec![
            ARM_COMMIT_0_TOP,
            ARM_DCL_0_TOP,
            ARM_DCL_200_TOP,
        ];
        if !list.contains(&base_arm_id) && base_arm_id != ARM_SAFE_LOAD_ALL {
            list.push(base_arm_id);
        }
        list.push(ARM_SAFE_LOAD_ALL);
        list
    }

    fn safe_or_base_arm(&self, base_arm_id: &str) -> String {
        let base_ok = self
            .arms
            .get(base_arm_id)
            .is_none_or(|a| a.is_feasible(self.reference_chars));
        if base_ok {
            base_arm_id.to_string()
        } else {
            ARM_SAFE_LOAD_ALL.to_string()
        }
    }

    /// Selects the next arm for an idempotent navigation/read call (`total_pulls < 3` stays on seed/base arm;
    /// thereafter `1` in `8` explores feasible faster arms and `7` in `8` exploits `0.7*p50 + 0.3*p95`).
    pub fn select_arm(&mut self, base_arm_id: &str, base_tier: u8) -> String {
        if self.safe_fallback_pending {
            self.safe_fallback_pending = false;
            return self.safe_or_base_arm(base_arm_id);
        }
        if self.total_pulls < 3 || self.reference_chars == 0 {
            return self.safe_or_base_arm(base_arm_id);
        }

        let candidates = Self::candidate_arms(base_arm_id);
        let is_explore_turn = self.total_pulls % 8 == 3;
        if is_explore_turn {
            let mut best_explore: Option<(&str, u32, u8)> = None;
            for &cand in &candidates {
                let tier = arm_speed_tier(cand, base_tier);
                if tier >= base_tier && cand != base_arm_id {
                    continue;
                }
                let stats = self.arms.get(cand);
                let feasible = stats.is_none_or(|s| s.is_feasible(self.reference_chars) && s.quality_violations == 0);
                if !feasible {
                    continue;
                }
                let pulls = stats.map_or(0, |s| s.pulls);
                // Prefer least-pulled feasible faster arm; tie-break toward safer fast tier first (dcl before commit)
                let better = match best_explore {
                    None => true,
                    Some((_, best_pulls, best_tier)) => {
                        pulls < best_pulls || (pulls == best_pulls && tier > best_tier)
                    }
                };
                if better && cand != base_arm_id {
                    best_explore = Some((cand, pulls, tier));
                }
            }
            if let Some((chosen, _, _)) = best_explore {
                return chosen.to_string();
            }
        }

        self.best_tested_feasible_arm(base_arm_id, &candidates)
    }

    pub fn peek_best_arm(&self, base_arm_id: &str) -> String {
        if self.safe_fallback_pending || self.total_pulls < 3 || self.reference_chars == 0 {
            return self.safe_or_base_arm(base_arm_id);
        }
        let candidates = Self::candidate_arms(base_arm_id);
        self.best_tested_feasible_arm(base_arm_id, &candidates)
    }

    fn best_tested_feasible_arm(&self, base_arm_id: &str, candidates: &[&str]) -> String {
        let ln_total = (self.total_pulls.max(2) as f64).ln().max(1.0);
        let mut best: Option<(&str, f64)> = None;
        for &cand in candidates {
            let Some(stats) = self.arms.get(cand) else {
                continue;
            };
            if stats.pulls == 0 || !stats.is_feasible(self.reference_chars) {
                continue;
            }
            let raw_cost = 0.7 * (stats.p50_ms() as f64) + 0.3 * (stats.p95_ms() as f64);
            let ucb_bonus = 20.0 * (ln_total / (stats.pulls as f64)).sqrt();
            let score = (raw_cost - ucb_bonus).max(0.0);
            if best.is_none_or(|(_, best_score)| score < best_score) {
                best = Some((cand, score));
            }
        }
        best.map(|(c, _)| c.to_string())
            .unwrap_or_else(|| self.safe_or_base_arm(base_arm_id))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnedRecoveryRule {
    pub trigger_code: String,
    pub trigger_method: String,
    #[serde(default)]
    pub blocker: String,
    pub recovery_method: String,
    pub recovery_target: String,
    #[serde(default = "empty_object")]
    pub recovery_params: Value,
    pub success_count: u64,
    pub last_verified_epoch_s: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SitePerfStats {
    #[serde(default)]
    pub navigations: u64,
    #[serde(default)]
    pub load_timeouts: u64,
    #[serde(default)]
    pub slow_load_tails: u64,
    #[serde(default)]
    pub avg_nav_ms: u64,
    #[serde(default)]
    pub snapshots: u64,
    #[serde(default)]
    pub avg_snapshot_ms: u64,
    #[serde(default)]
    pub empty_multiframe_snapshots: u64,
    #[serde(default)]
    pub in_page_actions: u64,
    #[serde(default)]
    pub navigating_actions: u64,
    #[serde(default)]
    pub stale_ref_errors: u64,
    #[serde(default)]
    pub not_ready_errors: u64,
    #[serde(default)]
    pub not_actionable_errors: u64,
    #[serde(default)]
    pub cdp_fallbacks: u64,
    #[serde(default)]
    pub hydration_stalls: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteAccessProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_wait_until: Option<String>,
    #[serde(default)]
    pub service_worker_navigation: bool,
    #[serde(default)]
    pub hydration_settle_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readiness_quiet_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readiness_selector: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub wait_until_learned_at: u64,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub sw_nav_learned_at: u64,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub settle_learned_at: u64,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub clean_nav_streak: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_snapshot_frames: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_input: Option<String>,
    #[serde(default)]
    pub preferred_input_learned_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_settle_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submit_settle_ms: Option<u64>,
    #[serde(default)]
    pub direct_http_blocked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct_http_status: Option<u16>,
    #[serde(default)]
    pub requires_same_origin_fetch: bool,
    #[serde(default)]
    pub dynamic_dom: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub field_provenance: BTreeMap<String, FieldProvenance>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub route_controllers: BTreeMap<String, RouteBandit>,
    #[serde(default)]
    pub known_blockers: Vec<String>,
    #[serde(default)]
    pub learned_recoveries: Vec<LearnedRecoveryRule>,
    #[serde(default)]
    pub stats: SitePerfStats,
    #[serde(skip)]
    pub(crate) is_seed: bool,
}

impl SiteAccessProfile {
    pub fn stamp_seed_provenance(&mut self) {
        self.is_seed = true;
        if self.preferred_wait_until.is_some() {
            self.field_provenance
                .entry("preferredWaitUntil".into())
                .or_insert(FieldProvenance::Seed);
        }
        if self.service_worker_navigation {
            self.field_provenance
                .entry("serviceWorkerNavigation".into())
                .or_insert(FieldProvenance::Seed);
        }
        if self.hydration_settle_ms > 0 {
            self.field_provenance
                .entry("hydrationSettleMs".into())
                .or_insert(FieldProvenance::Seed);
        }
        if self.readiness_quiet_ms.is_some() {
            self.field_provenance
                .entry("readinessQuietMs".into())
                .or_insert(FieldProvenance::Seed);
        }
        if self.readiness_selector.is_some() {
            self.field_provenance
                .entry("readinessSelector".into())
                .or_insert(FieldProvenance::Seed);
        }
        if self.preferred_snapshot_frames.is_some() {
            self.field_provenance
                .entry("preferredSnapshotFrames".into())
                .or_insert(FieldProvenance::Seed);
        }
        if self.preferred_input.is_some() {
            self.field_provenance
                .entry("preferredInput".into())
                .or_insert(FieldProvenance::Seed);
        }
        if self.action_settle_ms.is_some() {
            self.field_provenance
                .entry("actionSettleMs".into())
                .or_insert(FieldProvenance::Seed);
        }
        if self.submit_settle_ms.is_some() {
            self.field_provenance
                .entry("submitSettleMs".into())
                .or_insert(FieldProvenance::Seed);
        }
        if self.direct_http_blocked {
            self.field_provenance
                .entry("directHttpBlocked".into())
                .or_insert(FieldProvenance::Seed);
        }
        if self.requires_same_origin_fetch {
            self.field_provenance
                .entry("requiresSameOriginFetch".into())
                .or_insert(FieldProvenance::Seed);
        }
        if self.dynamic_dom {
            self.field_provenance
                .entry("dynamicDom".into())
                .or_insert(FieldProvenance::Seed);
        }
    }

    pub fn is_seed_profile(&self) -> bool {
        let has_runtime_state = !self.route_controllers.is_empty()
            || !self.known_blockers.is_empty()
            || !self.learned_recoveries.is_empty()
            || self.stats.navigations > 0
            || self.stats.snapshots > 0
            || self.stats.in_page_actions > 0;
        if has_runtime_state {
            return false;
        }
        self.is_seed
            || (!self.field_provenance.is_empty()
                && self
                    .field_provenance
                    .values()
                    .all(|p| *p == FieldProvenance::Seed))
    }

    pub fn is_user_locked(&self, field: &str) -> bool {
        self.field_provenance.get(field) == Some(&FieldProvenance::User)
    }

    pub fn has_user_bandit_lock(&self) -> bool {
        self.is_user_locked("preferredWaitUntil")
            || self.is_user_locked("hydrationSettleMs")
            || self.is_user_locked("preferredSnapshotFrames")
    }

    pub fn is_learned_expired(&self, field: &str, learned_at: u64, now_s: u64) -> bool {
        self.field_provenance.get(field) == Some(&FieldProvenance::Learned)
            && learned_at > 0
            && now_s.saturating_sub(learned_at) >= LEARNED_PROFILE_TTL_S
    }

    pub fn effective_preferred_wait_until(&self, now_s: u64) -> Option<&str> {
        if self.is_learned_expired("preferredWaitUntil", self.wait_until_learned_at, now_s) {
            return None;
        }
        self.preferred_wait_until.as_deref()
    }

    pub fn effective_service_worker_navigation(&self, now_s: u64) -> bool {
        if self.is_learned_expired("serviceWorkerNavigation", self.sw_nav_learned_at, now_s) {
            return false;
        }
        self.service_worker_navigation
    }

    pub fn effective_hydration_settle_ms(&self, now_s: u64) -> u64 {
        if self.is_learned_expired("hydrationSettleMs", self.settle_learned_at, now_s) {
            return 0;
        }
        self.hydration_settle_ms
    }

    pub fn effective_preferred_input(&self, now_s: u64) -> Option<&str> {
        let mode = self.preferred_input.as_deref()?;
        if !self.is_user_locked("preferredInput")
            && mode == "dom"
            && now_s.saturating_sub(self.preferred_input_learned_at) >= INPUT_FALLBACK_TTL_S
        {
            return None;
        }
        Some(mode)
    }

    pub fn base_arm_id(&self, now_s: u64) -> String {
        let w = self.effective_preferred_wait_until(now_s);
        let s = self.effective_hydration_settle_ms(now_s);
        let f = self.preferred_snapshot_frames.as_deref();
        match (w, s, f) {
            (Some("commit"), 0, Some("top")) => ARM_COMMIT_0_TOP.to_string(),
            (Some("domcontentloaded"), 0, Some("top")) => ARM_DCL_0_TOP.to_string(),
            (Some("domcontentloaded"), 200, Some("top")) => ARM_DCL_200_TOP.to_string(),
            (Some("load"), 300, Some("all")) => ARM_SAFE_LOAD_ALL.to_string(),
            _ => ARM_BASE.to_string(),
        }
    }

    pub fn base_speed_tier(&self, now_s: u64) -> u8 {
        let w = WaitLevel::from_opt_str(self.effective_preferred_wait_until(now_s));
        let s = self.effective_hydration_settle_ms(now_s);
        match w {
            WaitLevel::Commit if s == 0 => 0,
            WaitLevel::Commit => 1,
            WaitLevel::DomContentLoaded if s == 0 => 1,
            WaitLevel::DomContentLoaded if s <= 200 => 2,
            WaitLevel::DomContentLoaded => 3,
            WaitLevel::Load => 4,
        }
    }

    pub fn ensure_route_bandit_mut(&mut self, route_key: &str, now_s: u64) -> &mut RouteBandit {
        if !self.route_controllers.contains_key(route_key)
            && self.route_controllers.len() >= MAX_ROUTES_PER_SITE
        {
            if let Some(evict_key) = self
                .route_controllers
                .iter()
                .min_by_key(|(_, b)| b.last_used_epoch_s)
                .map(|(k, _)| k.clone())
            {
                self.route_controllers.remove(&evict_key);
            }
        }
        let bandit = self.route_controllers.entry(route_key.to_string()).or_default();
        bandit.last_used_epoch_s = now_s;
        bandit
    }

    fn build_wire_map(&self, now_s: u64) -> Map<String, Value> {
        let mut map = Map::new();
        if let Some(w) = self.effective_preferred_wait_until(now_s) {
            map.insert("preferredWaitUntil".into(), json!(w));
        }
        if self.effective_service_worker_navigation(now_s) {
            map.insert("serviceWorkerNavigation".into(), json!(true));
        }
        let settle = self.effective_hydration_settle_ms(now_s);
        if settle > 0 {
            map.insert("hydrationSettleMs".into(), json!(settle));
        }
        if let Some(q) = self.readiness_quiet_ms {
            map.insert("readinessQuietMs".into(), json!(q));
        }
        if let Some(sel) = self.readiness_selector.as_deref().filter(|s| !s.trim().is_empty()) {
            map.insert("readinessSelector".into(), json!(sel));
        }
        if let Some(f) = &self.preferred_snapshot_frames {
            map.insert("preferredSnapshotFrames".into(), json!(f));
        }
        if let Some(inp) = self.effective_preferred_input(now_s) {
            map.insert("preferredInput".into(), json!(inp));
        }
        if let Some(ms) = self.action_settle_ms {
            map.insert("actionSettleMs".into(), json!(ms));
        }
        if let Some(ms) = self.submit_settle_ms {
            map.insert("submitSettleMs".into(), json!(ms));
        }
        map
    }

    pub fn runtime_wire_json_at(&self, now_s: u64) -> Option<Value> {
        let map = self.build_wire_map(now_s);
        if map.is_empty() {
            None
        } else {
            Some(Value::Object(map))
        }
    }

    pub fn runtime_wire_json_with_arm(&self, now_s: u64, arm_id: Option<&str>) -> Option<Value> {
        let mut map = self.build_wire_map(now_s);
        match arm_id {
            Some(ARM_COMMIT_0_TOP) => {
                map.insert("preferredWaitUntil".into(), json!("commit"));
                map.insert("hydrationSettleMs".into(), json!(0));
                map.insert("preferredSnapshotFrames".into(), json!("top"));
            }
            Some(ARM_DCL_0_TOP) => {
                map.insert("preferredWaitUntil".into(), json!("domcontentloaded"));
                map.insert("hydrationSettleMs".into(), json!(0));
                map.insert("preferredSnapshotFrames".into(), json!("top"));
            }
            Some(ARM_DCL_200_TOP) => {
                map.insert("preferredWaitUntil".into(), json!("domcontentloaded"));
                map.insert("hydrationSettleMs".into(), json!(200));
                map.insert("preferredSnapshotFrames".into(), json!("top"));
            }
            Some(ARM_SAFE_LOAD_ALL) => {
                map.insert("preferredWaitUntil".into(), json!("load"));
                map.insert("hydrationSettleMs".into(), json!(300));
                map.insert("preferredSnapshotFrames".into(), json!("all"));
                map.remove("readinessSelector");
            }
            _ => {}
        }
        if map.is_empty() {
            None
        } else {
            Some(Value::Object(map))
        }
    }

    pub fn runtime_wire_json(&self) -> Option<Value> {
        self.runtime_wire_json_at(now_epoch_s())
    }

    pub fn reset_learned_preserving_user(&self, seed: Option<&SiteAccessProfile>) -> SiteAccessProfile {
        let mut base = seed.cloned().unwrap_or_default();
        base.is_seed = false;
        if self.is_user_locked("preferredWaitUntil") {
            base.preferred_wait_until = self.preferred_wait_until.clone();
            base.field_provenance
                .insert("preferredWaitUntil".into(), FieldProvenance::User);
        }
        if self.is_user_locked("serviceWorkerNavigation") {
            base.service_worker_navigation = self.service_worker_navigation;
            base.field_provenance
                .insert("serviceWorkerNavigation".into(), FieldProvenance::User);
        }
        if self.is_user_locked("hydrationSettleMs") {
            base.hydration_settle_ms = self.hydration_settle_ms;
            base.field_provenance
                .insert("hydrationSettleMs".into(), FieldProvenance::User);
        }
        if self.is_user_locked("readinessQuietMs") {
            base.readiness_quiet_ms = self.readiness_quiet_ms;
            base.field_provenance
                .insert("readinessQuietMs".into(), FieldProvenance::User);
        }
        if self.is_user_locked("readinessSelector") {
            base.readiness_selector = self.readiness_selector.clone();
            base.field_provenance
                .insert("readinessSelector".into(), FieldProvenance::User);
        }
        if self.is_user_locked("preferredSnapshotFrames") {
            base.preferred_snapshot_frames = self.preferred_snapshot_frames.clone();
            base.field_provenance
                .insert("preferredSnapshotFrames".into(), FieldProvenance::User);
        }
        if self.is_user_locked("preferredInput") {
            base.preferred_input = self.preferred_input.clone();
            base.field_provenance
                .insert("preferredInput".into(), FieldProvenance::User);
        }
        if self.is_user_locked("actionSettleMs") {
            base.action_settle_ms = self.action_settle_ms;
            base.field_provenance
                .insert("actionSettleMs".into(), FieldProvenance::User);
        }
        if self.is_user_locked("submitSettleMs") {
            base.submit_settle_ms = self.submit_settle_ms;
            base.field_provenance
                .insert("submitSettleMs".into(), FieldProvenance::User);
        }
        if self.is_user_locked("directHttpBlocked") {
            base.direct_http_blocked = self.direct_http_blocked;
            base.direct_http_status = self.direct_http_status;
            base.field_provenance
                .insert("directHttpBlocked".into(), FieldProvenance::User);
        }
        if self.is_user_locked("requiresSameOriginFetch") {
            base.requires_same_origin_fetch = self.requires_same_origin_fetch;
            base.field_provenance
                .insert("requiresSameOriginFetch".into(), FieldProvenance::User);
        }
        if self.is_user_locked("dynamicDom") {
            base.dynamic_dom = self.dynamic_dom;
            base.field_provenance
                .insert("dynamicDom".into(), FieldProvenance::User);
        }
        base
    }

    fn apply_provenance_from(&mut self, field: &str, newer: &SiteAccessProfile, fallback: Option<FieldProvenance>) {
        if let Some(&p) = newer.field_provenance.get(field) {
            self.field_provenance.insert(field.to_string(), p);
        } else if let Some(fb) = fallback {
            self.field_provenance.insert(field.to_string(), fb);
        } else {
            self.field_provenance.remove(field);
        }
    }

    pub fn merge_overlay(&mut self, newer: &SiteAccessProfile) {
        let seed_refresh = newer.is_seed_profile();
        let can_update = |this: &SiteAccessProfile, field: &str| -> bool {
            !this.is_user_locked(field)
                || newer.field_provenance.get(field) == Some(&FieldProvenance::User)
        };

        if seed_refresh {
            // Seed upgrade (`seed.verifiedAt >= disk.updatedAt`): refresh every Seed/Learned field back to
            // the authoritative seed baseline while preserving any User-locked field.
            if can_update(self, "preferredWaitUntil") {
                self.preferred_wait_until = newer.preferred_wait_until.clone();
                self.wait_until_learned_at = 0;
                self.apply_provenance_from(
                    "preferredWaitUntil",
                    newer,
                    newer.preferred_wait_until.as_ref().map(|_| FieldProvenance::Seed),
                );
            }
            if can_update(self, "serviceWorkerNavigation") {
                self.service_worker_navigation = newer.service_worker_navigation;
                self.sw_nav_learned_at = 0;
                self.apply_provenance_from(
                    "serviceWorkerNavigation",
                    newer,
                    newer.service_worker_navigation.then_some(FieldProvenance::Seed),
                );
            }
            if can_update(self, "hydrationSettleMs") {
                self.hydration_settle_ms = newer.hydration_settle_ms;
                self.settle_learned_at = 0;
                self.clean_nav_streak = 0;
                self.apply_provenance_from(
                    "hydrationSettleMs",
                    newer,
                    (newer.hydration_settle_ms > 0).then_some(FieldProvenance::Seed),
                );
            }
            if can_update(self, "readinessQuietMs") {
                self.readiness_quiet_ms = newer.readiness_quiet_ms;
                self.apply_provenance_from(
                    "readinessQuietMs",
                    newer,
                    newer.readiness_quiet_ms.map(|_| FieldProvenance::Seed),
                );
            }
            if can_update(self, "readinessSelector") {
                self.readiness_selector = newer.readiness_selector.clone();
                self.apply_provenance_from(
                    "readinessSelector",
                    newer,
                    newer.readiness_selector.as_ref().map(|_| FieldProvenance::Seed),
                );
            }
            if can_update(self, "preferredSnapshotFrames") {
                self.preferred_snapshot_frames = newer.preferred_snapshot_frames.clone();
                self.apply_provenance_from(
                    "preferredSnapshotFrames",
                    newer,
                    newer.preferred_snapshot_frames.as_ref().map(|_| FieldProvenance::Seed),
                );
            }
            if can_update(self, "preferredInput") {
                self.preferred_input = newer.preferred_input.clone();
                self.preferred_input_learned_at = newer.preferred_input_learned_at;
                self.apply_provenance_from(
                    "preferredInput",
                    newer,
                    newer.preferred_input.as_ref().map(|_| FieldProvenance::Seed),
                );
            }
            if can_update(self, "actionSettleMs") {
                self.action_settle_ms = newer.action_settle_ms;
                self.apply_provenance_from(
                    "actionSettleMs",
                    newer,
                    newer.action_settle_ms.map(|_| FieldProvenance::Seed),
                );
            }
            if can_update(self, "submitSettleMs") {
                self.submit_settle_ms = newer.submit_settle_ms;
                self.apply_provenance_from(
                    "submitSettleMs",
                    newer,
                    newer.submit_settle_ms.map(|_| FieldProvenance::Seed),
                );
            }
            if can_update(self, "directHttpBlocked") {
                self.direct_http_blocked = newer.direct_http_blocked;
                self.direct_http_status = newer.direct_http_status;
                self.apply_provenance_from(
                    "directHttpBlocked",
                    newer,
                    newer.direct_http_blocked.then_some(FieldProvenance::Seed),
                );
            }
            if can_update(self, "requiresSameOriginFetch") {
                self.requires_same_origin_fetch = newer.requires_same_origin_fetch;
                self.apply_provenance_from(
                    "requiresSameOriginFetch",
                    newer,
                    newer.requires_same_origin_fetch.then_some(FieldProvenance::Seed),
                );
            }
            if can_update(self, "dynamicDom") {
                self.dynamic_dom = newer.dynamic_dom;
                self.apply_provenance_from(
                    "dynamicDom",
                    newer,
                    newer.dynamic_dom.then_some(FieldProvenance::Seed),
                );
            }
            self.is_seed = false;
            return;
        }

        // Disk / live learner overlay (`disk.updatedAt > seed.verifiedAt`): apply non-default or explicitly
        // tracked fields while never overwriting User-locked fields with Seed/Learned values.
        if can_update(self, "preferredWaitUntil")
            && (newer.preferred_wait_until.is_some()
                || newer.field_provenance.contains_key("preferredWaitUntil"))
        {
            self.preferred_wait_until = newer.preferred_wait_until.clone();
            self.wait_until_learned_at = newer.wait_until_learned_at;
            self.apply_provenance_from("preferredWaitUntil", newer, Some(FieldProvenance::Learned));
        }
        if can_update(self, "serviceWorkerNavigation")
            && (newer.service_worker_navigation
                || newer.field_provenance.contains_key("serviceWorkerNavigation"))
        {
            self.service_worker_navigation = newer.service_worker_navigation;
            self.sw_nav_learned_at = newer.sw_nav_learned_at;
            self.apply_provenance_from("serviceWorkerNavigation", newer, Some(FieldProvenance::Learned));
        }
        if can_update(self, "hydrationSettleMs")
            && (newer.hydration_settle_ms > 0
                || newer.field_provenance.contains_key("hydrationSettleMs"))
        {
            self.hydration_settle_ms = newer.hydration_settle_ms;
            self.settle_learned_at = newer.settle_learned_at;
            self.clean_nav_streak = newer.clean_nav_streak;
            self.apply_provenance_from("hydrationSettleMs", newer, Some(FieldProvenance::Learned));
        } else if newer.clean_nav_streak > 0 {
            self.clean_nav_streak = newer.clean_nav_streak;
        }
        if can_update(self, "readinessQuietMs")
            && (newer.readiness_quiet_ms.is_some()
                || newer.field_provenance.contains_key("readinessQuietMs"))
        {
            self.readiness_quiet_ms = newer.readiness_quiet_ms;
            self.apply_provenance_from("readinessQuietMs", newer, Some(FieldProvenance::Learned));
        }
        if can_update(self, "readinessSelector")
            && (newer.readiness_selector.is_some()
                || newer.field_provenance.contains_key("readinessSelector"))
        {
            self.readiness_selector = newer.readiness_selector.clone();
            self.apply_provenance_from("readinessSelector", newer, Some(FieldProvenance::Learned));
        }
        if can_update(self, "preferredSnapshotFrames")
            && (newer.preferred_snapshot_frames.is_some()
                || newer.field_provenance.contains_key("preferredSnapshotFrames"))
        {
            self.preferred_snapshot_frames = newer.preferred_snapshot_frames.clone();
            self.apply_provenance_from("preferredSnapshotFrames", newer, Some(FieldProvenance::Learned));
        }
        if can_update(self, "preferredInput")
            && (newer.preferred_input.is_some()
                || newer.field_provenance.contains_key("preferredInput"))
        {
            self.preferred_input = newer.preferred_input.clone();
            self.preferred_input_learned_at = newer.preferred_input_learned_at;
            self.apply_provenance_from("preferredInput", newer, Some(FieldProvenance::Learned));
        }
        if can_update(self, "actionSettleMs")
            && (newer.action_settle_ms.is_some()
                || newer.field_provenance.contains_key("actionSettleMs"))
        {
            self.action_settle_ms = newer.action_settle_ms;
            self.apply_provenance_from("actionSettleMs", newer, Some(FieldProvenance::Learned));
        }
        if can_update(self, "submitSettleMs")
            && (newer.submit_settle_ms.is_some()
                || newer.field_provenance.contains_key("submitSettleMs"))
        {
            self.submit_settle_ms = newer.submit_settle_ms;
            self.apply_provenance_from("submitSettleMs", newer, Some(FieldProvenance::Learned));
        }
        if can_update(self, "directHttpBlocked")
            && (newer.direct_http_blocked
                || newer.field_provenance.contains_key("directHttpBlocked"))
        {
            self.direct_http_blocked = newer.direct_http_blocked;
            self.direct_http_status = newer.direct_http_status.or(self.direct_http_status);
            self.apply_provenance_from("directHttpBlocked", newer, Some(FieldProvenance::Learned));
        }
        if can_update(self, "requiresSameOriginFetch")
            && (newer.requires_same_origin_fetch
                || newer.field_provenance.contains_key("requiresSameOriginFetch"))
        {
            self.requires_same_origin_fetch = newer.requires_same_origin_fetch;
            self.apply_provenance_from("requiresSameOriginFetch", newer, Some(FieldProvenance::Learned));
        }
        if can_update(self, "dynamicDom")
            && (newer.dynamic_dom || newer.field_provenance.contains_key("dynamicDom"))
        {
            self.dynamic_dom = newer.dynamic_dom;
            self.apply_provenance_from("dynamicDom", newer, Some(FieldProvenance::Learned));
        }
        for (rk, rb) in &newer.route_controllers {
            if !self.route_controllers.contains_key(rk)
                && self.route_controllers.len() >= MAX_ROUTES_PER_SITE
            {
                if let Some(evict_key) = self
                    .route_controllers
                    .iter()
                    .min_by_key(|(_, b)| b.last_used_epoch_s)
                    .map(|(k, _)| k.clone())
                {
                    self.route_controllers.remove(&evict_key);
                }
            }
            self.route_controllers.insert(rk.clone(), rb.clone());
        }
        for b in &newer.known_blockers {
            if !self.known_blockers.contains(b) && self.known_blockers.len() < MAX_BLOCKERS_PER_SITE {
                self.known_blockers.push(b.clone());
            }
        }
        for r in &newer.learned_recoveries {
            if let Some(ex) = self.learned_recoveries.iter_mut().find(|x| {
                x.trigger_code == r.trigger_code
                    && x.blocker == r.blocker
                    && x.recovery_method == r.recovery_method
                    && x.recovery_target == r.recovery_target
            }) {
                ex.success_count = ex.success_count.max(r.success_count);
                ex.last_verified_epoch_s = ex.last_verified_epoch_s.max(r.last_verified_epoch_s);
            } else if self.learned_recoveries.len() < MAX_RECOVERIES_PER_SITE {
                self.learned_recoveries.push(r.clone());
            }
        }
        if newer.stats.navigations > 0
            || newer.stats.snapshots > 0
            || newer.stats.in_page_actions > 0
            || newer.stats.load_timeouts > 0
            || newer.stats.stale_ref_errors > 0
            || newer.stats.not_ready_errors > 0
            || newer.stats.hydration_stalls > 0
        {
            self.stats = newer.stats.clone();
        }
        self.is_seed = false;
    }

    pub fn summary_lines(&self) -> Vec<String> {
        let now_s = now_epoch_s();
        let mut out = Vec::new();
        let mut knobs = Vec::new();
        if let Some(w) = self.effective_preferred_wait_until(now_s) {
            knobs.push(format!("waitUntil={w}"));
        }
        if self.effective_service_worker_navigation(now_s) {
            knobs.push("swCacheNav=fast(25ms)".to_string());
        }
        let settle = self.effective_hydration_settle_ms(now_s);
        if settle > 0 {
            knobs.push(format!("hydrationSettle={settle}ms"));
        }
        if let Some(q) = self.readiness_quiet_ms {
            knobs.push(format!("readinessQuiet={q}ms"));
        }
        if let Some(sel) = self.readiness_selector.as_deref().filter(|s| !s.trim().is_empty()) {
            knobs.push(format!("readinessSelector={sel}"));
        }
        if let Some(f) = &self.preferred_snapshot_frames {
            knobs.push(format!("snapshotFrames={f}"));
        }
        if let Some(inp) = self.effective_preferred_input(now_s) {
            knobs.push(format!("input={inp}"));
        }
        if let Some(ms) = self.action_settle_ms {
            knobs.push(format!("actionSettle={ms}ms"));
        }
        if let Some(ms) = self.submit_settle_ms {
            knobs.push(format!("submitSettle={ms}ms"));
        }
        if !knobs.is_empty() {
            out.push(format!("Auto-applied perf profile: {}", knobs.join(", ")));
        }
        if self.direct_http_blocked {
            let code = self
                .direct_http_status
                .map(|s| format!("HTTP {s}"))
                .unwrap_or_else(|| "WAF/auth".to_string());
            out.push(format!(
                "Access policy: direct anonymous HTTP failed ({code}); use browser tab or page.fetch session."
            ));
        }
        if self.requires_same_origin_fetch {
            out.push("Access policy: cross-origin page.fetch hit CORS; navigate tab to same origin before fetching.".to_string());
        }
        if self.dynamic_dom {
            out.push("DOM stability: dynamic SPA re-renders observed (stale_ref); prefer structured locators over snapshot refs.".to_string());
        }
        for rec in self.learned_recoveries.iter().rev().take(2) {
            let blk = if rec.blocker.is_empty() {
                rec.trigger_code.clone()
            } else {
                format!("{} {}", rec.trigger_code, rec.blocker)
            };
            out.push(format!(
                "Learned error recovery [{blk} -> {} {} (verified x{})]",
                rec.recovery_method, rec.recovery_target, rec.success_count
            ));
        }
        out
    }
}

fn default_schema_version() -> u32 {
    2
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SitePlaybook {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub domain: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<String>,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub updated_at_epoch_s: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speedup_summary: Option<String>,
    #[serde(default)]
    pub access_profile: SiteAccessProfile,
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub pitfalls: Vec<PitfallRecord>,
    #[serde(default)]
    pub routines: BTreeMap<String, RoutineDefinition>,
}

impl SitePlaybook {
    pub fn new(domain: impl Into<String>) -> Self {
        let now = now_epoch_s();
        Self {
            schema_version: 2,
            domain: domain.into(),
            verified_at: None,
            updated_at: epoch_to_iso8601(now),
            updated_at_epoch_s: now,
            speedup_summary: None,
            access_profile: SiteAccessProfile::default(),
            notes: Vec::new(),
            pitfalls: Vec::new(),
            routines: BTreeMap::new(),
        }
    }

    pub fn is_verification_aged(&self, now_s: u64) -> bool {
        let Some(v_ts) = self.verified_at.as_deref().and_then(iso8601_to_epoch) else {
            return false;
        };
        if now_s.saturating_sub(v_ts) < STALE_VERIFICATION_SECS {
            return false;
        }
        // Not aged if any routine succeeded within the window
        !self.routines.values().any(|r| {
            r.last_succeeded_at
                .as_deref()
                .and_then(iso8601_to_epoch)
                .is_some_and(|ok_s| now_s.saturating_sub(ok_s) < STALE_VERIFICATION_SECS)
        })
    }
}

const EMBEDDED_PLAYBOOK_JSONS: &[(&str, &str)] = &[
    ("google.com", include_str!("../../../../routines/google.com.json")),
    ("docs.google.com/document", include_str!("../../../../routines/docs.google.com__document.json")),
    ("docs.google.com/spreadsheets", include_str!("../../../../routines/docs.google.com__spreadsheets.json")),
    ("mail.google.com", include_str!("../../../../routines/mail.google.com.json")),
    ("github.com", include_str!("../../../../routines/github.com.json")),
    ("chatgpt.com", include_str!("../../../../routines/chatgpt.com.json")),
    ("claude.ai", include_str!("../../../../routines/claude.ai.json")),
    ("perplexity.ai", include_str!("../../../../routines/perplexity.ai.json")),
    ("diagrams.net", include_str!("../../../../routines/diagrams.net.json")),
    ("youtube.com", include_str!("../../../../routines/youtube.com.json")),
    ("wikipedia.org", include_str!("../../../../routines/wikipedia.org.json")),
    ("reddit.com", include_str!("../../../../routines/reddit.com.json")),
    ("x.com", include_str!("../../../../routines/x.com.json")),
    ("linkedin.com", include_str!("../../../../routines/linkedin.com.json")),
    ("notion.so", include_str!("../../../../routines/notion.so.json")),
    ("arxiv.org", include_str!("../../../../routines/arxiv.org.json")),
    ("huggingface.co", include_str!("../../../../routines/huggingface.co.json")),
    ("npmjs.com", include_str!("../../../../routines/npmjs.com.json")),
    ("pypi.org", include_str!("../../../../routines/pypi.org.json")),
    ("medium.com", include_str!("../../../../routines/medium.com.json")),
    ("stackoverflow.com", include_str!("../../../../routines/stackoverflow.com.json")),
    ("amazon.com", include_str!("../../../../routines/amazon.com.json")),
    ("news.ycombinator.com", include_str!("../../../../routines/news.ycombinator.com.json")),
    ("finance.yahoo.com", include_str!("../../../../routines/finance.yahoo.com.json")),
];

fn parse_embedded_playbook(key: &str) -> Option<SitePlaybook> {
    let (_, raw) = EMBEDDED_PLAYBOOK_JSONS.iter().find(|(k, _)| *k == key)?;
    let mut pb: SitePlaybook = serde_json::from_str(raw).ok()?;
    pb.access_profile.stamp_seed_provenance();
    Some(pb)
}

fn all_builtin_playbooks() -> Vec<SitePlaybook> {
    EMBEDDED_PLAYBOOK_JSONS
        .iter()
        .filter_map(|(k, _)| parse_embedded_playbook(k))
        .collect()
}

fn builtin_domain_key(domain: &str) -> Option<&'static str> {
    if domain == "docs.google.com/document" {
        Some("docs.google.com/document")
    } else if domain == "docs.google.com/spreadsheets" || domain == "sheets.google.com" {
        Some("docs.google.com/spreadsheets")
    } else if domain == "mail.google.com" {
        Some("mail.google.com")
    } else if domain == "chatgpt.com" || domain.ends_with(".chatgpt.com") || domain == "chat.openai.com" {
        Some("chatgpt.com")
    } else if domain == "claude.ai" || domain.ends_with(".claude.ai") {
        Some("claude.ai")
    } else if domain == "perplexity.ai" || domain.ends_with(".perplexity.ai") {
        Some("perplexity.ai")
    } else if domain == "diagrams.net" || domain.ends_with(".diagrams.net") || domain == "draw.io" || domain.ends_with(".draw.io") {
        Some("diagrams.net")
    } else if domain == "google.com" || domain == "www.google.com" {
        Some("google.com")
    } else if domain == "youtube.com" || domain == "www.youtube.com" || domain == "m.youtube.com" {
        Some("youtube.com")
    } else if domain == "github.com" || domain == "www.github.com" || domain == "gist.github.com" {
        Some("github.com")
    } else if domain == "wikipedia.org" || domain.ends_with(".wikipedia.org") {
        Some("wikipedia.org")
    } else if domain == "reddit.com" || domain.ends_with(".reddit.com") {
        Some("reddit.com")
    } else if domain == "x.com" || domain.ends_with(".x.com") || domain == "twitter.com" || domain.ends_with(".twitter.com") {
        Some("x.com")
    } else if domain == "linkedin.com" || domain.ends_with(".linkedin.com") {
        Some("linkedin.com")
    } else if domain == "notion.so" || domain.ends_with(".notion.so") || domain == "notion.com" || domain.ends_with(".notion.site") {
        Some("notion.so")
    } else if domain == "arxiv.org" || domain.ends_with(".arxiv.org") {
        Some("arxiv.org")
    } else if domain == "huggingface.co" || domain.ends_with(".huggingface.co") {
        Some("huggingface.co")
    } else if domain == "npmjs.com" || domain == "www.npmjs.com" {
        Some("npmjs.com")
    } else if domain == "pypi.org" || domain.ends_with(".pypi.org") {
        Some("pypi.org")
    } else if domain == "medium.com" || domain.ends_with(".medium.com") {
        Some("medium.com")
    } else if domain == "stackoverflow.com"
        || domain.ends_with(".stackoverflow.com")
        || domain.ends_with(".stackexchange.com")
        || domain == "superuser.com"
        || domain == "serverfault.com"
        || domain == "askubuntu.com"
    {
        Some("stackoverflow.com")
    } else if domain == "amazon.com" || domain == "www.amazon.com" {
        Some("amazon.com")
    } else if domain == "news.ycombinator.com" {
        Some("news.ycombinator.com")
    } else if domain == "finance.yahoo.com" {
        Some("finance.yahoo.com")
    } else {
        None
    }
}

fn builtin_playbook_for(domain: &str) -> Option<SitePlaybook> {
    builtin_domain_key(domain).and_then(parse_embedded_playbook)
}

pub fn playbook_filename(site_key: &str) -> String {
    format!("{}.json", site_key.replace('/', "__"))
}

fn playbook_path(domain: &str) -> PathBuf {
    routines_directory().join(playbook_filename(domain))
}

pub fn load_exact_playbook(domain: &str) -> Option<SitePlaybook> {
    let path = playbook_path(domain);
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_string_atomic(path: &std::path::Path, content: &str) -> Result<(), String> {
    static ATOMIC_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let Some(dir) = path.parent() else {
        return std::fs::write(path, content).map_err(|e| format!("Could not write {}: {e}", path.display()));
    };
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file.json");
    let seq = ATOMIC_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".{file_name}.tmp.{}.{seq}", std::process::id()));
    std::fs::write(&tmp, content).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    if std::fs::rename(&tmp, path).is_ok() {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let _ = std::fs::remove_file(path);
        if std::fs::rename(&tmp, path).is_ok() {
            return Ok(());
        }
    }
    let _ = std::fs::remove_file(&tmp);
    std::fs::write(path, content).map_err(|e| format!("Could not write {}: {e}", path.display()))
}

pub fn save_playbook(playbook: &SitePlaybook) -> Result<PathBuf, String> {
    let Some(clean_domain) = extract_domain(&playbook.domain) else {
        return Err("Invalid domain name.".to_string());
    };
    let dir = routines_directory();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let path = dir.join(playbook_filename(&clean_domain));
    let now = now_epoch_s();
    let mut normalized = playbook.clone();
    normalized.schema_version = 2;
    normalized.domain = clean_domain;
    normalized.updated_at_epoch_s = now;
    normalized.updated_at = epoch_to_iso8601(now);
    let pretty = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    write_string_atomic(&path, &format!("{pretty}\n"))?;
    Ok(path)
}

fn routine_latest_activity_epoch(r: &RoutineDefinition, fallback_epoch: u64) -> u64 {
    let upd = routine_timestamp_epoch(r, fallback_epoch);
    let ok_s = r.last_succeeded_at.as_deref().and_then(iso8601_to_epoch).unwrap_or(0);
    let fail_s = r.last_failed_at.as_deref().and_then(iso8601_to_epoch).unwrap_or(0);
    upd.max(ok_s).max(fail_s)
}

/// Persists a `SiteLearner` snapshot without clobbering newer routine definitions, `[STALE]` counts,
/// or `autoRepaired` locators written to disk by concurrent MCP / RPC routine executions.
pub fn save_playbook_preserving_newer_disk_routines(playbook: &SitePlaybook) -> Result<PathBuf, String> {
    let Some(clean_domain) = extract_domain(&playbook.domain) else {
        return Err("Invalid domain name.".to_string());
    };
    let mut merged = playbook.clone();
    merged.domain = clean_domain.clone();
    if let Some(disk) = load_exact_playbook(&clean_domain) {
        let disk_epoch = iso8601_to_epoch(&disk.updated_at).unwrap_or(disk.updated_at_epoch_s);
        for (k, disk_r) in disk.routines {
            match merged.routines.get(&k) {
                None => {
                    merged.routines.insert(k, disk_r);
                }
                Some(mem_r) => {
                    let disk_act = routine_latest_activity_epoch(&disk_r, disk_epoch);
                    let mem_act = routine_latest_activity_epoch(mem_r, 0);
                    if disk_act > mem_act
                        || (disk_act == mem_act && (disk_r.stale != mem_r.stale || disk_r.consecutive_failures > mem_r.consecutive_failures))
                    {
                        merged.routines.insert(k, disk_r);
                    }
                }
            }
        }
    }
    save_playbook(&merged)
}

pub const MAX_ACTIVITY_LOG_ENTRIES: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityLogEntry {
    pub ts: String,
    pub browser: String,
    pub instance: String,
    pub session: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    pub method: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub target: String,
    pub ok: bool,
    pub ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

pub fn activity_log_path() -> PathBuf {
    if let Some(custom) = std::env::var_os("BROWSER_BRIDGE_ACTIVITY_LOG") {
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    if let Some(r_dir) = std::env::var_os("BROWSER_BRIDGE_ROUTINES_DIR") {
        if !r_dir.is_empty() {
            let p = PathBuf::from(r_dir);
            let base = p.parent().unwrap_or(p.as_path());
            return base.join("logs").join("activity.jsonl");
        }
    }
    data_directory().join("logs").join("activity.jsonl")
}

/// Strictly scrubs a URL to `scheme://host[:port][/truncated_path]` with zero query strings,
/// zero `#hash` fragments, zero `user:pass@` credentials, and basename-only `file://` paths.
pub fn redact_url_for_activity_log(raw_url: &str) -> String {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let before_qh = trimmed.split(['?', '#']).next().unwrap_or("").trim();
    if before_qh.eq_ignore_ascii_case("about:blank") {
        return "about:blank".to_string();
    }
    if before_qh.len() >= 7 && before_qh[..7].eq_ignore_ascii_case("file://") {
        let after = &before_qh[7..];
        let seg = after
            .rsplit(['/', '\\'])
            .find(|s| !s.is_empty())
            .unwrap_or("local-file");
        let clean_seg: String = seg.chars().take(64).collect();
        return format!("file:///{clean_seg}");
    }
    let Some((scheme_raw, rest)) = before_qh.split_once("://") else {
        return before_qh.chars().take(80).collect();
    };
    let scheme = scheme_raw.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https") {
        return format!("{scheme}:");
    }
    let (authority_raw, path_raw) = match rest.split_once('/') {
        Some((a, p)) => (a, format!("/{p}")),
        None => (rest, String::new()),
    };
    let host_port = authority_raw.rsplit('@').next().unwrap_or(authority_raw).to_ascii_lowercase();
    if host_port.is_empty() {
        return String::new();
    }
    let clean_path: String = if path_raw.chars().count() > 96 {
        let mut s: String = path_raw.chars().take(95).collect();
        s.push('…');
        s
    } else {
        path_raw
    };
    format!("{scheme}://{host_port}{clean_path}")
}

pub fn should_log_activity_method(method: &str) -> bool {
    !matches!(method, "status" | "tabs.inventory")
}

pub fn append_activity_log(entry: &ActivityLogEntry) {
    let path = activity_log_path();
    let Some(dir) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let Ok(serialized) = serde_json::to_string(entry) else {
        return;
    };
    let existing_len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if existing_len < 32_768 {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = writeln!(file, "{serialized}");
        }
        return;
    }

    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<&str> = existing.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.len() + 1 <= MAX_ACTIVITY_LOG_ENTRIES {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = writeln!(file, "{serialized}");
        }
        return;
    }
    let drop_n = (lines.len() + 1).saturating_sub(MAX_ACTIVITY_LOG_ENTRIES);
    lines.drain(0..drop_n);
    let mut compacted = String::with_capacity(existing.len() + serialized.len() + 2);
    for l in lines {
        compacted.push_str(l);
        compacted.push('\n');
    }
    compacted.push_str(&serialized);
    compacted.push('\n');
    let _ = write_string_atomic(&path, &compacted);
}

pub fn read_activity_log(limit: usize) -> Vec<ActivityLogEntry> {
    let cap = limit.clamp(1, MAX_ACTIVITY_LOG_ENTRIES);
    let Ok(raw) = std::fs::read_to_string(activity_log_path()) else {
        return Vec::new();
    };
    let parsed: Vec<ActivityLogEntry> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<ActivityLogEntry>(l).ok())
        .collect();
    let start = parsed.len().saturating_sub(cap);
    parsed[start..].to_vec()
}

/// Seeds or upgrades built-in timestamped JSON playbooks inside `%LOCALAPPDATA%\BrowserBridge\routines\`,
/// preserving any newer local user routines, learned pitfalls, and notes.
pub fn seed_builtin_playbooks_to_disk() -> usize {
    let dir = routines_directory();
    if std::fs::create_dir_all(&dir).is_err() {
        return 0;
    }
    let mut written = 0usize;
    for seed in all_builtin_playbooks() {
        let merged = resolve_playbook(&seed.domain).unwrap_or(seed);
        let path = dir.join(playbook_filename(&merged.domain));
        if let Ok(pretty) = serde_json::to_string_pretty(&merged) {
            let content = format!("{pretty}\n");
            let unchanged = std::fs::read_to_string(&path).ok().as_deref() == Some(content.as_str());
            if !unchanged && std::fs::write(&path, content).is_ok() {
                written += 1;
            }
        }
    }
    written
}

fn routine_timestamp_epoch(r: &RoutineDefinition, fallback_epoch: u64) -> u64 {
    r.updated_at
        .as_deref()
        .and_then(iso8601_to_epoch)
        .or_else(|| r.verified_at.as_deref().and_then(iso8601_to_epoch))
        .unwrap_or(fallback_epoch)
}

/// Loads merged playbook for a URL or domain (combining built-in timestamped JSON routines with user/agent saved routines & pitfalls).
/// When a newer Browser Bridge release ships an updated built-in JSON (`seed.verifiedAt > disk.routine.updatedAt`),
/// the newer built-in routine definition automatically refreshes stale selectors!
pub fn resolve_playbook(url_or_domain: &str) -> Option<SitePlaybook> {
    let candidates = domain_candidates(url_or_domain);
    if candidates.is_empty() {
        return None;
    }
    let primary = candidates[0].clone();
    let mut merged: Option<SitePlaybook> = builtin_playbook_for(&primary);
    let builtin_domain = merged.as_ref().map(|b| b.domain.clone());
    for cand in candidates.iter().rev() {
        if let Some(disk) = load_exact_playbook(cand) {
            let disk_epoch = disk
                .updated_at
                .as_str()
                .trim()
                .is_empty()
                .then_some(disk.updated_at_epoch_s)
                .or_else(|| iso8601_to_epoch(&disk.updated_at))
                .unwrap_or(disk.updated_at_epoch_s);
            let entry = merged.get_or_insert_with(|| SitePlaybook::new(disk.domain.clone()));
            entry.domain = builtin_domain.clone().unwrap_or(disk.domain);
            if disk_epoch >= entry.updated_at_epoch_s {
                entry.updated_at_epoch_s = disk_epoch;
                if !disk.updated_at.trim().is_empty() {
                    entry.updated_at = disk.updated_at.clone();
                } else {
                    entry.updated_at = epoch_to_iso8601(disk_epoch);
                }
            }
            let seed_verified_epoch = entry
                .verified_at
                .as_deref()
                .and_then(iso8601_to_epoch)
                .unwrap_or(entry.updated_at_epoch_s);
            if let Some(dv) = &disk.verified_at {
                let dv_s = iso8601_to_epoch(dv).unwrap_or(0);
                if dv_s >= seed_verified_epoch {
                    entry.verified_at = Some(dv.clone());
                }
            }
            if disk.speedup_summary.is_some() && (entry.speedup_summary.is_none() || disk_epoch >= seed_verified_epoch) {
                entry.speedup_summary = disk.speedup_summary.clone();
            }
            if seed_verified_epoch >= disk_epoch {
                let seed_profile = entry.access_profile.clone();
                let mut combined = disk.access_profile;
                combined.merge_overlay(&seed_profile);
                entry.access_profile = combined;
            } else {
                entry.access_profile.merge_overlay(&disk.access_profile);
            }
            for note in disk.notes {
                if !entry.notes.contains(&note) {
                    entry.notes.push(note);
                }
            }
            for p in disk.pitfalls {
                if let Some(existing) = entry
                    .pitfalls
                    .iter_mut()
                    .find(|x| x.code == p.code && x.method == p.method && x.target == p.target)
                {
                    existing.count = existing.count.max(p.count);
                    existing.last_seen_epoch_s = existing.last_seen_epoch_s.max(p.last_seen_epoch_s);
                    existing.summary = p.summary;
                } else {
                    entry.pitfalls.push(p);
                }
            }
            for (k, disk_r) in disk.routines {
                if let Some(seed_r) = entry.routines.get(&k) {
                    let seed_ts = routine_timestamp_epoch(seed_r, 0);
                    let disk_ts = routine_timestamp_epoch(&disk_r, disk_epoch);
                    if seed_ts > disk_ts {
                        // Built-in JSON was updated more recently (e.g. minor version upgrade after a website redesign).
                        continue;
                    }
                }
                entry.routines.insert(k, disk_r);
            }
        }
    }
    if let Some(pb) = &mut merged {
        if pb.domain.is_empty() {
            pb.domain = primary;
        }
        if pb.updated_at.trim().is_empty() && pb.updated_at_epoch_s > 0 {
            pb.updated_at = epoch_to_iso8601(pb.updated_at_epoch_s);
        }
    }
    merged
}

pub fn list_all_playbooks() -> Vec<SitePlaybook> {
    let mut by_domain: BTreeMap<String, SitePlaybook> = BTreeMap::new();
    for seed in all_builtin_playbooks() {
        by_domain.insert(seed.domain.clone(), seed);
    }

    if let Ok(entries) = std::fs::read_dir(routines_directory()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(raw) = std::fs::read_to_string(&path) {
                if let Ok(pb) = serde_json::from_str::<SitePlaybook>(&raw) {
                    if let Some(resolved) = resolve_playbook(&pb.domain) {
                        by_domain.insert(resolved.domain.clone(), resolved);
                    } else {
                        by_domain.insert(pb.domain.clone(), pb);
                    }
                }
            }
        }
    }
    by_domain.into_values().collect()
}

fn append_pitfall_in_memory(
    pb: &mut SitePlaybook,
    code: &str,
    method: &str,
    target: &str,
    summary: &str,
) -> bool {
    if matches!(
        code,
        "unavailable" | "no_tab" | "forbidden" | "bad_request" | "disabled" | "closed" | "unknown_method" | "read_only"
    ) {
        return false;
    }
    let clean_summary: String = summary.chars().take(220).collect();
    let clean_target: String = target.chars().take(120).collect();
    if let Some(existing) = pb
        .pitfalls
        .iter_mut()
        .find(|p| p.code == code && p.method == method && p.target == clean_target)
    {
        existing.count += 1;
        existing.last_seen_epoch_s = now_epoch_s();
        existing.summary = clean_summary;
    } else {
        if pb.pitfalls.len() >= MAX_PITFALLS_PER_SITE {
            pb.pitfalls.remove(0);
        }
        pb.pitfalls.push(PitfallRecord {
            code: code.to_string(),
            method: method.to_string(),
            target: clean_target,
            summary: clean_summary,
            count: 1,
            last_seen_epoch_s: now_epoch_s(),
        });
    }
    true
}

pub fn record_pitfall_on_disk(
    url_or_domain: &str,
    code: &str,
    method: &str,
    target: &str,
    summary: &str,
) {
    let Some(domain) = canonical_site_key(url_or_domain) else {
        return;
    };
    if !should_persist_domain(&domain) {
        return;
    };
    let mut pb = load_exact_playbook(&domain).unwrap_or_else(|| SitePlaybook::new(domain.clone()));
    if append_pitfall_in_memory(&mut pb, code, method, target, summary) {
        let _ = save_playbook(&pb);
    }
}

pub fn record_direct_http_outcome_on_disk(url: &str, status: Option<u16>, network_blocked: bool) {
    let Some(domain) = canonical_site_key(url) else {
        return;
    };
    if !should_persist_domain(&domain) {
        return;
    }
    let blocked = network_blocked || matches!(status, Some(401 | 403 | 429 | 503));
    let succeeded = matches!(status, Some(200..=299));
    if !blocked && !succeeded {
        return;
    }
    let mut pb = load_exact_playbook(&domain).unwrap_or_else(|| SitePlaybook::new(domain.clone()));
    if pb.access_profile.is_user_locked("directHttpBlocked") {
        return;
    }
    if blocked {
        pb.access_profile.direct_http_blocked = true;
        pb.access_profile.direct_http_status = status;
        pb.access_profile
            .field_provenance
            .insert("directHttpBlocked".into(), FieldProvenance::Learned);
        let label = status
            .map(|c| format!("HTTP {c}"))
            .unwrap_or_else(|| "connection/WAF block".to_string());
        let _ = append_pitfall_in_memory(
            &mut pb,
            "http_blocked",
            "request.fetch",
            &domain,
            &format!("Direct anonymous HTTP returned {label}; prefer browser-session page.fetch."),
        );
        let _ = save_playbook(&pb);
    } else if succeeded && pb.access_profile.direct_http_blocked {
        pb.access_profile.direct_http_blocked = false;
        pb.access_profile.direct_http_status = None;
        pb.access_profile
            .field_provenance
            .insert("directHttpBlocked".into(), FieldProvenance::Learned);
        let _ = save_playbook(&pb);
    }
}

pub fn upsert_routine_or_note(
    url_or_domain: &str,
    note: Option<&str>,
    routine: Option<RoutineDefinition>,
    delete_routine: Option<&str>,
) -> Result<(PathBuf, SitePlaybook), String> {
    upsert_site_memory(url_or_domain, note, routine, delete_routine, false)
}

pub fn upsert_site_memory(
    url_or_domain: &str,
    note: Option<&str>,
    routine: Option<RoutineDefinition>,
    delete_routine: Option<&str>,
    reset_access_profile: bool,
) -> Result<(PathBuf, SitePlaybook), String> {
    let candidates = domain_candidates(url_or_domain);
    let Some(domain) = candidates.first().cloned() else {
        return Err("Provide a valid domain or URL (e.g. app.diagrams.net).".to_string());
    };
    let target_domain = if reset_access_profile {
        canonical_site_key(&domain).unwrap_or(domain)
    } else {
        candidates
            .iter()
            .find(|c| load_exact_playbook(c).is_some() || builtin_playbook_for(c).is_some_and(|b| b.domain == **c))
            .cloned()
            .unwrap_or(domain)
    };

    let mut pb = load_exact_playbook(&target_domain).unwrap_or_else(|| SitePlaybook::new(target_domain.clone()));
    if reset_access_profile {
        let seed_prof = builtin_playbook_for(&target_domain).map(|b| b.access_profile);
        pb.access_profile = pb
            .access_profile
            .reset_learned_preserving_user(seed_prof.as_ref());
        pb.pitfalls.clear();
    }
    if let Some(n) = note.map(str::trim).filter(|s| !s.is_empty()) {
        if !pb.notes.iter().any(|x| x == n) {
            if pb.notes.len() >= MAX_NOTES_PER_SITE {
                pb.notes.remove(0);
            }
            pb.notes.push(n.to_string());
        }
    }
    if let Some(del) = delete_routine.map(str::trim).filter(|s| !s.is_empty()) {
        pb.routines.remove(del);
    }
    if let Some(mut r) = routine {
        if r.name.trim().is_empty() || r.steps.is_empty() {
            return Err("Routine requires a non-empty name and at least one step.".to_string());
        }
        let ts = now_iso8601();
        r.updated_at = Some(ts.clone());
        if r.verified_at.is_none() {
            r.verified_at = Some(ts.clone());
        }
        r.stale = false;
        r.stale_reason = None;
        r.consecutive_failures = 0;
        pb.verified_at = Some(ts);
        pb.routines.insert(r.name.trim().to_string(), r);
    }
    let path = save_playbook(&pb)?;
    let merged = resolve_playbook(&target_domain).unwrap_or(pb);
    Ok((path, merged))
}

/// Tracks routine execution health per website and marks routines `stale = true` when consecutive selector/DOM
/// errors indicate the target website redesigned its UI since `verifiedAt`.
pub fn record_routine_outcome_on_disk(
    url_or_domain: &str,
    routine_name: &str,
    ok: bool,
    failure_detail: Option<&str>,
) {
    let Some(site_key) = canonical_site_key(url_or_domain) else {
        return;
    };
    if !should_persist_domain(&site_key) {
        return;
    }
    let mut pb = resolve_playbook(&site_key).unwrap_or_else(|| SitePlaybook::new(site_key.clone()));
    let Some(r) = pb.routines.get_mut(routine_name) else {
        return;
    };
    let ts = now_iso8601();
    if ok {
        let was_dirty = r.stale || r.consecutive_failures > 0 || r.last_succeeded_at.is_none();
        r.last_succeeded_at = Some(ts);
        r.consecutive_failures = 0;
        r.stale = false;
        r.stale_reason = None;
        if was_dirty {
            let _ = save_playbook(&pb);
        }
    } else {
        let detail = failure_detail.unwrap_or("");
        let is_selector_drift = detail.contains("[timeout]")
            || detail.contains("[not_actionable]")
            || detail.contains("[strict_locator]")
            || detail.contains("[page_error]");
        if !is_selector_drift {
            return;
        }
        r.consecutive_failures = r.consecutive_failures.saturating_add(1);
        r.last_failed_at = Some(ts);
        if r.consecutive_failures >= 2 {
            let v_ts = r
                .verified_at
                .as_deref()
                .or(pb.verified_at.as_deref())
                .unwrap_or("unknown");
            r.stale = true;
            r.stale_reason = Some(format!(
                "Failed {}x consecutively since verifiedAt {v_ts}; website DOM may have redesigned — inspect snapshot and update via browser_routine_save.",
                r.consecutive_failures
            ));
        }
        let _ = save_playbook(&pb);
    }
}

pub fn format_site_memory_hint_from_playbook(pb: &SitePlaybook) -> Option<String> {
    let perf_lines = pb.access_profile.summary_lines();
    if pb.routines.is_empty() && pb.notes.is_empty() && pb.pitfalls.is_empty() && perf_lines.is_empty() {
        return None;
    }
    let ts_tag = pb
        .verified_at
        .as_deref()
        .map(|v| format!(" (verified {v})"))
        .unwrap_or_default();
    let mut lines = vec![format!("\n[Site Memory & Fast Routines — {}{ts_tag}]", pb.domain)];
    if pb.is_verification_aged(now_epoch_s()) {
        lines.push("Notice: site JSON verification timestamp is >90 days old; if selectors fail after a site redesign, inspect snapshot and refresh via browser_routine_save.".to_string());
    }
    for pl in perf_lines.iter().take(3) {
        lines.push(pl.clone());
    }
    if !pb.routines.is_empty() {
        let summary: Vec<String> = pb
            .routines
            .values()
            .map(|r| {
                let args: Vec<&str> = r.params.keys().map(String::as_str).collect();
                let prefix = if r.stale {
                    "[STALE] "
                } else if r.source.as_deref() == Some("auto_learned") {
                    "[auto] "
                } else {
                    ""
                };
                if args.is_empty() {
                    format!("{prefix}{}", r.name)
                } else {
                    format!("{prefix}{}({})", r.name, args.join(", "))
                }
            })
            .collect();
        lines.push(format!(
            "Available routines (call browser_routine_run to execute in 1 step): {}",
            summary.join(" | ")
        ));
        for stale_r in pb.routines.values().filter(|r| r.stale).take(1) {
            if let Some(reason) = &stale_r.stale_reason {
                lines.push(format!("Redesign warning on '{}': {reason}", stale_r.name));
            }
        }
    }
    for note in pb.notes.iter().take(2) {
        lines.push(format!("Tip: {note}"));
    }
    for pitfall in pb.pitfalls.iter().rev().take(2) {
        lines.push(format!(
            "Avoid recorded detour [{} x{} on {}]: {}",
            pitfall.code, pitfall.count, pitfall.method, pitfall.summary
        ));
    }
    Some(lines.join("\n"))
}

pub fn format_site_memory_hint(url_or_domain: &str) -> Option<String> {
    let pb = resolve_playbook(url_or_domain)?;
    format_site_memory_hint_from_playbook(&pb)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceEvent {
    pub seq: u64,
    pub tab_id: Option<i64>,
    pub domain: String,
    pub method: String,
    pub target: String,
    pub duration_ms: u64,
    pub ok: bool,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

/// Per-session in-memory tracker that remembers tab->URL mappings, records attempts/detours, and tracks hinted domains.
#[derive(Default)]
pub struct SessionTracker {
    seq: u64,
    pub tab_urls: HashMap<i64, String>,
    pub hinted_domains: HashSet<String>,
    pub trace: VecDeque<TraceEvent>,
}

impl SessionTracker {
    pub fn observe_url(&mut self, tab_id: Option<i64>, url: Option<&str>) -> Option<String> {
        if let (Some(id), Some(u)) = (tab_id, url.filter(|s| !s.is_empty())) {
            self.tab_urls.insert(id, u.to_string());
            return Some(u.to_string());
        }
        tab_id.and_then(|id| self.tab_urls.get(&id).cloned())
    }

    pub fn should_inject_hint(&mut self, url_or_domain: &str) -> Option<String> {
        let pb = resolve_playbook(url_or_domain)?;
        if self.hinted_domains.insert(pb.domain.clone()) {
            format_site_memory_hint(url_or_domain)
        } else {
            None
        }
    }

    pub fn record_call(
        &mut self,
        tab_id: Option<i64>,
        url_hint: Option<&str>,
        method: &str,
        params: &Value,
        duration_ms: u64,
        result: Result<&Value, &BridgeError>,
    ) {
        let resolved_url = match result {
            Ok(val) => {
                let res_tab = val.get("tabId").and_then(Value::as_i64).or(tab_id);
                let res_url = val.get("url").and_then(Value::as_str).or(url_hint);
                self.observe_url(res_tab, res_url)
            }
            Err(_) => self.observe_url(tab_id, url_hint),
        };
        let domain = resolved_url
            .as_deref()
            .and_then(extract_domain)
            .unwrap_or_default();
        let target = summarize_target(params);
        self.seq += 1;

        match result {
            Ok(_) => {
                if self.trace.len() >= MAX_TRACE_ENTRIES {
                    self.trace.pop_front();
                }
                self.trace.push_back(TraceEvent {
                    seq: self.seq,
                    tab_id,
                    domain,
                    method: method.to_string(),
                    target,
                    duration_ms,
                    ok: true,
                    error_code: None,
                    error_message: None,
                });
            }
            Err(err) => {
                if self.trace.len() >= MAX_TRACE_ENTRIES {
                    self.trace.pop_front();
                }
                self.trace.push_back(TraceEvent {
                    seq: self.seq,
                    tab_id,
                    domain,
                    method: method.to_string(),
                    target,
                    duration_ms,
                    ok: false,
                    error_code: Some(err.code().to_string()),
                    error_message: Some(err.message().to_string()),
                });
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct PreparedCall {
    pub session_id: String,
    pub method: String,
    pub tab_id: Option<i64>,
    pub url_hint: Option<String>,
    pub target_summary: String,
    pub sanitized_params: Value,
    pub raw_action_params: Value,
    pub from_routine: bool,
    pub no_learn: bool,
    pub profile_overridden: bool,
    pub explicit_wait_until: bool,
    pub explicit_frames: bool,
    pub selected_route_key: Option<String>,
    pub selected_arm_id: Option<String>,
    pub full_page_read: bool,
    pub started_at: Instant,
}

#[derive(Debug, Clone)]
struct ActiveNavArm {
    domain_key: String,
    route_key: String,
    arm_id: String,
    content_evaluated: bool,
    at: Instant,
}

#[derive(Debug, Clone)]
struct PendingRecovery {
    failed_method: String,
    failed_target: String,
    error_code: String,
    blocker: String,
    candidate_recovery: Option<(String, String, Value)>,
}

const MAX_AUTO_ROUTINES_PER_SITE: usize = 8;
const MIN_SUBMIT_ROUTINE_STEPS: usize = 3;
const MIN_FLUSH_ROUTINE_STEPS: usize = 4;

#[derive(Debug, Clone)]
struct DistilledStep {
    op: String,
    locator: Option<Value>,
    params: Map<String, Value>,
    field_label: String,
    sensitive: bool,
}

#[derive(Debug, Clone)]
struct TabTrajectory {
    session_id: String,
    domain: String,
    entry_url: String,
    steps: Vec<DistilledStep>,
    failed_detours: u32,
    has_unpromoted_ref: bool,
    last_step_at: Instant,
}

/// Universal gateway learner that observes all browser commands, errors, and telemetry across MCP, Python, RPC, and UI,
/// dynamically optimizing per-site navigation, snapshot, input delivery, settle parameters, and multi-step auto-routines.
#[derive(Default)]
pub struct SiteLearner {
    pub session_tabs: HashMap<String, i64>,
    pub tab_urls: HashMap<i64, String>,
    last_nav_at: HashMap<i64, (Instant, String)>,
    last_action_at: HashMap<i64, (Instant, String)>,
    last_nav_arm: HashMap<i64, ActiveNavArm>,
    pending_recovery: HashMap<i64, PendingRecovery>,
    trajectories: HashMap<i64, TabTrajectory>,
    extra_persists: Vec<SitePlaybook>,
    playbooks: HashMap<String, SitePlaybook>,
}

fn update_ema(current: u64, sample: u64) -> u64 {
    if current == 0 {
        sample
    } else {
        (current.saturating_mul(3).saturating_add(sample)) / 4
    }
}

pub fn extract_blocker_tag(message: &str) -> Option<String> {
    let idx = message.find("covered by <")?;
    let rest = &message[idx + "covered by ".len()..];
    let end = rest.find('>')?;
    if end == 0 || end > 80 {
        return None;
    }
    Some(rest[..=end].to_string())
}

fn extract_snapshot_header_url(text: &str) -> Option<&str> {
    for line in text.lines().take(4) {
        if let Some(u) = line.strip_prefix("URL: ") {
            let trimmed = u.trim();
            if !trimmed.is_empty() && trimmed != "about:blank" {
                return Some(trimmed);
            }
        }
    }
    None
}

fn sanitize_recovery_params(params: &Value) -> Value {
    let Some(obj) = params.as_object() else {
        return json!({});
    };
    let mut clean = Map::new();
    for key in ["locator", "key", "direction", "accept"] {
        if let Some(v) = obj.get(key) {
            clean.insert(key.to_string(), v.clone());
        }
    }
    Value::Object(clean)
}

fn is_mutating_recovery_action(method: &str) -> bool {
    matches!(
        method,
        "page.click" | "page.press" | "page.type" | "page.scroll" | "page.dialog" | "page.check" | "page.select"
    )
}

fn sanitize_action_params_for_trajectory(params: &Value) -> Value {
    let Some(obj) = params.as_object() else {
        return json!({});
    };
    let mut clean = Map::new();
    for key in [
        "locator",
        "ref",
        "text",
        "clear",
        "slowly",
        "submit",
        "checked",
        "values",
        "doubleClick",
        "button",
        "modifiers",
        "key",
        "accept",
        "promptText",
        "armNext",
        "fromLocator",
        "toLocator",
        "dx",
        "dy",
        "steps",
        "fields",
    ] {
        if let Some(v) = obj.get(key) {
            clean.insert(key.to_string(), v.clone());
        }
    }
    Value::Object(clean)
}

fn is_synthesizable_action(method: &str) -> bool {
    matches!(
        method,
        "page.click" | "page.type" | "page.select" | "page.check" | "page.press" | "page.dialog" | "page.drag"
    )
}

fn looks_sensitive_field(label: &str, locator: Option<&Value>) -> bool {
    let loc_str = locator.map(Value::to_string).unwrap_or_default();
    let combined = format!("{} {}", label.to_ascii_lowercase(), loc_str.to_ascii_lowercase());
    [
        "passw",
        "otp",
        "totp",
        "cvv",
        "cvc",
        "secret",
        "api_key",
        "apikey",
        "passcode",
        "pin_code",
        "one-time-code",
    ]
    .iter()
    .any(|kw| combined.contains(kw))
}

fn slugify_identifier(raw: &str, max_len: usize) -> String {
    let mut out = String::new();
    let mut prev_sep = true;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_sep = false;
            if out.len() >= max_len {
                break;
            }
        } else if !prev_sep && !out.is_empty() {
            out.push('_');
            prev_sep = true;
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        format!("f_{trimmed}")
    } else {
        trimmed
    }
}

fn label_from_locator(locator: Option<&Value>) -> String {
    let Some(steps) = locator.and_then(|l| l.get("steps")).and_then(Value::as_array) else {
        return String::new();
    };
    for step in steps.iter().rev() {
        if let Some(name) = step.get("name").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
            return name.trim().to_string();
        }
        if let Some(val) = step.get("value").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
            let kind = step.get("kind").and_then(Value::as_str).unwrap_or("");
            if kind != "role" {
                return val.trim().to_string();
            }
        }
    }
    String::new()
}

fn routine_structural_fingerprint(steps: &[RoutineStep]) -> String {
    steps
        .iter()
        .map(|s| {
            let canonical_op = canonical_step_method(&s.op).unwrap_or(s.op.as_str());
            let loc = s
                .params
                .get("locator")
                .map(Value::to_string)
                .unwrap_or_else(|| {
                    s.params
                        .get("key")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                });
            format!("{canonical_op}:{loc}")
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn derive_auto_routine_base_name(entry_url: &str, steps: &[DistilledStep]) -> String {
    let path = extract_path(entry_url);
    let meaningful_segs: Vec<String> = path
        .split('/')
        .filter(|s| !s.is_empty())
        .filter(|s| {
            !s.chars().all(|c| c.is_ascii_digit())
                && !(s.len() >= 16 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        })
        .map(|s| slugify_identifier(s, 16))
        .filter(|s| !s.is_empty())
        .collect();
    let tail_segs: Vec<&str> = meaningful_segs
        .iter()
        .rev()
        .take(3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(String::as_str)
        .collect();
    let path_slug = if tail_segs.is_empty() {
        "page".to_string()
    } else {
        tail_segs.join("_")
    };
    let action_slug = steps
        .last()
        .map(|last| slugify_identifier(&last.field_label, 16))
        .filter(|s| !s.is_empty() && !path_slug.ends_with(s.as_str()))
        .unwrap_or_default();
    if action_slug.is_empty() {
        format!("auto_{path_slug}")
    } else {
        format!("auto_{path_slug}_{action_slug}")
    }
}

fn distill_trajectory_to_routine(
    traj: &TabTrajectory,
    existing: &BTreeMap<String, RoutineDefinition>,
) -> Option<RoutineDefinition> {
    if traj.has_unpromoted_ref || traj.steps.is_empty() {
        return None;
    }
    let mut params_spec: BTreeMap<String, RoutineParamSpec> = BTreeMap::new();
    let mut slug_counts: HashMap<String, usize> = HashMap::new();
    let mut out_steps: Vec<RoutineStep> = Vec::with_capacity(traj.steps.len());

    for d in &traj.steps {
        let mut step_params = d.params.clone();
        if d.op == "type" {
            let raw_text = step_params
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if d.sensitive || params_spec.len() < 10 {
                let base_slug = {
                    let s = slugify_identifier(&d.field_label, 24);
                    if s.is_empty() {
                        if d.sensitive {
                            "secret_input".to_string()
                        } else {
                            "input_text".to_string()
                        }
                    } else {
                        s
                    }
                };
                let count = slug_counts.entry(base_slug.clone()).or_insert(0);
                *count += 1;
                let param_name = if *count == 1 && !params_spec.contains_key(&base_slug) {
                    base_slug
                } else {
                    format!("{base_slug}_{count}")
                };
                let label_desc = if d.field_label.is_empty() {
                    param_name.clone()
                } else {
                    d.field_label.clone()
                };
                params_spec.insert(
                    param_name.clone(),
                    RoutineParamSpec {
                        kind: "string".to_string(),
                        description: format!("Input value for '{label_desc}'."),
                        required: d.sensitive,
                        default: if d.sensitive { None } else { Some(json!(raw_text)) },
                    },
                );
                step_params.insert("text".into(), json!(format!("{{{{{param_name}}}}}")));
            }
        }
        out_steps.push(RoutineStep {
            op: d.op.clone(),
            params: Value::Object(step_params),
            save_as: None,
            optional: false,
        });
    }

    let base_name = derive_auto_routine_base_name(&traj.entry_url, &traj.steps);
    let mut final_name = base_name.clone();
    let mut suffix = 2usize;
    while existing.contains_key(&final_name) {
        final_name = format!("{base_name}_{suffix}");
        suffix += 1;
    }

    let entry_path = {
        let p = extract_path(&traj.entry_url);
        if p.is_empty() { "/".to_string() } else { p }
    };
    let detour_note = if traj.failed_detours > 0 {
        format!(" (eliminated {} failed detour{})", traj.failed_detours, if traj.failed_detours == 1 { "" } else { "s" })
    } else {
        String::new()
    };
    let now_ts = now_iso8601();

    Some(RoutineDefinition {
        name: final_name,
        description: format!(
            "Auto-learned {}-step workflow on {entry_path}{detour_note}.",
            out_steps.len()
        ),
        read_only: false,
        source: Some("auto_learned".to_string()),
        verified_at: Some(now_ts.clone()),
        updated_at: Some(now_ts.clone()),
        last_succeeded_at: Some(now_ts),
        last_failed_at: None,
        consecutive_failures: 0,
        stale: false,
        stale_reason: None,
        params: params_spec,
        steps: out_steps,
    })
}

impl SiteLearner {
    fn ensure_loaded(&mut self, domain_or_url: &str) -> Option<String> {
        let key = canonical_site_key(domain_or_url)?;
        if !self.playbooks.contains_key(&key) {
            let mut pb = resolve_playbook(&key).unwrap_or_else(|| SitePlaybook::new(key.clone()));
            pb.domain = key.clone();
            self.playbooks.insert(key.clone(), pb);
        }
        Some(key)
    }

    fn commit_trajectory_if_qualified(&mut self, tab_id: i64, min_steps: usize) -> Option<String> {
        let traj = self.trajectories.remove(&tab_id)?;
        if traj.has_unpromoted_ref || traj.steps.len() < min_steps {
            return None;
        }
        let domain_key = self.ensure_loaded(&traj.domain)?;
        let pb = self.playbooks.get_mut(&domain_key)?;

        // Build candidate first so we can check structural fingerprint against existing routines.
        let candidate = distill_trajectory_to_routine(&traj, &pb.routines)?;
        let fp = routine_structural_fingerprint(&candidate.steps);
        let now_s = now_epoch_s();
        let now_ts = epoch_to_iso8601(now_s);

        if let Some(existing_r) = pb
            .routines
            .values_mut()
            .find(|r| routine_structural_fingerprint(&r.steps) == fp)
        {
            existing_r.last_succeeded_at = Some(now_ts.clone());
            existing_r.consecutive_failures = 0;
            existing_r.stale = false;
            existing_r.stale_reason = None;
            pb.updated_at_epoch_s = now_s;
            pb.updated_at = now_ts;
            return Some(domain_key);
        }

        // Enforce per-site auto_learned cap without touching built-in or user-saved routines.
        let mut auto_keys: Vec<(String, u64)> = pb
            .routines
            .iter()
            .filter(|(_, r)| r.source.as_deref() == Some("auto_learned"))
            .map(|(k, r)| (k.clone(), routine_timestamp_epoch(r, 0)))
            .collect();
        if auto_keys.len() >= MAX_AUTO_ROUTINES_PER_SITE {
            auto_keys.sort_by_key(|(_, ts)| *ts);
            if let Some((oldest_key, _)) = auto_keys.first() {
                pb.routines.remove(oldest_key);
            }
        }

        pb.routines.insert(candidate.name.clone(), candidate);
        pb.verified_at = Some(now_ts.clone());
        pb.updated_at_epoch_s = now_s;
        pb.updated_at = now_ts;
        Some(domain_key)
    }

    fn queue_persist_for_domain(&mut self, domain_key: &str) {
        if !should_persist_domain(domain_key) {
            return;
        }
        if let Some(pb) = self.playbooks.get(domain_key).cloned() {
            if let Some(existing) = self.extra_persists.iter_mut().find(|x| x.domain == pb.domain) {
                *existing = pb;
            } else {
                self.extra_persists.push(pb);
            }
        }
    }

    pub fn take_extra_persists(&mut self) -> Vec<SitePlaybook> {
        std::mem::take(&mut self.extra_persists)
    }

    pub fn flush_idle_trajectories(&mut self, min_idle: Duration) -> Vec<SitePlaybook> {
        let candidate_tabs: Vec<i64> = self
            .trajectories
            .iter()
            .filter(|(_, t)| t.steps.len() >= MIN_FLUSH_ROUTINE_STEPS && t.last_step_at.elapsed() >= min_idle)
            .map(|(tid, _)| *tid)
            .collect();
        for tid in candidate_tabs {
            if let Some(dom) = self.commit_trajectory_if_qualified(tid, MIN_FLUSH_ROUTINE_STEPS) {
                self.queue_persist_for_domain(&dom);
            }
        }
        self.take_extra_persists()
    }

    pub fn close_session(&mut self, session_id: &str) -> Vec<SitePlaybook> {
        self.session_tabs.remove(session_id);
        let tabs_for_session: Vec<i64> = self
            .trajectories
            .iter()
            .filter(|(_, t)| t.session_id == session_id)
            .map(|(tid, _)| *tid)
            .collect();
        for tid in tabs_for_session {
            if let Some(dom) = self.commit_trajectory_if_qualified(tid, MIN_FLUSH_ROUTINE_STEPS) {
                self.queue_persist_for_domain(&dom);
            }
        }
        self.take_extra_persists()
    }

    fn record_trajectory_action(
        &mut self,
        tab_id: i64,
        session_id: &str,
        domain_key: &str,
        current_url: &str,
        call: &PreparedCall,
        telemetry: &Value,
    ) {
        let entry = self.trajectories.entry(tab_id).or_insert_with(|| TabTrajectory {
            session_id: session_id.to_string(),
            domain: domain_key.to_string(),
            entry_url: current_url.to_string(),
            steps: Vec::new(),
            failed_detours: 0,
            has_unpromoted_ref: false,
            last_step_at: Instant::now(),
        });
        if entry.domain != domain_key {
            let prev_dom = entry.domain.clone();
            if let Some(committed) = self.commit_trajectory_if_qualified(tab_id, MIN_FLUSH_ROUTINE_STEPS) {
                if committed != domain_key {
                    self.queue_persist_for_domain(&committed);
                } else {
                    let _ = prev_dom;
                }
            }
            self.trajectories.insert(
                tab_id,
                TabTrajectory {
                    session_id: session_id.to_string(),
                    domain: domain_key.to_string(),
                    entry_url: current_url.to_string(),
                    steps: Vec::new(),
                    failed_detours: 0,
                    has_unpromoted_ref: false,
                    last_step_at: Instant::now(),
                },
            );
        }

        let traj = self.trajectories.get_mut(&tab_id).unwrap();
        traj.last_step_at = Instant::now();
        traj.session_id = session_id.to_string();

        let raw_obj = call.raw_action_params.as_object();
        let resolved_locator = raw_obj
            .and_then(|o| o.get("locator"))
            .cloned()
            .or_else(|| telemetry.get("semanticLocator").cloned());
        let had_raw_ref = raw_obj.and_then(|o| o.get("ref")).is_some();

        let needs_target = matches!(
            call.method.as_str(),
            "page.click" | "page.type" | "page.select" | "page.check"
        );
        if (needs_target && resolved_locator.is_none()) || (had_raw_ref && resolved_locator.is_none()) {
            traj.has_unpromoted_ref = true;
            return;
        }
        if call.method == "page.drag"
            && (raw_obj.and_then(|o| o.get("fromLocator")).is_none()
                || raw_obj.and_then(|o| o.get("toLocator")).is_none())
        {
            traj.has_unpromoted_ref = true;
            return;
        }

        let field_label = telemetry
            .get("fieldLabel")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| label_from_locator(resolved_locator.as_ref()));
        let sensitive = telemetry.get("sensitive").and_then(Value::as_bool).unwrap_or(false)
            || looks_sensitive_field(&field_label, resolved_locator.as_ref());

        let mut step_params = Map::new();
        if let Some(loc) = &resolved_locator {
            step_params.insert("locator".into(), loc.clone());
        }

        let op = match call.method.as_str() {
            "page.click" => {
                let dbl = raw_obj
                    .and_then(|o| o.get("doubleClick"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if let Some(btn) = raw_obj.and_then(|o| o.get("button")).and_then(Value::as_str) {
                    if btn != "left" {
                        step_params.insert("button".into(), json!(btn));
                    }
                }
                if let Some(mods) = raw_obj.and_then(|o| o.get("modifiers")).and_then(Value::as_array) {
                    if !mods.is_empty() {
                        step_params.insert("modifiers".into(), Value::Array(mods.clone()));
                    }
                }
                if dbl { "doubleClick" } else { "click" }
            }
            "page.type" => {
                let txt = if sensitive {
                    String::new()
                } else {
                    raw_obj
                        .and_then(|o| o.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                };
                step_params.insert("text".into(), json!(txt));
                let clear = raw_obj
                    .and_then(|o| o.get("clear"))
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                step_params.insert("clear".into(), json!(clear));
                if raw_obj
                    .and_then(|o| o.get("slowly"))
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    step_params.insert("slowly".into(), json!(true));
                }
                if raw_obj
                    .and_then(|o| o.get("submit"))
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    step_params.insert("submit".into(), json!(true));
                }
                "type"
            }
            "page.select" => {
                if let Some(vals) = raw_obj.and_then(|o| o.get("values")) {
                    step_params.insert("values".into(), vals.clone());
                }
                "select"
            }
            "page.check" => {
                if let Some(chk) = raw_obj.and_then(|o| o.get("checked")) {
                    step_params.insert("checked".into(), chk.clone());
                }
                "check"
            }
            "page.press" => {
                if let Some(k) = raw_obj.and_then(|o| o.get("key")) {
                    step_params.insert("key".into(), k.clone());
                }
                "press"
            }
            "page.dialog" => {
                for k in ["accept", "promptText", "armNext"] {
                    if let Some(v) = raw_obj.and_then(|o| o.get(k)) {
                        step_params.insert(k.to_string(), v.clone());
                    }
                }
                "dialog"
            }
            "page.drag" => {
                for k in ["fromLocator", "toLocator", "dx", "dy", "steps"] {
                    if let Some(v) = raw_obj.and_then(|o| o.get(k)) {
                        step_params.insert(k.to_string(), v.clone());
                    }
                }
                "drag"
            }
            _ => return,
        };

        // Coalesce consecutive type/check on the exact same locator so typos/drafts collapse cleanly.
        if op == "type"
            && step_params.get("clear").and_then(Value::as_bool) == Some(true)
            && step_params.get("submit").and_then(Value::as_bool) != Some(true)
        {
            if let Some(prev) = traj.steps.last_mut() {
                if prev.op == "type"
                    && prev.locator == resolved_locator
                    && prev.params.get("submit").and_then(Value::as_bool) != Some(true)
                {
                    prev.params = step_params;
                    prev.sensitive |= sensitive;
                    return;
                }
            }
        } else if op == "check" {
            if let Some(prev) = traj.steps.last_mut() {
                if prev.op == "check" && prev.locator == resolved_locator {
                    prev.params = step_params;
                    return;
                }
            }
        }

        if traj.steps.len() < 60 {
            traj.steps.push(DistilledStep {
                op: op.to_string(),
                locator: resolved_locator,
                params: step_params,
                field_label,
                sensitive,
            });
        }
    }

    pub fn get_playbook(&mut self, url_or_domain: &str) -> Option<SitePlaybook> {
        let key = self.ensure_loaded(url_or_domain)?;
        let mut merged = resolve_playbook(&key).unwrap_or_else(|| SitePlaybook::new(key.clone()));
        if let Some(live) = self.playbooks.get(&key) {
            merged.domain = live.domain.clone();
            merged.updated_at_epoch_s = merged.updated_at_epoch_s.max(live.updated_at_epoch_s);
            merged.access_profile.merge_overlay(&live.access_profile);
            for n in &live.notes {
                if !merged.notes.contains(n) {
                    merged.notes.push(n.clone());
                }
            }
            for p in &live.pitfalls {
                if let Some(ex) = merged
                    .pitfalls
                    .iter_mut()
                    .find(|x| x.code == p.code && x.method == p.method && x.target == p.target)
                {
                    ex.count = ex.count.max(p.count);
                    ex.last_seen_epoch_s = ex.last_seen_epoch_s.max(p.last_seen_epoch_s);
                    ex.summary = p.summary.clone();
                } else {
                    merged.pitfalls.push(p.clone());
                }
            }
            for (k, r) in &live.routines {
                merged.routines.insert(k.clone(), r.clone());
            }
        }
        Some(merged)
    }

    pub fn domain_for_session_or_tab(&self, session_id: &str, tab_id: Option<i64>) -> Option<String> {
        let tid = tab_id.or_else(|| self.session_tabs.get(session_id).copied())?;
        self.tab_urls.get(&tid).and_then(|u| canonical_site_key(u))
    }

    pub fn upsert_memory(
        &mut self,
        url_or_domain: &str,
        note: Option<&str>,
        routine: Option<RoutineDefinition>,
        delete_routine: Option<&str>,
        reset_access_profile: bool,
    ) -> Result<(Option<PathBuf>, SitePlaybook), String> {
        let Some(key) = canonical_site_key(url_or_domain) else {
            return Err("Provide a valid domain or URL.".to_string());
        };
        if should_persist_domain(&key) {
            if reset_access_profile {
                self.playbooks.remove(&key);
            }
            let (path, merged) =
                upsert_site_memory(&key, note, routine, delete_routine, reset_access_profile)?;
            self.playbooks.insert(key, merged.clone());
            Ok((Some(path), merged))
        } else {
            let _ = self.ensure_loaded(&key);
            let pb = self.playbooks.get_mut(&key).unwrap();
            if reset_access_profile {
                let seed_prof = builtin_playbook_for(&key).map(|b| b.access_profile);
                pb.access_profile = pb
                    .access_profile
                    .reset_learned_preserving_user(seed_prof.as_ref());
                pb.pitfalls.clear();
            }
            if let Some(n) = note.map(str::trim).filter(|s| !s.is_empty()) {
                if !pb.notes.iter().any(|x| x == n) {
                    pb.notes.push(n.to_string());
                }
            }
            if let Some(del) = delete_routine.map(str::trim).filter(|s| !s.is_empty()) {
                pb.routines.remove(del);
            }
            if let Some(r) = routine {
                pb.routines.insert(r.name.clone(), r);
            }
            pb.updated_at_epoch_s = now_epoch_s();
            Ok((None, pb.clone()))
        }
    }

    pub fn record_direct_http(&mut self, url: &str, status: Option<u16>, network_blocked: bool) -> Option<SitePlaybook> {
        let key = self.ensure_loaded(url)?;
        let blocked = network_blocked || matches!(status, Some(401 | 403 | 429 | 503));
        let succeeded = matches!(status, Some(200..=299));
        if !blocked && !succeeded {
            return None;
        }
        let pb = self.playbooks.get_mut(&key)?;
        if pb.access_profile.is_user_locked("directHttpBlocked") {
            return None;
        }
        let mut dirty = false;
        if blocked {
            if !pb.access_profile.direct_http_blocked || pb.access_profile.direct_http_status != status {
                pb.access_profile.direct_http_blocked = true;
                pb.access_profile.direct_http_status = status;
                pb.access_profile
                    .field_provenance
                    .insert("directHttpBlocked".into(), FieldProvenance::Learned);
                dirty = true;
            }
            let label = status
                .map(|c| format!("HTTP {c}"))
                .unwrap_or_else(|| "connection/WAF block".to_string());
            dirty |= append_pitfall_in_memory(
                pb,
                "http_blocked",
                "request.fetch",
                &key,
                &format!("Direct anonymous HTTP returned {label}; prefer browser-session page.fetch."),
            );
        } else if succeeded && pb.access_profile.direct_http_blocked {
            pb.access_profile.direct_http_blocked = false;
            pb.access_profile.direct_http_status = None;
            pb.access_profile
                .field_provenance
                .insert("directHttpBlocked".into(), FieldProvenance::Learned);
            dirty = true;
        }
        if dirty {
            pb.updated_at_epoch_s = now_epoch_s();
            if should_persist_domain(&key) {
                return Some(pb.clone());
            }
        }
        None
    }

    /// Attaches `_siteProfile` hints to outgoing browser commands when learned optimizations exist.
    pub fn prepare_request(&mut self, session_id: &str, method: &str, params: &mut Value) -> PreparedCall {
        let from_routine = params
            .as_object_mut()
            .and_then(|obj| obj.remove("_fromRoutine"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let no_learn = params
            .as_object_mut()
            .and_then(|obj| obj.remove("_noLearn"))
            .and_then(|v| v.as_bool().or_else(|| v.as_str().map(|s| s == "true")))
            .unwrap_or(false);
        let profile_overridden = params
            .as_object()
            .is_some_and(|obj| obj.contains_key("_siteProfile"));
        let explicit_tab = params.get("tabId").and_then(Value::as_i64);
        let effective_tab = explicit_tab.or_else(|| self.session_tabs.get(session_id).copied());
        let explicit_wait_until = params
            .get("waitUntil")
            .and_then(Value::as_str)
            .is_some();
        let explicit_frames = params
            .get("frames")
            .and_then(Value::as_str)
            .is_some();
        let is_nav = matches!(method, "page.navigate" | "tabs.new");
        let is_idempotent_read = matches!(
            method,
            "page.navigate" | "tabs.new" | "page.snapshot" | "page.text" | "page.getText"
        );
        let full_page_read = match method {
            "page.navigate" | "tabs.new" => true,
            "page.snapshot" => {
                params
                    .get("root")
                    .and_then(Value::as_str)
                    .is_none_or(|s| s.trim().is_empty())
                    && params.get("viewportOnly").and_then(Value::as_bool) != Some(true)
            }
            "page.text" | "page.getText" => {
                params.get("ref").is_none() && params.get("locator").is_none()
            }
            _ => false,
        };
        let url_hint = if is_nav {
            params.get("url").and_then(Value::as_str).map(str::to_string)
        } else {
            effective_tab.and_then(|tid| self.tab_urls.get(&tid).cloned())
        };
        let target_summary = summarize_target(params);
        let sanitized_params = sanitize_recovery_params(params);
        let raw_action_params = sanitize_action_params_for_trajectory(params);

        let mut selected_route_key: Option<String> = None;
        let mut selected_arm_id: Option<String> = None;

        if matches!(method, "tabs.new") || method.starts_with("page.") {
            if let Some(hint) = url_hint.as_deref() {
                if let Some(key) = self.ensure_loaded(hint) {
                    let now_s = now_epoch_s();
                    let can_use_bandit = !no_learn
                        && !profile_overridden
                        && !explicit_wait_until
                        && !explicit_frames
                        && is_idempotent_read
                        && full_page_read
                        && self
                            .playbooks
                            .get(&key)
                            .is_some_and(|pb| !pb.access_profile.has_user_bandit_lock());

                    if can_use_bandit {
                        let r_key = normalize_route_template(hint);
                        if is_nav {
                            if let Some(pb) = self.playbooks.get_mut(&key) {
                                let base_arm = pb.access_profile.base_arm_id(now_s);
                                let base_tier = pb.access_profile.base_speed_tier(now_s);
                                let bandit = pb.access_profile.ensure_route_bandit_mut(&r_key, now_s);
                                let chosen = bandit.select_arm(&base_arm, base_tier);
                                selected_route_key = Some(r_key);
                                selected_arm_id = Some(chosen);
                            }
                        } else if let Some(active) = effective_tab
                            .and_then(|tid| self.last_nav_arm.get(&tid))
                            .filter(|a| a.domain_key == key && a.at.elapsed() <= Duration::from_secs(30))
                        {
                            selected_route_key = Some(active.route_key.clone());
                            selected_arm_id = Some(active.arm_id.clone());
                        } else if let Some(pb) = self.playbooks.get(&key) {
                            if let Some(bandit) = pb.access_profile.route_controllers.get(&r_key) {
                                let base_arm = pb.access_profile.base_arm_id(now_s);
                                selected_route_key = Some(r_key);
                                selected_arm_id = Some(bandit.peek_best_arm(&base_arm));
                            }
                        }
                    }

                    if !profile_overridden {
                        if let Some(wire) = self.playbooks.get(&key).and_then(|pb| {
                            pb.access_profile
                                .runtime_wire_json_with_arm(now_s, selected_arm_id.as_deref())
                        }) {
                            if let Some(obj) = params.as_object_mut() {
                                obj.entry("_siteProfile").or_insert(wire);
                            }
                        }
                    }
                }
            }
        }

        PreparedCall {
            session_id: session_id.to_string(),
            method: method.to_string(),
            tab_id: effective_tab,
            url_hint,
            target_summary,
            sanitized_params,
            raw_action_params,
            from_routine,
            no_learn,
            profile_overridden,
            explicit_wait_until,
            explicit_frames,
            selected_route_key,
            selected_arm_id,
            full_page_read,
            started_at: Instant::now(),
        }
    }

    /// Consumes extension responses, strips internal `_telemetry`, updates learned `SiteAccessProfile` & recovery rules,
    /// and returns a playbook snapshot whenever disk persistence is warranted.
    pub fn observe_response(
        &mut self,
        call: &PreparedCall,
        ok: bool,
        mut result: Option<&mut Value>,
        error: Option<&Value>,
    ) -> Option<SitePlaybook> {
        let duration_ms = call.started_at.elapsed().as_millis() as u64;
        let mut telemetry = result
            .as_deref_mut()
            .and_then(Value::as_object_mut)
            .and_then(|obj| obj.remove("_telemetry"))
            .unwrap_or(Value::Null);
        if telemetry.is_null() {
            if let Some(err_tel) = error.and_then(|e| e.get("_telemetry")).cloned() {
                telemetry = err_tel;
            }
        }

        // Update tab -> URL inventory from successful responses
        let mut resolved_tab = call.tab_id;
        let pre_call_tab_url = call.tab_id.and_then(|tid| self.tab_urls.get(&tid).cloned());
        let mut resolved_url = call.url_hint.clone();
        if let Some(res) = result.as_deref() {
            if let Some(tabs) = res.get("tabs").and_then(Value::as_array) {
                for t in tabs {
                    if let (Some(tid), Some(u)) = (
                        t.get("tabId").and_then(Value::as_i64),
                        t.get("url").and_then(Value::as_str).filter(|s| !s.is_empty()),
                    ) {
                        self.tab_urls.insert(tid, u.to_string());
                        if t.get("current").and_then(Value::as_bool) == Some(true) {
                            self.session_tabs.insert(call.session_id.clone(), tid);
                        }
                    }
                }
            }
            if let Some(closed_id) = res.get("closed").and_then(Value::as_i64) {
                if !call.no_learn {
                    if let Some(dom) = self.commit_trajectory_if_qualified(closed_id, MIN_FLUSH_ROUTINE_STEPS) {
                        self.queue_persist_for_domain(&dom);
                    }
                } else {
                    self.trajectories.remove(&closed_id);
                }
                self.tab_urls.remove(&closed_id);
                self.last_nav_at.remove(&closed_id);
                self.last_action_at.remove(&closed_id);
                self.last_nav_arm.remove(&closed_id);
                self.pending_recovery.remove(&closed_id);
            }
            if let Some(tid) = res.get("tabId").and_then(Value::as_i64) {
                resolved_tab = Some(tid);
                self.session_tabs.insert(call.session_id.clone(), tid);
            }
            if let Some(u) = res.get("url").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                if call.method != "page.fetch" {
                    resolved_url = Some(u.to_string());
                    if let Some(tid) = resolved_tab {
                        self.tab_urls.insert(tid, u.to_string());
                    }
                }
            } else if let Some(snap_u) = res
                .get("text")
                .and_then(Value::as_str)
                .and_then(extract_snapshot_header_url)
            {
                resolved_url = Some(snap_u.to_string());
                if let Some(tid) = resolved_tab {
                    self.tab_urls.insert(tid, snap_u.to_string());
                }
            }
        }

        if call.no_learn {
            return None;
        }

        if resolved_url.is_none() {
            if let Some(tid) = resolved_tab {
                resolved_url = self.tab_urls.get(&tid).cloned();
            }
        }
        if resolved_url.is_none() && call.method == "tabs.close" {
            if let Some(pb) = self.extra_persists.pop() {
                return Some(pb);
            }
        }

        if call.profile_overridden {
            return None;
        }

        // Cross-origin page.fetch CORS learning targets the fetched URL's domain when different from tab domain.
        if !ok && call.method == "page.fetch" {
            let err_code = error.and_then(|e| e.get("code")).and_then(Value::as_str).unwrap_or("");
            if err_code == "request_failed" {
                let target_dom = canonical_site_key(&call.target_summary);
                let tab_dom = resolved_url.as_deref().and_then(canonical_site_key);
                if let (Some(f_dom), Some(t_dom)) = (target_dom, tab_dom) {
                    if f_dom != t_dom {
                        if let Some(fkey) = self.ensure_loaded(&f_dom) {
                            if let Some(fpb) = self.playbooks.get_mut(&fkey) {
                                if !fpb.access_profile.requires_same_origin_fetch
                                    && !fpb.access_profile.is_user_locked("requiresSameOriginFetch")
                                {
                                    fpb.access_profile.requires_same_origin_fetch = true;
                                    fpb.access_profile
                                        .field_provenance
                                        .insert("requiresSameOriginFetch".into(), FieldProvenance::Learned);
                                    let _ = append_pitfall_in_memory(
                                        fpb,
                                        "cors_blocked",
                                        "page.fetch",
                                        &f_dom,
                                        &format!("Cross-origin page.fetch from {t_dom} failed; navigate to {f_dom} first."),
                                    );
                                    fpb.updated_at_epoch_s = now_epoch_s();
                                    if should_persist_domain(&fkey) {
                                        return Some(fpb.clone());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        let Some(url_str) = resolved_url.as_deref() else {
            return None;
        };
        let Some(key) = self.ensure_loaded(url_str) else {
            return None;
        };

        let now_s = now_epoch_s();
        let recent_nav = resolved_tab
            .and_then(|tid| self.last_nav_at.get(&tid))
            .is_some_and(|(t, d)| d == &key && t.elapsed() <= Duration::from_secs(4));
        let recent_action = resolved_tab
            .and_then(|tid| self.last_action_at.get(&tid))
            .is_some_and(|(t, d)| d == &key && t.elapsed() <= Duration::from_secs(3));

        let has_challenge = result
            .as_deref()
            .and_then(|r| r.get("challenge"))
            .is_some();
        let observed_content_chars: Option<u64> = telemetry
            .get("contentChars")
            .and_then(Value::as_u64)
            .or_else(|| {
                if ok
                    && !has_challenge
                    && call.full_page_read
                    && matches!(call.method.as_str(), "page.snapshot" | "page.text" | "page.getText")
                {
                    result
                        .as_deref()
                        .and_then(|r| r.get("text"))
                        .and_then(Value::as_str)
                        .map(|txt| extract_body_char_count(&call.method, txt))
                } else {
                    None
                }
            });

        let mut dirty = false;

        // RouteBandit statistical observation & quality-floor check
        if matches!(call.method.as_str(), "page.navigate" | "tabs.new") {
            if let (Some(r_key), Some(arm_id)) = (&call.selected_route_key, &call.selected_arm_id) {
                if let Some(pb) = self.playbooks.get_mut(&key) {
                    let base_arm = pb.access_profile.base_arm_id(now_s);
                    let clean_chars = if ok && !has_challenge {
                        observed_content_chars
                    } else {
                        None
                    };
                    let bandit = pb.access_profile.ensure_route_bandit_mut(r_key, now_s);
                    bandit.record_navigation(arm_id, duration_ms, ok, clean_chars, &base_arm);
                    dirty = true;
                }
                if let Some(tid) = resolved_tab {
                    if ok {
                        self.last_nav_arm.insert(
                            tid,
                            ActiveNavArm {
                                domain_key: key.clone(),
                                route_key: r_key.clone(),
                                arm_id: arm_id.clone(),
                                content_evaluated: observed_content_chars.is_some_and(|c| c > 0),
                                at: Instant::now(),
                            },
                        );
                    } else {
                        self.last_nav_arm.remove(&tid);
                    }
                }
            } else if let Some(tid) = resolved_tab {
                // Explicit waitUntil navigation invalidates previous arm attribution on this tab
                self.last_nav_arm.remove(&tid);
            }
        } else if ok
            && !has_challenge
            && call.full_page_read
            && matches!(call.method.as_str(), "page.snapshot" | "page.text" | "page.getText")
        {
            let is_truncated_read = telemetry
                .get("truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || result
                    .as_deref()
                    .and_then(|r| r.get("truncated"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            if let Some(chars) = observed_content_chars.filter(|c| *c > 0) {
                let mut target_arm: Option<(String, String)> = None;
                if let Some(active) = resolved_tab
                    .and_then(|tid| self.last_nav_arm.get_mut(&tid))
                    .filter(|a| a.domain_key == key && a.at.elapsed() <= Duration::from_secs(30))
                {
                    if !active.content_evaluated {
                        active.content_evaluated = true;
                        target_arm = Some((active.route_key.clone(), active.arm_id.clone()));
                    }
                }
                if let Some((rk, aid)) = target_arm {
                    if let Some(pb) = self.playbooks.get_mut(&key) {
                        let base_arm = pb.access_profile.base_arm_id(now_s);
                        let bandit = pb.access_profile.ensure_route_bandit_mut(&rk, now_s);
                        if !(is_truncated_read && bandit.is_quality_violation(chars)) {
                            let _ = bandit.observe_content_quality(&aid, chars, &base_arm);
                            dirty = true;
                        }
                    }
                }
            }
        }

        if ok {
            let res_ref = result.as_deref();
            {
                let pb = self.playbooks.get_mut(&key)?;
                let mut learned_pitfall: Option<(&'static str, String)> = None;
                {
                    let prof = &mut pb.access_profile;

                    if matches!(call.method.as_str(), "page.navigate" | "tabs.new") {
                        prof.stats.navigations += 1;
                        prof.stats.avg_nav_ms = update_ema(prof.stats.avg_nav_ms, duration_ms);

                        let loaded = res_ref.and_then(|r| r.get("loaded")).and_then(Value::as_bool).unwrap_or(true);
                        let dom_loaded = telemetry.get("domLoaded").and_then(Value::as_bool).unwrap_or(loaded);
                        let load_timed_out = telemetry.get("loadTimedOut").and_then(Value::as_bool).unwrap_or(!loaded && dom_loaded);
                        let dom_ms = telemetry.get("domLoadedMs").and_then(Value::as_u64);
                        let load_ms = telemetry.get("loadMs").and_then(Value::as_u64);
                        let sw_no_headers = telemetry.get("swNoHeaders").and_then(Value::as_bool).unwrap_or(false);
                        let settled_ms = telemetry.get("settledMs").and_then(Value::as_u64);

                        if sw_no_headers
                            && !call.explicit_wait_until
                            && !prof.effective_service_worker_navigation(now_s)
                            && !prof.is_user_locked("serviceWorkerNavigation")
                        {
                            prof.service_worker_navigation = true;
                            prof.sw_nav_learned_at = now_s;
                            prof.field_provenance
                                .insert("serviceWorkerNavigation".into(), FieldProvenance::Learned);
                            dirty = true;
                        }

                        if !call.explicit_wait_until {
                            let mut saw_slow_load = false;
                            let mut timed_out_load = false;
                            if load_timed_out && dom_loaded {
                                prof.stats.load_timeouts += 1;
                                saw_slow_load = true;
                                timed_out_load = true;
                            } else if let (Some(d_ms), Some(l_ms)) = (dom_ms, load_ms) {
                                if l_ms.saturating_sub(d_ms) >= 4_000 {
                                    prof.stats.slow_load_tails += 1;
                                    saw_slow_load = true;
                                }
                            }

                            if saw_slow_load
                                && prof.stats.load_timeouts + prof.stats.slow_load_tails >= MIN_POLICY_SWITCH_SAMPLES
                                && !prof.is_user_locked("preferredWaitUntil")
                            {
                                let cur_wait = WaitLevel::from_opt_str(prof.effective_preferred_wait_until(now_s));
                                if cur_wait > WaitLevel::DomContentLoaded {
                                    prof.preferred_wait_until = Some(WaitLevel::DomContentLoaded.as_str().to_string());
                                    prof.wait_until_learned_at = now_s;
                                    prof.field_provenance
                                        .insert("preferredWaitUntil".into(), FieldProvenance::Learned);
                                    if timed_out_load {
                                        learned_pitfall = Some((
                                            "load_timeout",
                                            "window.onload stalled after DOMContentLoaded (>=3x); auto-switched default waitUntil to domcontentloaded.".to_string(),
                                        ));
                                    }
                                    dirty = true;
                                }
                            }

                            // Clean-navigation settle decay (every 5 clean navigations, step down by 50ms)
                            if !load_timed_out && !has_challenge {
                                let should_count_clean = match settled_ms {
                                    Some(s_ms) => {
                                        prof.hydration_settle_ms == 0
                                            || s_ms.saturating_add(50) < prof.hydration_settle_ms
                                    }
                                    None => true,
                                };
                                if should_count_clean {
                                    prof.clean_nav_streak = prof.clean_nav_streak.saturating_add(1);
                                    if prof.clean_nav_streak >= CLEAN_NAV_DECAY_STREAK {
                                        prof.clean_nav_streak = 0;
                                        if !prof.is_user_locked("hydrationSettleMs") && prof.hydration_settle_ms > 0 {
                                            let floor = match settled_ms {
                                                Some(0) | None => 0,
                                                Some(s_ms) => s_ms.saturating_add(50),
                                            };
                                            let decayed = prof.hydration_settle_ms.saturating_sub(50).max(floor);
                                            if decayed != prof.hydration_settle_ms {
                                                prof.hydration_settle_ms = decayed;
                                                prof.settle_learned_at = now_s;
                                                prof.field_provenance
                                                    .insert("hydrationSettleMs".into(), FieldProvenance::Learned);
                                                dirty = true;
                                            }
                                        }
                                    }
                                } else {
                                    prof.clean_nav_streak = 0;
                                }
                            }
                        }
                    } else if call.method == "page.snapshot" {
                        prof.stats.snapshots += 1;
                        prof.stats.avg_snapshot_ms = update_ema(prof.stats.avg_snapshot_ms, duration_ms);
                        if !call.explicit_frames {
                            let vis_iframes = telemetry.get("visibleIframes").and_then(Value::as_u64).unwrap_or(0);
                            let child_scanned = telemetry.get("childFramesScanned").and_then(Value::as_u64).unwrap_or(0);
                            let non_empty_child = telemetry.get("nonEmptyChildFrames").and_then(Value::as_u64).unwrap_or(0);

                            if non_empty_child > 0 {
                                prof.stats.empty_multiframe_snapshots = 0;
                                if prof.preferred_snapshot_frames.is_some()
                                    && !prof.is_user_locked("preferredSnapshotFrames")
                                    && prof.field_provenance.get("preferredSnapshotFrames") != Some(&FieldProvenance::Seed)
                                {
                                    prof.preferred_snapshot_frames = None;
                                    prof.field_provenance
                                        .insert("preferredSnapshotFrames".into(), FieldProvenance::Learned);
                                    dirty = true;
                                }
                            } else if vis_iframes > 0 && child_scanned > 0 && non_empty_child == 0 {
                                prof.stats.empty_multiframe_snapshots += 1;
                                if prof.stats.empty_multiframe_snapshots >= MIN_POLICY_SWITCH_SAMPLES
                                    && prof.preferred_snapshot_frames.as_deref() != Some("top")
                                    && !prof.is_user_locked("preferredSnapshotFrames")
                                {
                                    prof.preferred_snapshot_frames = Some("top".to_string());
                                    prof.field_provenance
                                        .insert("preferredSnapshotFrames".into(), FieldProvenance::Learned);
                                    dirty = true;
                                }
                            }
                        }
                    } else if matches!(
                        call.method.as_str(),
                        "page.click" | "page.type" | "page.press" | "page.hover" | "page.drag" | "page.select" | "page.check"
                    ) {
                        if telemetry.get("cdpFallback").and_then(Value::as_bool) == Some(true) {
                            prof.stats.cdp_fallbacks += 1;
                            if prof.preferred_input.as_deref() != Some("dom")
                                && !prof.is_user_locked("preferredInput")
                            {
                                prof.preferred_input = Some("dom".to_string());
                                prof.preferred_input_learned_at = now_s;
                                prof.field_provenance
                                    .insert("preferredInput".into(), FieldProvenance::Learned);
                                learned_pitfall = Some((
                                    "cdp_fallback",
                                    "CDP debugger input failed; auto-switched site input profile to direct DOM events.".to_string(),
                                ));
                                dirty = true;
                            }
                        }
                        if let Some(navigated) = res_ref.and_then(|r| r.get("navigated")).and_then(Value::as_bool) {
                            if navigated {
                                prof.stats.navigating_actions += 1;
                                if prof.submit_settle_ms == Some(80) && !prof.is_user_locked("submitSettleMs") {
                                    prof.submit_settle_ms = None;
                                    prof.field_provenance
                                        .insert("submitSettleMs".into(), FieldProvenance::Learned);
                                    dirty = true;
                                }
                            } else {
                                prof.stats.in_page_actions += 1;
                                if prof.stats.in_page_actions >= 3
                                    && prof.stats.navigating_actions == 0
                                    && prof.stats.not_ready_errors == 0
                                    && prof.submit_settle_ms.is_none()
                                    && !prof.is_user_locked("submitSettleMs")
                                {
                                    prof.submit_settle_ms = Some(80);
                                    prof.field_provenance
                                        .insert("submitSettleMs".into(), FieldProvenance::Learned);
                                    dirty = true;
                                }
                            }
                        }
                    }
                }
                if let Some((p_code, p_msg)) = learned_pitfall {
                    let _ = append_pitfall_in_memory(pb, p_code, &call.method, &call.target_summary, &p_msg);
                }

                if duration_ms >= 5_000
                    && call.method != "page.waitFor"
                    && !call.explicit_wait_until
                    && !call.explicit_frames
                {
                    dirty |= append_pitfall_in_memory(
                        pb,
                        "slow_operation",
                        &call.method,
                        &call.target_summary,
                        &format!("{} took {duration_ms} ms on {}.", call.method, call.target_summary),
                    );
                }
            }

            if let Some(tid) = resolved_tab {
                if matches!(call.method.as_str(), "page.navigate" | "tabs.new") && !call.explicit_wait_until {
                    self.last_nav_at.insert(tid, (Instant::now(), key.clone()));
                } else if is_mutating_recovery_action(&call.method) {
                    self.last_action_at.insert(tid, (Instant::now(), key.clone()));
                }

                // Error -> Recovery Action -> Retry Success triad learning
                if is_mutating_recovery_action(&call.method) {
                    let mut promoted: Option<LearnedRecoveryRule> = None;
                    let mut clear_pending = false;
                    if let Some(pending) = self.pending_recovery.get_mut(&tid) {
                        let same_retry = call.method == pending.failed_method
                            && (call.target_summary == pending.failed_target
                                || (call.target_summary.starts_with("ref=")
                                    && pending.failed_target.starts_with("ref=")));
                        if same_retry {
                            if let Some((rec_method, rec_target, rec_params)) = pending.candidate_recovery.clone() {
                                promoted = Some(LearnedRecoveryRule {
                                    trigger_code: pending.error_code.clone(),
                                    trigger_method: pending.failed_method.clone(),
                                    blocker: pending.blocker.clone(),
                                    recovery_method: rec_method,
                                    recovery_target: rec_target,
                                    recovery_params: rec_params,
                                    success_count: 1,
                                    last_verified_epoch_s: now_s,
                                });
                            }
                            clear_pending = true;
                        } else if pending.candidate_recovery.is_none() {
                            pending.candidate_recovery = Some((
                                call.method.clone(),
                                call.target_summary.clone(),
                                call.sanitized_params.clone(),
                            ));
                        }
                    }
                    if clear_pending {
                        self.pending_recovery.remove(&tid);
                    }
                    if let Some(rule) = promoted {
                        if let Some(pb) = self.playbooks.get_mut(&key) {
                            let list = &mut pb.access_profile.learned_recoveries;
                            if let Some(ex) = list.iter_mut().find(|x| {
                                x.trigger_code == rule.trigger_code
                                    && x.blocker == rule.blocker
                                    && x.recovery_method == rule.recovery_method
                                    && x.recovery_target == rule.recovery_target
                            }) {
                                ex.success_count += 1;
                                ex.last_verified_epoch_s = rule.last_verified_epoch_s;
                            } else {
                                if list.len() >= MAX_RECOVERIES_PER_SITE {
                                    list.remove(0);
                                }
                                list.push(rule);
                            }
                            dirty = true;
                        }
                    }
                }

                // Auto-Routine Trajectory Distillation (0.11.0): record clean action steps and crystallize completed multi-step workflows.
                if !call.from_routine {
                    if matches!(call.method.as_str(), "page.navigate" | "tabs.new") {
                        if let Some(committed_dom) = self.commit_trajectory_if_qualified(tid, MIN_FLUSH_ROUTINE_STEPS) {
                            if committed_dom == key {
                                dirty = true;
                            } else {
                                self.queue_persist_for_domain(&committed_dom);
                            }
                        }
                        self.trajectories.insert(
                            tid,
                            TabTrajectory {
                                session_id: call.session_id.clone(),
                                domain: key.clone(),
                                entry_url: url_str.to_string(),
                                steps: Vec::new(),
                                failed_detours: 0,
                                has_unpromoted_ref: false,
                                last_step_at: Instant::now(),
                            },
                        );
                    } else if is_synthesizable_action(&call.method) {
                        let effective_entry = pre_call_tab_url.as_deref().unwrap_or(url_str);
                        let effective_dom = canonical_site_key(effective_entry).unwrap_or_else(|| key.clone());
                        let _ = self.ensure_loaded(&effective_dom);
                        self.record_trajectory_action(
                            tid,
                            &call.session_id,
                            &effective_dom,
                            effective_entry,
                            call,
                            &telemetry,
                        );
                        let action_navigated = res_ref
                            .and_then(|r| r.get("navigated"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        if action_navigated {
                            if let Some(committed_dom) = self.commit_trajectory_if_qualified(tid, MIN_SUBMIT_ROUTINE_STEPS) {
                                if committed_dom == key {
                                    dirty = true;
                                } else {
                                    self.queue_persist_for_domain(&committed_dom);
                                }
                            }
                            self.trajectories.insert(
                                tid,
                                TabTrajectory {
                                    session_id: call.session_id.clone(),
                                    domain: key.clone(),
                                    entry_url: url_str.to_string(),
                                    steps: Vec::new(),
                                    failed_detours: 0,
                                    has_unpromoted_ref: false,
                                    last_step_at: Instant::now(),
                                },
                            );
                        }
                    }
                }
            }
        } else {
            let code = error
                .and_then(|e| e.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("internal_error");
            let message = error
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("");

            {
                let pb = self.playbooks.get_mut(&key)?;
                dirty |= append_pitfall_in_memory(pb, code, &call.method, &call.target_summary, message);
                let prof = &mut pb.access_profile;

                match code {
                    "timeout" => {
                        let dom_loaded = telemetry.get("domLoaded").and_then(Value::as_bool).unwrap_or(false);
                        if matches!(call.method.as_str(), "page.navigate" | "tabs.new") && dom_loaded {
                            if !call.explicit_wait_until {
                                prof.stats.load_timeouts += 1;
                                if prof.stats.load_timeouts + prof.stats.slow_load_tails >= MIN_POLICY_SWITCH_SAMPLES
                                    && !prof.is_user_locked("preferredWaitUntil")
                                {
                                    let cur_wait = WaitLevel::from_opt_str(prof.effective_preferred_wait_until(now_s));
                                    if cur_wait > WaitLevel::DomContentLoaded {
                                        prof.preferred_wait_until = Some(WaitLevel::DomContentLoaded.as_str().to_string());
                                        prof.wait_until_learned_at = now_s;
                                        prof.field_provenance
                                            .insert("preferredWaitUntil".into(), FieldProvenance::Learned);
                                        dirty = true;
                                    }
                                }
                            }
                        } else if recent_nav && call.method != "page.waitFor" && !call.explicit_wait_until {
                            prof.clean_nav_streak = 0;
                            prof.stats.hydration_stalls += 1;
                            if prof.stats.hydration_stalls >= MIN_POLICY_SWITCH_SAMPLES
                                && !prof.is_user_locked("hydrationSettleMs")
                            {
                                prof.stats.hydration_stalls = 0;
                                let cur_settle = prof.effective_hydration_settle_ms(now_s);
                                let next_settle = (cur_settle + 200).clamp(200, 600);
                                if next_settle != prof.hydration_settle_ms
                                    || prof.is_learned_expired("hydrationSettleMs", prof.settle_learned_at, now_s)
                                {
                                    prof.hydration_settle_ms = next_settle;
                                    prof.settle_learned_at = now_s;
                                    prof.field_provenance
                                        .insert("hydrationSettleMs".into(), FieldProvenance::Learned);
                                    dirty = true;
                                }
                            }
                        }
                    }
                    "stale_ref" => {
                        // Agent passing an outdated ref is caller error, not page hydration delay:
                        // never bump hydration_settle_ms on stale_ref; flag dynamic_dom after >= 3 occurrences.
                        prof.stats.stale_ref_errors += 1;
                        if !prof.dynamic_dom
                            && prof.stats.stale_ref_errors >= MIN_POLICY_SWITCH_SAMPLES
                            && !prof.is_user_locked("dynamicDom")
                        {
                            prof.dynamic_dom = true;
                            prof.field_provenance
                                .insert("dynamicDom".into(), FieldProvenance::Learned);
                            dirty = true;
                        }
                    }
                    "not_ready" => {
                        prof.stats.not_ready_errors += 1;
                        if recent_action {
                            if prof.action_settle_ms != Some(240) && !prof.is_user_locked("actionSettleMs") {
                                prof.action_settle_ms = Some(240);
                                prof.field_provenance
                                    .insert("actionSettleMs".into(), FieldProvenance::Learned);
                                if !prof.is_user_locked("submitSettleMs") {
                                    prof.submit_settle_ms = Some(1200);
                                    prof.field_provenance
                                        .insert("submitSettleMs".into(), FieldProvenance::Learned);
                                }
                                dirty = true;
                            }
                        } else if recent_nav {
                            prof.clean_nav_streak = 0;
                            prof.stats.hydration_stalls += 1;
                            if prof.stats.hydration_stalls >= MIN_POLICY_SWITCH_SAMPLES
                                && !prof.is_user_locked("hydrationSettleMs")
                            {
                                prof.stats.hydration_stalls = 0;
                                let cur_settle = prof.effective_hydration_settle_ms(now_s);
                                let next_settle = (cur_settle + 250).clamp(250, 600);
                                if next_settle != prof.hydration_settle_ms
                                    || prof.is_learned_expired("hydrationSettleMs", prof.settle_learned_at, now_s)
                                {
                                    prof.hydration_settle_ms = next_settle;
                                    prof.settle_learned_at = now_s;
                                    prof.field_provenance
                                        .insert("hydrationSettleMs".into(), FieldProvenance::Learned);
                                    dirty = true;
                                }
                            }
                        }
                    }
                    "not_actionable" => {
                        prof.stats.not_actionable_errors += 1;
                        if let Some(blocker) = extract_blocker_tag(message) {
                            if !prof.known_blockers.contains(&blocker) {
                                if prof.known_blockers.len() >= MAX_BLOCKERS_PER_SITE {
                                    prof.known_blockers.remove(0);
                                }
                                prof.known_blockers.push(blocker);
                                dirty = true;
                            }
                        }
                    }
                    _ => {}
                }
            }

            if let Some(tid) = resolved_tab {
                if !call.from_routine && is_synthesizable_action(&call.method) {
                    if let Some(traj) = self.trajectories.get_mut(&tid) {
                        traj.failed_detours = traj.failed_detours.saturating_add(1);
                    }
                }
                if matches!(code, "not_actionable" | "timeout" | "check_failed") && is_mutating_recovery_action(&call.method) {
                    let blocker = extract_blocker_tag(message).unwrap_or_default();
                    self.pending_recovery.insert(
                        tid,
                        PendingRecovery {
                            failed_method: call.method.clone(),
                            failed_target: call.target_summary.clone(),
                            error_code: code.to_string(),
                            blocker,
                            candidate_recovery: None,
                        },
                    );
                }
            }
        }

        if dirty {
            if let Some(pb) = self.playbooks.get_mut(&key) {
                pb.updated_at_epoch_s = now_s;
                pb.updated_at = epoch_to_iso8601(now_s);
                if should_persist_domain(&key) {
                    return Some(pb.clone());
                }
            }
        }
        None
    }
}

fn extract_body_char_count(method: &str, text: &str) -> u64 {
    if method == "page.snapshot" {
        let mut lines = text.lines().peekable();
        if lines.peek().is_some_and(|l| l.starts_with("Tab ")) {
            lines.next();
        }
        if lines.peek().is_some_and(|l| l.starts_with("URL: ")) {
            lines.next();
        }
        let body: String = lines
            .filter(|l| {
                !l.starts_with("[Snapshot truncated.")
                    && !l.starts_with("[Bot Challenge Detected")
                    && !l.starts_with("[Site Memory & Fast Routines")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let trimmed = body.trim();
        if trimmed.is_empty() || trimmed == "(no visible content)" {
            0
        } else {
            trimmed.len() as u64
        }
    } else {
        text.trim().len() as u64
    }
}

pub fn summarize_target(params: &Value) -> String {
    if let Some(r) = params.get("ref").and_then(Value::as_str) {
        return format!("ref={r}");
    }
    if let Some(loc) = params.get("locator") {
        let s = loc.to_string();
        return s.chars().take(100).collect();
    }
    if let Some(u) = params.get("url").and_then(Value::as_str) {
        return u.split('?').next().unwrap_or(u).chars().take(80).collect();
    }
    String::new()
}

pub fn canonical_step_method(op: &str) -> Result<&'static str, String> {
    match op.trim() {
        "click" | "page.click" => Ok("page.click"),
        "doubleClick" | "dblclick" => Ok("page.click"),
        "drag" | "page.drag" => Ok("page.drag"),
        "hover" | "page.hover" => Ok("page.hover"),
        "type" | "page.type" => Ok("page.type"),
        "fill" | "page.fill" => Ok("page.fill"),
        "select" | "page.select" => Ok("page.select"),
        "check" | "page.check" => Ok("page.check"),
        "press" | "page.press" => Ok("page.press"),
        "scroll" | "page.scroll" => Ok("page.scroll"),
        "waitFor" | "wait_for" | "page.waitFor" => Ok("page.waitFor"),
        "locate" | "page.locate" => Ok("page.locate"),
        "query" | "get_element" | "page.query" => Ok("page.query"),
        "queryAll" | "page.queryAll" => Ok("page.queryAll"),
        "snapshot" | "page.snapshot" => Ok("page.snapshot"),
        "text" | "get_text" | "page.text" => Ok("page.text"),
        "screenshot" | "page.screenshot" => Ok("page.screenshot"),
        "fetch" | "page.fetch" => Ok("page.fetch"),
        "navigate" | "goto" | "page.navigate" => Ok("page.navigate"),
        "history" | "page.history" => Ok("page.history"),
        "webmcp.list" | "page.webmcp.list" => Ok("page.webmcp.list"),
        "webmcp.call" | "page.webmcp.call" => Ok("page.webmcp.call"),
        "dialog" | "page.dialog" => Ok("page.dialog"),
        other => Err(format!("Unsupported routine step op '{other}'.")),
    }
}

pub fn is_read_safe_step(method: &str) -> bool {
    matches!(
        method,
        "page.snapshot"
            | "page.text"
            | "page.locate"
            | "page.query"
            | "page.queryAll"
            | "page.waitFor"
            | "page.screenshot"
            | "page.fetch"
            | "page.webmcp.list"
    )
}

pub fn extract_url_template_vars(raw_url: &str) -> Map<String, Value> {
    let mut out = Map::new();
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        out.insert("url.gid".into(), json!("0"));
        return out;
    }
    out.insert("url.href".into(), json!(trimmed));
    let (scheme, rest) = trimmed.split_once("://").unwrap_or(("https", trimmed));
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if !authority.is_empty() {
        out.insert("url.origin".into(), json!(format!("{scheme}://{authority}")));
    }
    let before_hash = rest.split('#').next().unwrap_or(rest);
    let hash_part = rest.split_once('#').map(|(_, h)| h).unwrap_or("");
    let (path_with_host, query_part) = before_hash.split_once('?').unwrap_or((before_hash, ""));
    let clean_path_url = format!("{scheme}://{}", path_with_host.trim_end_matches('/'));
    out.insert("url.cleanPath".into(), json!(clean_path_url));
    let path_only = path_with_host
        .split_once('/')
        .map(|(_, p)| p)
        .unwrap_or("");
    let segs: Vec<&str> = path_only.split('/').filter(|s| !s.is_empty()).collect();

    if let Some(d_pos) = segs.iter().position(|s| *s == "d") {
        if let Some(doc_id) = segs.get(d_pos + 1) {
            out.insert("url.docId".into(), json!(*doc_id));
        }
    }
    if authority.to_ascii_lowercase().ends_with("arxiv.org") && segs.len() >= 2 && matches!(segs[0], "abs" | "pdf" | "html") {
        let arxiv_id = segs[1..].join("/").trim_end_matches(".pdf").to_string();
        out.insert("url.arxivId".into(), json!(arxiv_id));
    }
    if authority.eq_ignore_ascii_case("github.com") && segs.len() >= 2 {
        out.insert("url.repo".into(), json!(format!("{}/{}", segs[0], segs[1])));
    }

    let mut gid = "0".to_string();
    for src in [query_part, hash_part] {
        for pair in src.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == "gid" && !v.is_empty() {
                    gid = v.to_string();
                }
            }
        }
    }
    out.insert("url.gid".into(), json!(gid));
    out
}

pub fn strip_html_to_text(html: &str) -> String {
    let mut cleaned = String::with_capacity(html.len() / 2);
    let bytes = html.as_bytes();
    let lower = html.to_ascii_lowercase();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            if lower[i..].starts_with("<script") {
                if let Some(end) = lower[i..].find("</script>") {
                    i += end + "</script>".len();
                    continue;
                }
            } else if lower[i..].starts_with("<style") {
                if let Some(end) = lower[i..].find("</style>") {
                    i += end + "</style>".len();
                    continue;
                }
            } else if lower[i..].starts_with("<head") {
                if let Some(end) = lower[i..].find("</head>") {
                    i += end + "</head>".len();
                    continue;
                }
            }
            if let Some(close) = html[i..].find('>') {
                let tag = lower[i + 1..i + close].trim_start_matches('/').split_whitespace().next().unwrap_or("");
                if matches!(tag, "p" | "div" | "br" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "table") {
                    cleaned.push('\n');
                } else if matches!(tag, "td" | "th") {
                    cleaned.push('\t');
                }
                i += close + 1;
                continue;
            }
        }
        let ch = html[i..].chars().next().unwrap_or(' ');
        cleaned.push(ch);
        i += ch.len_utf8();
    }
    let decoded = cleaned
        .replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    let mut lines = Vec::new();
    let mut prev_empty = true;
    for raw_line in decoded.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            if !prev_empty {
                lines.push(String::new());
                prev_empty = true;
            }
        } else {
            lines.push(line.to_string());
            prev_empty = false;
        }
    }
    lines.join("\n").trim().to_string()
}

fn percent_encode_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn interpolate_value(template: &Value, vars: &Map<String, Value>) -> Value {
    match template {
        Value::String(s) => {
            if let Some(inner) = s.strip_prefix("{{").and_then(|rest| rest.strip_suffix("}}")) {
                let key = inner.trim();
                if !key.contains('{') && !key.contains('}') && !key.contains(':') {
                    if let Some(exact) = vars.get(key) {
                        return exact.clone();
                    }
                }
            }
            let mut rendered = s.clone();
            for (k, v) in vars {
                let rep = match v {
                    Value::String(vs) => vs.clone(),
                    Value::Null => String::new(),
                    other => other.to_string(),
                };
                let enc_token = format!("{{{{{k}:urlencode}}}}");
                if rendered.contains(&enc_token) {
                    rendered = rendered.replace(&enc_token, &percent_encode_component(&rep));
                }
                let token = format!("{{{{{k}}}}}");
                if rendered.contains(&token) {
                    rendered = rendered.replace(&token, &rep);
                }
            }
            Value::String(rendered)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(|item| interpolate_value(item, vars)).collect()),
        Value::Object(obj) => {
            let mut out = Map::new();
            for (k, v) in obj {
                out.insert(k.clone(), interpolate_value(v, vars));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn extract_css_attr_hint(selector: &str, attr_name: &str) -> Option<String> {
    let needle = format!("{attr_name}=");
    let idx = selector.find(&needle).or_else(|| {
        let star_needle = format!("{attr_name}*=");
        selector.find(&star_needle)
    })?;
    let after_eq = selector[idx..].split_once('=')?.1.trim_start();
    let quote = after_eq.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let rest = &after_eq[quote.len_utf8()..];
    let end = rest.find(quote)?;
    let val = rest[..end].trim();
    if val.is_empty() {
        None
    } else {
        Some(val.to_string())
    }
}

fn push_unique_locator(out: &mut Vec<Value>, original: Option<&Value>, cand: Value) {
    if original == Some(&cand) || out.contains(&cand) {
        return;
    }
    out.push(cand);
}

fn synthesize_semantic_relocation_locators(method: &str, step_params: &Value) -> Vec<Value> {
    let mut cands = Vec::new();
    let orig_loc = step_params.get("locator");

    if let Some(sem) = step_params.get("semanticLocator").filter(|v| v.is_object()) {
        push_unique_locator(&mut cands, orig_loc, sem.clone());
    }

    if let Some(steps) = orig_loc.and_then(|l| l.get("steps")).and_then(Value::as_array) {
        for s in steps {
            let kind = s.get("kind").and_then(Value::as_str).unwrap_or("");
            let val = s.get("value").and_then(Value::as_str).unwrap_or("").trim();
            let name = s.get("name").and_then(Value::as_str).unwrap_or("").trim();

            match kind {
                "role" if !val.is_empty() && !name.is_empty() => {
                    push_unique_locator(
                        &mut cands,
                        orig_loc,
                        json!({
                            "steps": [
                                { "kind": "role", "value": val, "name": name },
                                { "kind": "nth", "index": 0 }
                            ]
                        }),
                    );
                    if matches!(method, "page.click" | "page.query" | "page.locate" | "page.hover") {
                        push_unique_locator(
                            &mut cands,
                            orig_loc,
                            json!({
                                "steps": [
                                    { "kind": "text", "value": name },
                                    { "kind": "nth", "index": 0 }
                                ]
                            }),
                        );
                    }
                }
                "label" | "placeholder" | "title" | "text" if !val.is_empty() => {
                    push_unique_locator(
                        &mut cands,
                        orig_loc,
                        json!({
                            "steps": [
                                { "kind": kind, "value": val },
                                { "kind": "nth", "index": 0 }
                            ]
                        }),
                    );
                    if kind != "text" && matches!(method, "page.click" | "page.query") {
                        push_unique_locator(
                            &mut cands,
                            orig_loc,
                            json!({
                                "steps": [
                                    { "kind": "text", "value": val },
                                    { "kind": "nth", "index": 0 }
                                ]
                            }),
                        );
                    }
                }
                "css" if !val.is_empty() => {
                    if let Some(aria) = extract_css_attr_hint(val, "aria-label") {
                        push_unique_locator(
                            &mut cands,
                            orig_loc,
                            json!({
                                "steps": [
                                    { "kind": "text", "value": aria },
                                    { "kind": "nth", "index": 0 }
                                ]
                            }),
                        );
                    }
                    if let Some(ph) = extract_css_attr_hint(val, "placeholder") {
                        push_unique_locator(
                            &mut cands,
                            orig_loc,
                            json!({
                                "steps": [
                                    { "kind": "placeholder", "value": ph },
                                    { "kind": "nth", "index": 0 }
                                ]
                            }),
                        );
                    }
                }
                _ => {}
            }
        }
    }

    if method == "page.query" {
        let op = step_params
            .get("operation")
            .and_then(Value::as_str)
            .unwrap_or("inspect");
        if matches!(op, "innerText" | "textContent" | "inspect") {
            push_unique_locator(
                &mut cands,
                orig_loc,
                json!({
                    "steps": [
                        { "kind": "css", "value": "main, [role='main'], article, #search, #rso, #rcnt, #content, body" },
                        { "kind": "nth", "index": 0 }
                    ]
                }),
            );
        }
    }

    cands
}

fn looks_like_bot_boilerplate(text: &str, res: &Value) -> bool {
    if res.get("challenge").is_some() {
        return true;
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("unusual traffic from your computer network") {
        return true;
    }
    if lower.contains("about this page") && lower.contains("automatically detects requests") {
        return true;
    }
    if text.len() < 600
        && (lower.contains("verify you are human")
            || lower.contains("enable javascript and cookies to continue"))
    {
        return true;
    }
    false
}

fn verify_relocation_postcondition(method: &str, step_params: &Value, res: &Value) -> bool {
    if method == "page.query" {
        let op = step_params
            .get("operation")
            .and_then(Value::as_str)
            .unwrap_or("inspect");
        if matches!(op, "innerText" | "textContent" | "inspect") {
            let text = res
                .get("value")
                .and_then(Value::as_str)
                .or_else(|| res.get("text").and_then(Value::as_str))
                .unwrap_or("");
            if text.trim().chars().count() < 32 || looks_like_bot_boilerplate(text, res) {
                return false;
            }
        }
    }
    true
}

fn persist_repaired_routine_step_on_disk(
    url_or_domain: &str,
    routine_name: &str,
    step_idx: usize,
    repaired_locator: &Value,
) {
    let Some(site_key) = canonical_site_key(url_or_domain) else {
        return;
    };
    if !should_persist_domain(&site_key) {
        return;
    };
    let mut pb = resolve_playbook(&site_key).unwrap_or_else(|| SitePlaybook::new(site_key));
    let Some(r) = pb.routines.get_mut(routine_name) else {
        return;
    };
    let Some(step) = r.steps.get_mut(step_idx) else {
        return;
    };
    let had_template_var = step
        .params
        .get("locator")
        .is_some_and(|loc| loc.to_string().contains("{{"));
    if !had_template_var {
        if let Some(obj) = step.params.as_object_mut() {
            obj.insert("locator".into(), repaired_locator.clone());
        }
    }
    let ts = now_iso8601();
    r.updated_at = Some(ts.clone());
    r.last_succeeded_at = Some(ts);
    r.consecutive_failures = 0;
    r.stale = false;
    r.stale_reason = None;
    let _ = save_playbook(&pb);
}

/// Executes a named routine step-by-step directly over IPC in Rust (~1 ms dispatch overhead per step).
pub async fn execute_routine(
    client: &BridgeClient,
    routine: &RoutineDefinition,
    arguments: &Map<String, Value>,
    tab_id: Option<i64>,
    browser: Option<&str>,
    enforce_read_only: bool,
) -> Result<Value, String> {
    execute_routine_with_caller(
        routine,
        arguments,
        tab_id,
        enforce_read_only,
        |method, params| async move {
            let timeout = if method == "page.info" {
                Duration::from_secs(10)
            } else {
                Duration::from_secs(60)
            };
            client
                .send(&method, params, browser, timeout)
                .await
                .map(|(res, _)| res)
        },
    )
    .await
}

pub(crate) async fn execute_routine_with_caller<F, Fut>(
    routine: &RoutineDefinition,
    arguments: &Map<String, Value>,
    tab_id: Option<i64>,
    enforce_read_only: bool,
    mut caller: F,
) -> Result<Value, String>
where
    F: FnMut(String, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, BridgeError>>,
{
    if enforce_read_only && !routine.read_only {
        return Err(format!(
            "Routine '{}' modifies page state and cannot run in read-only mode. [read_only]",
            routine.name
        ));
    }

    let strict_mode = arguments
        .get("strict")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut vars = Map::new();
    let mut active_tab = tab_id;
    let mut observed_domain = String::new();

    // Pre-populate automatic {{url.*}} variables from the active tab when needed by defaults or step templates.
    let needs_url_vars = routine
        .params
        .values()
        .any(|p| p.default.as_ref().is_some_and(|d| d.to_string().contains("{{url.")))
        || routine
            .steps
            .iter()
            .any(|s| s.params.to_string().contains("{{url."));
    if needs_url_vars {
        let mut info_p = Map::new();
        if let Some(tid) = active_tab {
            info_p.insert("tabId".into(), json!(tid));
        }
        if let Ok(info) = caller("page.info".to_string(), Value::Object(info_p)).await {
            if active_tab.is_none() {
                active_tab = info.get("tabId").and_then(Value::as_i64);
            }
            if let Some(u) = info.get("url").and_then(Value::as_str) {
                observed_domain = canonical_site_key(u).unwrap_or_default();
                for (uk, uv) in extract_url_template_vars(u) {
                    vars.insert(uk, uv);
                }
            }
        }
    }

    for (name, spec) in &routine.params {
        if let Some(val) = arguments.get(name) {
            vars.insert(name.clone(), val.clone());
        } else if let Some(def) = &spec.default {
            let resolved_def = interpolate_value(def, &vars);
            vars.insert(name.clone(), resolved_def);
        } else if spec.required {
            return Err(format!("Missing required routine argument '{name}'. [bad_request]"));
        }
    }
    for (k, v) in arguments {
        vars.entry(k.clone()).or_insert_with(|| v.clone());
    }

    let started = Instant::now();
    let mut outputs = Map::new();
    let mut step_log = Vec::with_capacity(routine.steps.len());
    let mut auto_repaired = false;
    let mut repaired_step: Option<usize> = None;

    for (idx, step) in routine.steps.iter().enumerate() {
        let method = canonical_step_method(&step.op)?;
        if enforce_read_only && !is_read_safe_step(method) {
            return Err(format!(
                "Step {} ({method}) is not allowed in read-only mode. [read_only]",
                idx + 1
            ));
        }
        if enforce_read_only && method == "page.fetch" {
            let http_m = step
                .params
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("GET")
                .to_ascii_uppercase();
            if http_m != "GET" && http_m != "HEAD" {
                return Err(format!(
                    "Step {} (page.fetch {http_m}) is not allowed in read-only mode. [read_only]",
                    idx + 1
                ));
            }
        }

        // Skip optional empty text entry (e.g. insert_shape when label == "")
        if method == "page.type" && step.optional {
            let rendered_check = interpolate_value(&step.params, &vars);
            if rendered_check
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(str::is_empty)
            {
                step_log.push(json!({ "step": idx + 1, "op": step.op, "skipped": true }));
                continue;
            }
        }

        let mut p_val = interpolate_value(&step.params, &vars);
        let mut strip_html = false;
        if method == "page.fetch" {
            if let Some(obj) = p_val.as_object_mut() {
                strip_html = obj
                    .remove("stripHtml")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            }
        }
        if (step.op == "doubleClick" || step.op == "dblclick") && p_val.is_object() {
            if let Some(obj) = p_val.as_object_mut() {
                obj.insert("doubleClick".into(), json!(true));
            }
        }
        if let Some(obj) = p_val.as_object_mut() {
            if let Some(tid) = active_tab {
                obj.entry("tabId").or_insert_with(|| json!(tid));
            }
            if enforce_read_only {
                obj.insert("readOnly".into(), json!(true));
            }
            obj.insert("_fromRoutine".into(), json!(true));
        }

        let step_start = Instant::now();
        let mut outcome = caller(method.to_string(), p_val.clone()).await;
        let mut step_repaired_locator: Option<Value> = None;

        // Semantic relocation auto-repair on non-optional read-safe selector drift (or explicit semanticLocator fallback)
        if let Err(ref err) = outcome {
            if !step.optional {
                let lower_err = err.to_string().to_ascii_lowercase();
                let read_safe_step = is_read_safe_step(method)
                    && (method != "page.fetch" || {
                        let m = p_val
                            .get("method")
                            .and_then(Value::as_str)
                            .unwrap_or("GET")
                            .to_ascii_uppercase();
                        m == "GET" || m == "HEAD"
                    });
                let explicit_sem = p_val.get("semanticLocator").filter(|v| v.is_object()).cloned();
                let is_locator_drift = matches!(
                    err.code(),
                    "page_error" | "timeout" | "strict_locator"
                ) || lower_err.contains("no element matches")
                    || lower_err.contains("timed out");
                if is_locator_drift && (read_safe_step || explicit_sem.is_some()) {
                    let cands = if read_safe_step {
                        synthesize_semantic_relocation_locators(method, &p_val)
                    } else {
                        explicit_sem.into_iter().collect()
                    };
                    for cand_loc in cands {
                        let mut alt_params = p_val.clone();
                        if let Some(obj) = alt_params.as_object_mut() {
                            obj.remove("ref");
                            obj.insert("locator".into(), cand_loc.clone());
                        }
                        if let Ok(alt_res) =
                            caller(method.to_string(), alt_params).await
                        {
                            if verify_relocation_postcondition(method, &p_val, &alt_res) {
                                outcome = Ok(alt_res);
                                step_repaired_locator = Some(cand_loc);
                                break;
                            }
                        }
                    }
                }
            }
        }

        match outcome {
            Ok(res) => {
                if active_tab.is_none() {
                    active_tab = res.get("tabId").and_then(Value::as_i64);
                }
                if observed_domain.is_empty() {
                    if let Some(u) = res.get("url").and_then(Value::as_str) {
                        observed_domain = canonical_site_key(u).unwrap_or_default();
                    }
                }
                if let Some(ref rep_loc) = step_repaired_locator {
                    auto_repaired = true;
                    if repaired_step.is_none() {
                        repaired_step = Some(idx);
                    }
                    if !observed_domain.is_empty() {
                        persist_repaired_routine_step_on_disk(
                            &observed_domain,
                            &routine.name,
                            idx,
                            rep_loc,
                        );
                    }
                }
                if let Some(out_key) = &step.save_as {
                    let extracted = if method == "page.fetch" {
                        if let Some(b64) = res.get("data").and_then(Value::as_str) {
                            match crate::decode_base64(b64) {
                                Ok(bytes) => {
                                    let decoded_str = String::from_utf8_lossy(&bytes).to_string();
                                    Value::String(if strip_html {
                                        strip_html_to_text(&decoded_str)
                                    } else {
                                        decoded_str
                                    })
                                }
                                Err(_) => res.clone(),
                            }
                        } else {
                            res.clone()
                        }
                    } else if let Some(v) = res.get("value") {
                        v.clone()
                    } else if let Some(t) = res.get("text") {
                        t.clone()
                    } else {
                        res.clone()
                    };
                    outputs.insert(out_key.clone(), extracted.clone());
                    vars.insert(out_key.clone(), extracted);
                }
                step_log.push(json!({
                    "step": idx + 1,
                    "op": step.op,
                    "ok": true,
                    "autoRepaired": step_repaired_locator.is_some(),
                    "ms": step_start.elapsed().as_millis() as u64,
                }));
            }
            Err(err) if step.optional => {
                step_log.push(json!({
                    "step": idx + 1,
                    "op": step.op,
                    "ok": false,
                    "optionalIgnored": true,
                    "error": err.to_string(),
                }));
            }
            Err(err) => {
                let err_str = err.to_string();
                let mut recorded_stale = false;
                if !observed_domain.is_empty() {
                    record_routine_outcome_on_disk(
                        &observed_domain,
                        &routine.name,
                        false,
                        Some(&err_str),
                    );
                    recorded_stale = true;
                }

                // Graceful read-only fallback: return bounded top-frame snapshot instead of hard failure
                if routine.read_only && !strict_mode {
                    let mut snap_params = json!({
                        "frames": "top",
                        "maxChars": 12000,
                        "_noLearn": true,
                        "_fromRoutine": true,
                    });
                    if let Some(tid) = active_tab {
                        snap_params["tabId"] = json!(tid);
                    }
                    if let Ok(snap_res) =
                        caller("page.snapshot".to_string(), snap_params).await
                    {
                        let snap_text = snap_res
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        if !snap_text.trim().is_empty() {
                            if active_tab.is_none() {
                                active_tab = snap_res.get("tabId").and_then(Value::as_i64);
                            }
                            if observed_domain.is_empty() {
                                if let Some(u) = extract_snapshot_header_url(snap_text) {
                                    observed_domain = canonical_site_key(u).unwrap_or_default();
                                }
                            }
                            if !recorded_stale && !observed_domain.is_empty() {
                                record_routine_outcome_on_disk(
                                    &observed_domain,
                                    &routine.name,
                                    false,
                                    Some(&err_str),
                                );
                            }
                            outputs.insert("fallbackSnapshot".into(), json!(snap_text));
                            return Ok(json!({
                                "routine": routine.name,
                                "domain": observed_domain,
                                "tabId": active_tab,
                                "degradedFallback": true,
                                "staleError": err_str,
                                "outputs": outputs,
                            }));
                        }
                    }
                }

                return Err(format!(
                    "Routine '{}' failed at step {} ({}): {}",
                    routine.name,
                    idx + 1,
                    step.op,
                    err_str
                ));
            }
        }
    }

    if !observed_domain.is_empty() {
        record_routine_outcome_on_disk(&observed_domain, &routine.name, true, None);
    }

    let mut result_json = json!({
        "routine": routine.name,
        "tabId": active_tab,
        "elapsedMs": started.elapsed().as_millis() as u64,
        "stepsExecuted": step_log.len(),
        "steps": step_log,
        "outputs": outputs,
    });
    if auto_repaired {
        if let Some(obj) = result_json.as_object_mut() {
            obj.insert("autoRepaired".into(), json!(true));
            if let Some(step_idx) = repaired_step {
                obj.insert("repairedStep".into(), json!(step_idx));
            }
        }
    }
    Ok(result_json)
}

pub struct BatchRunOptions<'a> {
    pub steps: &'a [RoutineStep],
    pub variables: &'a Map<String, Value>,
    pub tab_id: Option<i64>,
    pub browser: Option<&'a str>,
    pub enforce_read_only: bool,
    pub stop_on_error: bool,
    pub save_as_routine: Option<(&'a str, &'a str)>,
}

/// Executes an ad-hoc multi-step sequence inside the caller's existing IPC session lease in a single roundtrip.
pub async fn execute_batch(client: &BridgeClient, opts: BatchRunOptions<'_>) -> Result<Value, String> {
    if opts.steps.is_empty() {
        return Err("steps must contain at least 1 step. [bad_request]".to_string());
    }
    if opts.steps.len() > 100 {
        return Err("steps must contain at most 100 steps per batch. [bad_request]".to_string());
    }

    let mut vars = opts.variables.clone();
    let mut active_tab = opts.tab_id;
    let mut observed_domain = String::new();

    let needs_url_vars = opts
        .steps
        .iter()
        .any(|s| s.params.to_string().contains("{{url."))
        || opts.save_as_routine.is_some();
    if needs_url_vars {
        let mut info_p = Map::new();
        if let Some(tid) = active_tab {
            info_p.insert("tabId".into(), json!(tid));
        }
        if let Ok((info, _)) = client
            .send("page.info", Value::Object(info_p), opts.browser, Duration::from_secs(10))
            .await
        {
            if active_tab.is_none() {
                active_tab = info.get("tabId").and_then(Value::as_i64);
            }
            if let Some(u) = info.get("url").and_then(Value::as_str) {
                observed_domain = canonical_site_key(u).unwrap_or_default();
                for (uk, uv) in extract_url_template_vars(u) {
                    vars.entry(uk).or_insert(uv);
                }
            }
        }
    }

    // Validate all step ops and read-only constraints upfront before executing mutations.
    let mut all_read_safe = true;
    for (idx, step) in opts.steps.iter().enumerate() {
        let method = canonical_step_method(&step.op)?;
        let step_read_safe = is_read_safe_step(method)
            && (method != "page.fetch" || {
                let m = step
                    .params
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or("GET")
                    .to_ascii_uppercase();
                m == "GET" || m == "HEAD"
            });
        all_read_safe &= step_read_safe;
        if opts.enforce_read_only && !step_read_safe {
            return Err(format!(
                "Batch step {} ({method}) is not allowed in read-only mode. [read_only]",
                idx + 1
            ));
        }
    }

    let suppress_auto_learn = opts.save_as_routine.is_some();
    let started = Instant::now();
    let mut outputs = Map::new();
    let mut step_log = Vec::with_capacity(opts.steps.len());
    let mut succeeded = 0usize;
    let mut failed = 0usize;

    for (idx, step) in opts.steps.iter().enumerate() {
        let method = canonical_step_method(&step.op)?;
        if method == "page.type" && step.optional {
            let rendered_check = interpolate_value(&step.params, &vars);
            if rendered_check
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(str::is_empty)
            {
                step_log.push(json!({ "step": idx + 1, "op": step.op, "skipped": true }));
                continue;
            }
        }

        let mut p_val = interpolate_value(&step.params, &vars);
        let mut strip_html = false;
        if method == "page.fetch" {
            if let Some(obj) = p_val.as_object_mut() {
                strip_html = obj
                    .remove("stripHtml")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            }
        }
        if (step.op == "doubleClick" || step.op == "dblclick") && p_val.is_object() {
            if let Some(obj) = p_val.as_object_mut() {
                obj.insert("doubleClick".into(), json!(true));
            }
        }
        if let Some(obj) = p_val.as_object_mut() {
            if let Some(tid) = active_tab {
                obj.entry("tabId").or_insert_with(|| json!(tid));
            }
            if opts.enforce_read_only {
                obj.insert("readOnly".into(), json!(true));
            }
            if suppress_auto_learn {
                obj.insert("_fromRoutine".into(), json!(true));
            }
        }

        let step_start = Instant::now();
        match client
            .send(method, p_val, opts.browser, Duration::from_secs(60))
            .await
        {
            Ok((res, _)) => {
                succeeded += 1;
                if active_tab.is_none() {
                    active_tab = res.get("tabId").and_then(Value::as_i64);
                }
                if observed_domain.is_empty() {
                    if let Some(u) = res.get("url").and_then(Value::as_str) {
                        observed_domain = canonical_site_key(u).unwrap_or_default();
                    }
                }
                if let Some(out_key) = &step.save_as {
                    let extracted = if method == "page.fetch" {
                        if let Some(b64) = res.get("data").and_then(Value::as_str) {
                            match crate::decode_base64(b64) {
                                Ok(bytes) => {
                                    let decoded_str = String::from_utf8_lossy(&bytes).to_string();
                                    Value::String(if strip_html {
                                        strip_html_to_text(&decoded_str)
                                    } else {
                                        decoded_str
                                    })
                                }
                                Err(_) => res.clone(),
                            }
                        } else {
                            res.clone()
                        }
                    } else if let Some(v) = res.get("value") {
                        v.clone()
                    } else if let Some(t) = res.get("text") {
                        t.clone()
                    } else {
                        res.clone()
                    };
                    outputs.insert(out_key.clone(), extracted.clone());
                    vars.insert(out_key.clone(), extracted);
                }
                step_log.push(json!({
                    "step": idx + 1,
                    "op": step.op,
                    "ok": true,
                    "ms": step_start.elapsed().as_millis() as u64,
                }));
            }
            Err(err) if step.optional => {
                step_log.push(json!({
                    "step": idx + 1,
                    "op": step.op,
                    "ok": false,
                    "optionalIgnored": true,
                    "error": err.to_string(),
                }));
            }
            Err(err) => {
                failed += 1;
                let err_str = err.to_string();
                step_log.push(json!({
                    "step": idx + 1,
                    "op": step.op,
                    "ok": false,
                    "ms": step_start.elapsed().as_millis() as u64,
                    "error": err_str,
                }));
                if opts.stop_on_error {
                    return Err(format!(
                        "Batch failed at step {} ({}): {}",
                        idx + 1,
                        step.op,
                        err_str
                    ));
                }
            }
        }
    }

    let mut saved_routine_name: Option<String> = None;
    if failed == 0 {
        if let Some((raw_name, raw_desc)) = opts.save_as_routine {
            let r_name = raw_name.trim();
            if !r_name.is_empty() && !observed_domain.is_empty() {
                let now_ts = now_iso8601();
                let routine = RoutineDefinition {
                    name: r_name.to_string(),
                    description: if raw_desc.trim().is_empty() {
                        format!("Saved {}-step batch routine on {observed_domain}.", opts.steps.len())
                    } else {
                        raw_desc.trim().to_string()
                    },
                    read_only: all_read_safe,
                    source: Some("batch_saved".to_string()),
                    verified_at: Some(now_ts.clone()),
                    updated_at: Some(now_ts.clone()),
                    last_succeeded_at: Some(now_ts),
                    params: BTreeMap::new(),
                    steps: opts.steps.to_vec(),
                    ..Default::default()
                };
                let _ = client
                    .send(
                        "site.save",
                        json!({ "domain": observed_domain, "routine": routine }),
                        opts.browser,
                        Duration::from_secs(5),
                    )
                    .await;
                saved_routine_name = Some(r_name.to_string());
            }
        }
    }

    Ok(json!({
        "tabId": active_tab,
        "elapsedMs": started.elapsed().as_millis() as u64,
        "stepsExecuted": step_log.len(),
        "succeeded": succeeded,
        "failed": failed,
        "steps": step_log,
        "outputs": outputs,
        "savedRoutine": saved_routine_name,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(1);

    struct ScopedTestRoutinesDir {
        path: PathBuf,
    }

    impl ScopedTestRoutinesDir {
        fn new(label: &str) -> Self {
            let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("target")
                .join("test-routines-isolated")
                .join(format!("{}-{}-{seq}", label, std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("create isolated test routines dir");
            TEST_ROUTINES_DIR.with(|cell| {
                *cell.borrow_mut() = Some(path.clone());
            });
            Self { path }
        }
    }

    impl Drop for ScopedTestRoutinesDir {
        fn drop(&mut self) {
            TEST_ROUTINES_DIR.with(|cell| {
                *cell.borrow_mut() = None;
            });
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn resolves_subdomain_to_builtin_diagrams_net_playbook() {
        let _iso = ScopedTestRoutinesDir::new("diagrams");
        assert_eq!(
            domain_candidates("https://app.diagrams.net/#"),
            vec!["app.diagrams.net".to_string(), "diagrams.net".to_string()]
        );
        let pb = resolve_playbook("https://app.diagrams.net/#").expect("builtin playbook");
        assert_eq!(pb.domain, "diagrams.net");
        assert!(pb.routines.contains_key("read_diagram_xml"));
        assert!(pb.routines.contains_key("write_diagram_xml"));
        assert!(pb.routines.contains_key("insert_shape"));
    }

    #[test]
    fn interpolates_exact_types_and_inline_templates() {
        let mut vars = Map::new();
        vars.insert("shape".into(), json!("Cylinder"));
        vars.insert("count".into(), json!(3));
        let tpl = json!({
            "exact": "{{count}}",
            "inline": "Node: {{shape}} #{{count}}",
            "url": "https://github.com/search?q={{q:urlencode}}"
        });
        vars.insert("q".into(), json!("rust async & c#"));
        let out = interpolate_value(&tpl, &vars);
        assert_eq!(out["exact"], json!(3));
        assert_eq!(out["inline"], json!("Node: Cylinder #3"));
        assert_eq!(out["url"], json!("https://github.com/search?q=rust%20async%20%26%20c%23"));
    }

    #[test]
    fn resolves_all_top_10_popular_site_playbooks() {
        let _iso = ScopedTestRoutinesDir::new("top-sites");
        let targets = [
            ("https://www.google.com/", "google.com", "search"),
            ("https://docs.google.com/document/d/195j9eDD3/edit", "docs.google.com/document", "read_document"),
            ("https://docs.google.com/spreadsheets/d/1BxiMVs0/edit#gid=42", "docs.google.com/spreadsheets", "read_sheet_csv"),
            ("https://sheets.google.com/", "docs.google.com/spreadsheets", "write_cell"),
            ("https://mail.google.com/mail/u/0/#inbox", "mail.google.com", "search_mail"),
            ("https://chatgpt.com/", "chatgpt.com", "draft_prompt"),
            ("https://chat.openai.com/", "chatgpt.com", "ask_and_wait"),
            ("https://claude.ai/new", "claude.ai", "draft_prompt"),
            ("https://www.perplexity.ai/", "perplexity.ai", "ask_search"),
            ("https://www.youtube.com/watch?v=123", "youtube.com", "search_videos"),
            ("https://github.com/torvalds/linux", "github.com", "search_repo_issues"),
            ("https://en.wikipedia.org/wiki/Rust", "wikipedia.org", "search_article"),
            ("https://www.reddit.com/r/rust/", "reddit.com", "fetch_subreddit_json"),
            ("https://x.com/explore", "x.com", "read_timeline_posts"),
            ("https://www.linkedin.com/jobs/", "linkedin.com", "search_jobs"),
            ("https://www.notion.com/help", "notion.so", "read_page"),
            ("https://team.notion.site/Doc-123", "notion.so", "read_page"),
            ("https://arxiv.org/abs/1706.03762", "arxiv.org", "open_html_paper"),
            ("https://huggingface.co/Qwen/Qwen2.5-Coder-32B", "huggingface.co", "read_model_card"),
            ("https://www.npmjs.com/package/esbuild", "npmjs.com", "read_package_readme"),
            ("https://pypi.org/project/httpx/", "pypi.org", "read_package_docs"),
            ("https://medium.com/", "medium.com", "read_article"),
            ("https://stackoverflow.com/questions/1", "stackoverflow.com", "read_qa"),
            ("https://www.amazon.com/", "amazon.com", "search_products"),
            ("https://news.ycombinator.com/", "news.ycombinator.com", "read_front_page"),
            ("https://finance.yahoo.com/quote/MSFT/", "finance.yahoo.com", "lookup_quote"),
        ];
        for (url, expected_domain, expected_routine) in targets {
            let pb = resolve_playbook(url).unwrap_or_else(|| panic!("missing playbook for {url}"));
            assert_eq!(pb.domain, expected_domain);
            assert_eq!(pb.schema_version, 2);
            assert!(
                pb.verified_at.as_deref().and_then(iso8601_to_epoch).is_some(),
                "missing valid ISO-8601 verifiedAt on {expected_domain}"
            );
            assert!(
                pb.routines.contains_key(expected_routine),
                "missing routine {expected_routine} on {expected_domain}"
            );
            for step in pb.routines[expected_routine].steps.iter() {
                canonical_step_method(&step.op).expect("valid step op");
            }
        }
        // Unscoped docs.google.com/presentation has no built-in Google Search or Google Docs playbook!
        assert!(builtin_playbook_for("docs.google.com").is_none());
        assert_eq!(
            domain_candidates("https://docs.google.com/presentation/d/1/edit"),
            vec!["docs.google.com".to_string()]
        );

        // Verify ISO-8601 roundtrip and URL variable extraction
        let epoch = 1_794_908_700;
        let iso = epoch_to_iso8601(epoch);
        assert_eq!(iso, "2026-11-17T09:45:00Z");
        assert_eq!(iso8601_to_epoch(&iso), Some(epoch));

        let uvars = extract_url_template_vars("https://docs.google.com/spreadsheets/d/1BxiMVs0XRA/edit?usp=sharing#gid=987");
        assert_eq!(uvars["url.docId"], json!("1BxiMVs0XRA"));
        assert_eq!(uvars["url.gid"], json!("987"));

        let gh_vars = extract_url_template_vars("https://github.com/rust-lang/rust/issues/1");
        assert_eq!(gh_vars["url.repo"], json!("rust-lang/rust"));

        // Verify consecutive selector failures flag routine stale=true (website redesign detection) in isolated dir
        record_routine_outcome_on_disk("https://chatgpt.com/", "draft_prompt", false, Some("Timed out [timeout]"));
        assert!(!resolve_playbook("https://chatgpt.com/").unwrap().routines["draft_prompt"].stale);
        record_routine_outcome_on_disk("https://chatgpt.com/", "draft_prompt", false, Some("Timed out [timeout]"));
        let stale_pb = resolve_playbook("https://chatgpt.com/").unwrap();
        assert!(stale_pb.routines["draft_prompt"].stale);
        assert!(
            stale_pb.routines["draft_prompt"]
                .stale_reason
                .as_deref()
                .unwrap_or("")
                .contains("redesigned")
        );
        // Recovery clears stale flag
        record_routine_outcome_on_disk("https://chatgpt.com/", "draft_prompt", true, None);
        assert!(!resolve_playbook("https://chatgpt.com/").unwrap().routines["draft_prompt"].stale);
    }

    #[test]
    fn learner_adapts_wait_until_hydration_input_and_error_recovery() {
        let _iso = ScopedTestRoutinesDir::new("learner-core");
        let mut learner = SiteLearner::default();

        // 1. Stalled window.onload across k >= 3 visits -> learns preferredWaitUntil = "domcontentloaded" and strips _telemetry
        for visit in 1..=3 {
            let mut nav_params = json!({ "tabId": 7, "url": format!("https://help.example.test/docs/{visit}") });
            let call = learner.prepare_request("s1", "page.navigate", &mut nav_params);
            assert!(
                nav_params.get("_siteProfile").is_none(),
                "visit {visit} must not switch waitUntil before k >= 3 samples"
            );
            let mut nav_res = json!({
                "tabId": 7,
                "url": format!("https://help.example.test/docs/{visit}"),
                "loaded": true,
                "_telemetry": { "domLoaded": true, "loadTimedOut": true, "domLoadedMs": 320 }
            });
            let _ = learner.observe_response(&call, true, Some(&mut nav_res), None);
            assert!(nav_res.get("_telemetry").is_none(), "_telemetry must be stripped before forwarding");
        }

        // Visit 4 automatically injects _siteProfile.preferredWaitUntil = "domcontentloaded"
        let mut nav_params4 = json!({ "tabId": 7, "url": "https://help.example.test/docs/4" });
        let call4 = learner.prepare_request("s1", "page.navigate", &mut nav_params4);
        assert_eq!(
            nav_params4["_siteProfile"]["preferredWaitUntil"],
            json!("domcontentloaded")
        );
        let mut nav_res4 = json!({
            "tabId": 7,
            "url": "https://help.example.test/docs/4",
            "loaded": true
        });
        let _ = learner.observe_response(&call4, true, Some(&mut nav_res4), None);

        // 2. Post-navigation stale_ref (>=3x) flags dynamicDom WITHOUT ratcheting hydrationSettleMs;
        //    real hydration not_ready (>=3x) bumps hydrationSettleMs!
        for _ in 0..3 {
            let mut click_stale = json!({ "ref": "e4" });
            let call_stale = learner.prepare_request("s1", "page.click", &mut click_stale);
            let stale_err = json!({ "code": "stale_ref", "message": "Stale element ref e4." });
            let _ = learner.observe_response(&call_stale, false, None, Some(&stale_err));
        }
        let pb_after_stale = learner.get_playbook("help.example.test").unwrap();
        assert!(pb_after_stale.access_profile.dynamic_dom);
        assert_eq!(
            pb_after_stale.access_profile.hydration_settle_ms, 0,
            "stale_ref is caller error and must never increase hydrationSettleMs"
        );

        for _ in 0..3 {
            let mut click_nr = json!({ "ref": "e5" });
            let call_nr = learner.prepare_request("s1", "page.click", &mut click_nr);
            let nr_err = json!({ "code": "not_ready", "message": "Document still hydrating." });
            let _ = learner.observe_response(&call_nr, false, None, Some(&nr_err));
        }
        let pb_after_nr = learner.get_playbook("help.example.test").unwrap();
        assert_eq!(pb_after_nr.access_profile.hydration_settle_ms, 250);

        // 3. Error -> Recovery Action -> Snapshot -> Retry Success triad learning + blocker extraction & CDP fallback
        let mut target_click = json!({
            "locator": { "steps": [{ "kind": "role", "value": "button", "name": "Checkout" }] }
        });
        let call_blocked = learner.prepare_request("s1", "page.click", &mut target_click);
        let blocked_err = json!({
            "code": "not_actionable",
            "message": "Locator target is covered by <div#cookie-modal.overlay>. No click was sent."
        });
        let _ = learner.observe_response(&call_blocked, false, None, Some(&blocked_err));

        // Agent clicks cookie banner accept button (with CDP fallback telemetry)
        let mut dismiss_params = json!({
            "locator": { "steps": [{ "kind": "role", "value": "button", "name": "Accept All" }] }
        });
        let call_dismiss = learner.prepare_request("s1", "page.click", &mut dismiss_params);
        let mut dismiss_res = json!({
            "tabId": 7,
            "url": "https://help.example.test/docs/4",
            "navigated": false,
            "_telemetry": { "cdpFallback": true }
        });
        let _ = learner.observe_response(&call_dismiss, true, Some(&mut dismiss_res), None);

        // Agent takes an intermediate snapshot (must NOT wipe pending recovery!)
        let mut snap_params = json!({});
        let call_snap = learner.prepare_request("s1", "page.snapshot", &mut snap_params);
        let mut snap_res = json!({
            "tabId": 7,
            "text": "Tab 7: Docs\nURL: https://help.example.test/docs/4\n- button \"Checkout\" [ref=e9]"
        });
        let _ = learner.observe_response(&call_snap, true, Some(&mut snap_res), None);

        // Agent retries original Checkout button -> succeeds!
        let mut retry_click = json!({
            "locator": { "steps": [{ "kind": "role", "value": "button", "name": "Checkout" }] }
        });
        let call_retry = learner.prepare_request("s1", "page.click", &mut retry_click);
        assert_eq!(retry_click["_siteProfile"]["preferredInput"], json!("dom"));
        let mut retry_res = json!({
            "tabId": 7,
            "url": "https://help.example.test/docs/4",
            "navigated": false
        });
        let _ = learner.observe_response(&call_retry, true, Some(&mut retry_res), None);

        let final_pb = learner.get_playbook("help.example.test").unwrap();
        assert_eq!(
            final_pb.access_profile.known_blockers,
            vec!["<div#cookie-modal.overlay>".to_string()]
        );
        assert_eq!(final_pb.access_profile.learned_recoveries.len(), 1);
        assert_eq!(
            final_pb.access_profile.learned_recoveries[0].blocker,
            "<div#cookie-modal.overlay>"
        );
        assert_eq!(
            final_pb.access_profile.learned_recoveries[0].recovery_method,
            "page.click"
        );
    }

    #[test]
    fn auto_routine_distills_trajectory_strips_detours_promotes_refs_and_scrubs_secrets() {
        let _iso = ScopedTestRoutinesDir::new("auto-routine");
        let mut learner = SiteLearner::default();

        // 1. Navigate to a multi-step configuration form
        let mut nav = json!({
            "tabId": 42,
            "url": "https://portal.example.test/org/repo/settings/rules/new?target=branch"
        });
        let c_nav = learner.prepare_request("s9", "page.navigate", &mut nav);
        let mut r_nav = json!({
            "tabId": 42,
            "url": "https://portal.example.test/org/repo/settings/rules/new?target=branch",
            "loaded": true
        });
        let _ = learner.observe_response(&c_nav, true, Some(&mut r_nav), None);

        // 2. Type draft typo via raw ref, then overwrite same field -> coalesced to 1 step + promoted to semanticLocator!
        let name_loc = json!({ "steps": [{ "kind": "role", "value": "textbox", "name": "Ruleset Name*", "exact": true }] });
        for draft in ["Draft typo", "Protect main branch"] {
            let mut tp = json!({ "ref": "e47", "text": draft, "clear": true });
            let ct = learner.prepare_request("s9", "page.type", &mut tp);
            let mut rt = json!({
                "tabId": 42,
                "url": "https://portal.example.test/org/repo/settings/rules/new?target=branch",
                "navigated": false,
                "_telemetry": { "semanticLocator": name_loc, "fieldLabel": "Ruleset Name*" }
            });
            let _ = learner.observe_response(&ct, true, Some(&mut rt), None);
        }

        // 3. Failed stale-ref detour + failed timeout detour -> both dropped from distilled routine!
        let mut bad1 = json!({ "ref": "e95" });
        let c_bad1 = learner.prepare_request("s9", "page.click", &mut bad1);
        let _ = learner.observe_response(
            &c_bad1,
            false,
            None,
            Some(&json!({ "code": "page_error", "message": "Element ref e95 is stale." })),
        );

        let mut bad2 = json!({
            "locator": { "steps": [{ "kind": "role", "value": "menuitemradio", "name": "Active" }] }
        });
        let c_bad2 = learner.prepare_request("s9", "page.click", &mut bad2);
        let _ = learner.observe_response(
            &c_bad2,
            false,
            None,
            Some(&json!({ "code": "timeout", "message": "Timed out waiting for element." })),
        );

        // 4. Sensitive secret field -> plaintext NEVER stored, parameterized as required=true with default=None!
        let secret_loc = json!({ "steps": [{ "kind": "label", "value": "Webhook Secret", "exact": true }] });
        let mut tp_sec = json!({ "ref": "e50", "text": "whsec_TOP_SECRET_999", "clear": true });
        let c_sec = learner.prepare_request("s9", "page.type", &mut tp_sec);
        let mut r_sec = json!({
            "tabId": 42,
            "url": "https://portal.example.test/org/repo/settings/rules/new?target=branch",
            "navigated": false,
            "_telemetry": { "semanticLocator": secret_loc, "fieldLabel": "Webhook Secret", "sensitive": true }
        });
        let _ = learner.observe_response(&c_sec, true, Some(&mut r_sec), None);

        // 5. Check a rule checkbox via raw ref
        let chk_loc = json!({ "steps": [{ "kind": "role", "value": "checkbox", "name": "Require status checks to pass", "exact": true }] });
        let mut chk = json!({ "ref": "e72", "checked": true });
        let c_chk = learner.prepare_request("s9", "page.check", &mut chk);
        let mut r_chk = json!({
            "tabId": 42,
            "url": "https://portal.example.test/org/repo/settings/rules/new?target=branch",
            "checked": true,
            "changed": true,
            "_telemetry": { "semanticLocator": chk_loc, "fieldLabel": "Require status checks to pass" }
        });
        let _ = learner.observe_response(&c_chk, true, Some(&mut r_chk), None);

        // 6. Click "Create" button which submits and navigates -> triggers immediate Auto-Routine crystallization!
        let create_loc = json!({ "steps": [{ "kind": "role", "value": "button", "name": "Create", "exact": true }] });
        let mut submit_click = json!({ "ref": "e84" });
        let c_sub = learner.prepare_request("s9", "page.click", &mut submit_click);
        let mut r_sub = json!({
            "tabId": 42,
            "url": "https://portal.example.test/org/repo/settings/rules/27487506",
            "navigated": true,
            "_telemetry": { "semanticLocator": create_loc, "fieldLabel": "Create" }
        });
        let persisted = learner
            .observe_response(&c_sub, true, Some(&mut r_sub), None)
            .expect("navigating submit after >=3 steps must crystallize auto-routine");

        let auto_r = persisted
            .routines
            .get("auto_settings_rules_new_create")
            .expect("expected auto_settings_rules_new_create routine");
        assert_eq!(auto_r.source.as_deref(), Some("auto_learned"));
        assert_eq!(auto_r.steps.len(), 4, "coalesced 2 drafts + secret + check + submit = 4 clean steps");
        assert!(auto_r.description.contains("eliminated 2 failed detours"), "{}", auto_r.description);

        // Verify zero raw refs and zero secret leaks in serialized JSON
        let serialized = serde_json::to_string(&persisted).unwrap();
        assert!(!serialized.contains("\"ref\""));
        assert!(!serialized.contains("Draft typo"));
        assert!(!serialized.contains("whsec_TOP_SECRET_999"));

        assert_eq!(
            auto_r.params["ruleset_name"].default,
            Some(json!("Protect main branch"))
        );
        assert!(!auto_r.params["ruleset_name"].required);
        assert!(auto_r.params["webhook_secret"].required);
        assert_eq!(auto_r.params["webhook_secret"].default, None);

        // Verify snapshot hint surfaces [auto] tag
        let hint = format_site_memory_hint_from_playbook(&persisted).unwrap();
        assert!(hint.contains("[auto] auto_settings_rules_new_create("), "{hint}");

        // Verify _fromRoutine=true steps are stripped before forwarding and do NOT re-record into trajectories
        let mut replay_step = json!({
            "tabId": 42,
            "_fromRoutine": true,
            "locator": create_loc
        });
        let c_rep = learner.prepare_request("s9", "page.click", &mut replay_step);
        assert!(c_rep.from_routine);
        assert!(replay_step.get("_fromRoutine").is_none());
    }

    #[test]
    fn credit_assignment_isolates_no_learn_profile_override_and_explicit_s1_calls() {
        let _iso = ScopedTestRoutinesDir::new("credit-assignment");
        let mut learner = SiteLearner::default();

        // Seed a commit-configured profile so we verify S1 explicit waitUntil="load" NEVER mutates "commit"!
        let mut commit_seed = SitePlaybook::new("fastcommit.example.test");
        commit_seed.access_profile.preferred_wait_until = Some("commit".into());
        commit_seed.access_profile.hydration_settle_ms = 50;
        commit_seed.access_profile.stamp_seed_provenance();
        save_playbook(&commit_seed).unwrap();

        // 1. _noLearn: true strips _noLearn from outgoing wire params, strips _telemetry, updates tab URL,
        //    and performs ZERO profile/stats/bandit/pitfall mutations (returns None).
        for _ in 0..5 {
            let mut p = json!({
                "tabId": 10,
                "url": "https://fastcommit.example.test/search/abc",
                "_noLearn": true
            });
            let call = learner.prepare_request("s1", "page.navigate", &mut p);
            assert!(call.no_learn);
            assert!(p.get("_noLearn").is_none(), "_noLearn must never leak to extension");
            assert_eq!(p["_siteProfile"]["preferredWaitUntil"], json!("commit"));

            let mut res = json!({
                "tabId": 10,
                "url": "https://fastcommit.example.test/search/abc",
                "loaded": false,
                "_telemetry": { "domLoaded": true, "loadTimedOut": true }
            });
            let out = learner.observe_response(&call, true, Some(&mut res), None);
            assert!(out.is_none(), "_noLearn must never return a dirty playbook");
            assert!(res.get("_telemetry").is_none(), "_telemetry must still be stripped");
        }
        assert_eq!(
            learner.tab_urls.get(&10).map(String::as_str),
            Some("https://fastcommit.example.test/search/abc")
        );
        let pb_no_learn = learner.get_playbook("fastcommit.example.test").unwrap();
        assert_eq!(pb_no_learn.access_profile.stats.navigations, 0);
        assert_eq!(pb_no_learn.access_profile.preferred_wait_until.as_deref(), Some("commit"));

        // 2. Caller _siteProfile override sets profile_overridden=true and never mutates profile/bandit/pitfalls.
        for _ in 0..5 {
            let mut p = json!({
                "tabId": 10,
                "url": "https://fastcommit.example.test/search/abc",
                "_siteProfile": {}
            });
            let call = learner.prepare_request("s1", "page.navigate", &mut p);
            assert!(call.profile_overridden);
            assert_eq!(p["_siteProfile"], json!({}));
            let err = json!({
                "code": "timeout",
                "message": "Navigation timed out.",
                "_telemetry": { "domLoaded": true }
            });
            assert!(learner.observe_response(&call, false, None, Some(&err)).is_none());
        }
        let pb_after_override = learner.get_playbook("fastcommit.example.test").unwrap();
        assert_eq!(pb_after_override.access_profile.preferred_wait_until.as_deref(), Some("commit"));
        assert!(pb_after_override.pitfalls.is_empty());

        // 3. S1 explicit waitUntil="load" + explicit frames="all" calls NEVER mutate commit, hydrationSettleMs, or snapshotFrames="top"!
        let initial_settle = pb_after_override.access_profile.hydration_settle_ms;
        for _ in 0..5 {
            let mut s1_nav = json!({
                "tabId": 11,
                "url": "https://fastcommit.example.test/",
                "waitUntil": "load"
            });
            let c_nav = learner.prepare_request("s1", "page.navigate", &mut s1_nav);
            assert!(c_nav.explicit_wait_until);
            let mut r_nav = json!({
                "tabId": 11,
                "url": "https://fastcommit.example.test/",
                "loaded": false,
                "_telemetry": { "domLoaded": true, "loadTimedOut": true, "domLoadedMs": 300, "loadMs": 12000 }
            });
            let _ = learner.observe_response(&c_nav, true, Some(&mut r_nav), None);

            // Post-S1-nav timeout on an element also must not blame learned hydrationSettleMs because nav bypassed waitUntil
            let mut click_p = json!({ "tabId": 11, "ref": "e2" });
            let c_clk = learner.prepare_request("s1", "page.click", &mut click_p);
            let _ = learner.observe_response(
                &c_clk,
                false,
                None,
                Some(&json!({ "code": "timeout", "message": "Timed out" })),
            );

            // Explicit frames="all" on docs.google.com/document must NOT clear preferredSnapshotFrames="top"
            let mut doc_nav = json!({
                "tabId": 12,
                "url": "https://docs.google.com/document/d/195j9eDD3/edit",
                "waitUntil": "load"
            });
            let c_dn = learner.prepare_request("s1", "page.navigate", &mut doc_nav);
            let mut r_dn = json!({ "tabId": 12, "url": "https://docs.google.com/document/d/195j9eDD3/edit", "loaded": true });
            let _ = learner.observe_response(&c_dn, true, Some(&mut r_dn), None);

            let mut s1_snap = json!({ "tabId": 12, "frames": "all" });
            let c_sn = learner.prepare_request("s1", "page.snapshot", &mut s1_snap);
            assert!(c_sn.explicit_frames);
            let mut r_sn = json!({
                "tabId": 12,
                "text": "Tab 12: Doc\nURL: https://docs.google.com/document/d/195j9eDD3/edit\n- document",
                "_telemetry": { "visibleIframes": 2, "childFramesScanned": 2, "nonEmptyChildFrames": 1 }
            });
            let _ = learner.observe_response(&c_sn, true, Some(&mut r_sn), None);
        }

        let pb_fc = learner.get_playbook("fastcommit.example.test").unwrap();
        assert_eq!(pb_fc.access_profile.preferred_wait_until.as_deref(), Some("commit"));
        assert_eq!(pb_fc.access_profile.hydration_settle_ms, initial_settle);
        assert_eq!(pb_fc.access_profile.stats.load_timeouts, 0);

        let pb_doc = learner.get_playbook("docs.google.com/document").unwrap();
        assert_eq!(pb_doc.access_profile.preferred_snapshot_frames.as_deref(), Some("top"));
    }

    #[test]
    fn strict_wait_level_ordering_never_downgrades_commit_to_domcontentloaded() {
        let _iso = ScopedTestRoutinesDir::new("wait-order");
        assert!(WaitLevel::Commit < WaitLevel::DomContentLoaded);
        assert!(WaitLevel::DomContentLoaded < WaitLevel::Load);

        let mut commit_pb = SitePlaybook::new("stream.example.test");
        commit_pb.access_profile.preferred_wait_until = Some("commit".into());
        commit_pb.access_profile.stamp_seed_provenance();
        save_playbook(&commit_pb).unwrap();

        let mut learner = SiteLearner::default();
        assert_eq!(
            learner
                .get_playbook("stream.example.test")
                .unwrap()
                .access_profile
                .preferred_wait_until
                .as_deref(),
            Some("commit")
        );

        for i in 0..5 {
            let mut nav = json!({ "tabId": 21, "url": format!("https://stream.example.test/item/{i}") });
            let call = learner.prepare_request("s2", "page.navigate", &mut nav);
            let mut res = json!({
                "tabId": 21,
                "url": format!("https://stream.example.test/item/{i}"),
                "loaded": false,
                "_telemetry": { "domLoaded": true, "loadTimedOut": true, "domLoadedMs": 200, "loadMs": 9000 }
            });
            let _ = learner.observe_response(&call, true, Some(&mut res), None);
        }

        let pb = learner.get_playbook("stream.example.test").unwrap();
        assert_eq!(
            pb.access_profile.preferred_wait_until.as_deref(),
            Some("commit"),
            "faster commit wait level must never be overwritten with slower domcontentloaded"
        );
    }

    #[test]
    fn snapshot_frames_k_ge_3_and_settle_decay_and_7_day_ttl() {
        let _iso = ScopedTestRoutinesDir::new("decay-ttl");
        let mut learner = SiteLearner::default();

        // Navigate once to register tab URL
        let mut nav0 = json!({ "tabId": 30, "url": "https://frames.example.test/app" });
        let c0 = learner.prepare_request("s3", "page.navigate", &mut nav0);
        let mut r0 = json!({ "tabId": 30, "url": "https://frames.example.test/app", "loaded": true });
        let _ = learner.observe_response(&c0, true, Some(&mut r0), None);

        // 2 empty multiframe snapshots -> NOT enough (k < 3), then 1 non-empty resets counter to 0!
        for _ in 0..2 {
            let mut sp = json!({ "tabId": 30 });
            let cs = learner.prepare_request("s3", "page.snapshot", &mut sp);
            let mut rs = json!({
                "tabId": 30,
                "text": "Tab 30: App\nURL: https://frames.example.test/app\n- main",
                "_telemetry": { "visibleIframes": 2, "childFramesScanned": 2, "nonEmptyChildFrames": 0 }
            });
            let _ = learner.observe_response(&cs, true, Some(&mut rs), None);
        }
        assert!(
            learner
                .get_playbook("frames.example.test")
                .unwrap()
                .access_profile
                .preferred_snapshot_frames
                .is_none()
        );

        // Non-empty child frame resets streak to 0
        {
            let mut sp = json!({ "tabId": 30 });
            let cs = learner.prepare_request("s3", "page.snapshot", &mut sp);
            let mut rs = json!({
                "tabId": 30,
                "text": "Tab 30: App\nURL: https://frames.example.test/app\n- main",
                "_telemetry": { "visibleIframes": 2, "childFramesScanned": 2, "nonEmptyChildFrames": 1 }
            });
            let _ = learner.observe_response(&cs, true, Some(&mut rs), None);
        }
        assert_eq!(
            learner
                .get_playbook("frames.example.test")
                .unwrap()
                .access_profile
                .stats
                .empty_multiframe_snapshots,
            0
        );

        // Now 3 consecutive empty multiframe snapshots -> switches to Some("top") on the 3rd!
        for i in 1..=3 {
            let mut sp = json!({ "tabId": 30 });
            let cs = learner.prepare_request("s3", "page.snapshot", &mut sp);
            let mut rs = json!({
                "tabId": 30,
                "text": "Tab 30: App\nURL: https://frames.example.test/app\n- main",
                "_telemetry": { "visibleIframes": 2, "childFramesScanned": 2, "nonEmptyChildFrames": 0 }
            });
            let _ = learner.observe_response(&cs, true, Some(&mut rs), None);
            let expected = if i < 3 { None } else { Some("top") };
            assert_eq!(
                learner
                    .get_playbook("frames.example.test")
                    .unwrap()
                    .access_profile
                    .preferred_snapshot_frames
                    .as_deref(),
                expected
            );
        }

        // Trigger k=3 post-nav timeouts to bump hydration_settle_ms = 200
        for _ in 0..3 {
            let mut clk = json!({ "tabId": 30, "ref": "e1" });
            let cc = learner.prepare_request("s3", "page.click", &mut clk);
            let _ = learner.observe_response(
                &cc,
                false,
                None,
                Some(&json!({ "code": "timeout", "message": "Timed out" })),
            );
        }
        assert_eq!(
            learner
                .get_playbook("frames.example.test")
                .unwrap()
                .access_profile
                .hydration_settle_ms,
            200
        );

        // 5 clean navigations with settledMs=40 (< 200 - 50) decay hydration_settle_ms 200 -> 150,
        // and 10 more clean navigations decay 150 -> 100 -> 90 (settledMs + 50 floor)!
        for step_round in 0..3 {
            for _ in 0..5 {
                let mut nav = json!({ "tabId": 30, "url": "https://frames.example.test/app" });
                let cn = learner.prepare_request("s3", "page.navigate", &mut nav);
                let mut rn = json!({
                    "tabId": 30,
                    "url": "https://frames.example.test/app",
                    "loaded": true,
                    "_telemetry": { "domLoaded": true, "settledMs": 40 }
                });
                let _ = learner.observe_response(&cn, true, Some(&mut rn), None);
            }
            let expected_ms = match step_round {
                0 => 150,
                1 => 100,
                _ => 90,
            };
            assert_eq!(
                learner
                    .get_playbook("frames.example.test")
                    .unwrap()
                    .access_profile
                    .hydration_settle_ms,
                expected_ms
            );
        }

        // Verify wire forwarding of readinessQuietMs / readinessSelector & 7-day TTL expiry on Learned fields
        let base_t = 1_800_000_000u64;
        let mut prof = SiteAccessProfile {
            preferred_wait_until: Some("domcontentloaded".into()),
            service_worker_navigation: true,
            hydration_settle_ms: 250,
            readiness_quiet_ms: Some(120),
            readiness_selector: Some("main, article".into()),
            wait_until_learned_at: base_t,
            sw_nav_learned_at: base_t,
            settle_learned_at: base_t,
            ..Default::default()
        };
        prof.field_provenance
            .insert("preferredWaitUntil".into(), FieldProvenance::Learned);
        prof.field_provenance
            .insert("serviceWorkerNavigation".into(), FieldProvenance::Learned);
        prof.field_provenance
            .insert("hydrationSettleMs".into(), FieldProvenance::Learned);

        let active_wire = prof.runtime_wire_json_at(base_t + LEARNED_PROFILE_TTL_S - 1).unwrap();
        assert_eq!(active_wire["preferredWaitUntil"], json!("domcontentloaded"));
        assert_eq!(active_wire["serviceWorkerNavigation"], json!(true));
        assert_eq!(active_wire["hydrationSettleMs"], json!(250));
        assert_eq!(active_wire["readinessQuietMs"], json!(120));
        assert_eq!(active_wire["readinessSelector"], json!("main, article"));

        let expired_wire = prof.runtime_wire_json_at(base_t + LEARNED_PROFILE_TTL_S).unwrap();
        assert!(expired_wire.get("preferredWaitUntil").is_none());
        assert!(expired_wire.get("serviceWorkerNavigation").is_none());
        assert!(expired_wire.get("hydrationSettleMs").is_none());
        assert_eq!(expired_wire["readinessQuietMs"], json!(120));
        assert_eq!(expired_wire["readinessSelector"], json!("main, article"));
    }

    #[test]
    fn route_template_normalization_and_bandit_quality_guardrails() {
        let _iso = ScopedTestRoutinesDir::new("bandit");
        assert_eq!(normalize_route_template("https://www.google.com/search?q=rust"), "/search");
        assert_eq!(normalize_route_template("https://www.reddit.com/r/rust/"), "/r/:id");
        assert_eq!(normalize_route_template("https://www.amazon.com/dp/B08N5WRWNW"), "/dp/:id");
        assert_eq!(normalize_route_template("https://arxiv.org/abs/1706.03762"), "/abs/:id");
        assert_eq!(normalize_route_template("https://pypi.org/project/httpx/"), "/project/:id");
        assert_eq!(normalize_route_template("https://www.npmjs.com/package/esbuild"), "/package/:id");
        assert_eq!(normalize_route_template("https://finance.yahoo.com/quote/MSFT/"), "/quote/:id");
        assert_eq!(
            normalize_route_template("https://docs.google.com/document/d/195j9eDD3/edit"),
            "/document/d/:id"
        );
        assert_eq!(
            normalize_route_template("https://example.com/items/550e8400-e29b-41d4-a716-446655440000"),
            "/items/:id"
        );

        // Exact p50 & p95 verification on ArmStats
        let mut stats = ArmStats::default();
        for ms in [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 260, 270, 280, 950] {
            stats.push_latency_ms(ms);
        }
        assert_eq!(stats.p50_ms(), 195);
        assert_eq!(stats.p95_ms(), 280);

        // RouteBandit cold start + quality violation rejection (< 85% reference_chars) + safe fallback + fast feasible selection
        let mut bandit = RouteBandit::default();
        let base_tier = 3; // e.g. domcontentloaded + 300ms settle

        // Cold start (pulls 0, 1, 2): always selects "base" and establishes reference_chars (~10,000),
        // even if pull 0 had a transient 256-char rate-limit stub!
        assert_eq!(bandit.select_arm(ARM_BASE, base_tier), ARM_BASE);
        bandit.record_navigation(ARM_BASE, 620, true, Some(256), ARM_BASE);
        assert_eq!(bandit.select_arm(ARM_BASE, base_tier), ARM_BASE);
        bandit.record_navigation(ARM_BASE, 640, true, Some(10_000), ARM_BASE);
        assert_eq!(bandit.select_arm(ARM_BASE, base_tier), ARM_BASE);
        bandit.record_navigation(ARM_BASE, 630, true, Some(10_200), ARM_BASE);
        assert!(bandit.reference_chars >= 10_000, "ref={}", bandit.reference_chars);

        // Pull 3 (3 % 8 == 3 -> bounded exploration): probes a faster feasible arm (dcl_200_top, tier 2 < 3)
        let explore1 = bandit.select_arm(ARM_BASE, base_tier);
        assert_ne!(explore1, ARM_BASE);
        // Suppose dcl_0_top fails content check on x.com/youtube (only 400 chars = 4% < 85% of 10,100)
        bandit.record_navigation(ARM_DCL_0_TOP, 110, true, Some(400), ARM_BASE);
        assert!(!bandit.arms[ARM_DCL_0_TOP].is_feasible(bandit.reference_chars));
        assert!(bandit.safe_fallback_pending, "premature unhydrated read must arm safe fallback");

        // Next pull MUST immediately fall back to safe/base arm and clear safe_fallback_pending!
        assert_eq!(bandit.select_arm(ARM_BASE, base_tier), ARM_BASE);
        assert!(!bandit.safe_fallback_pending);

        // Now record a faster arm (dcl_200_top) that delivers 9,500 chars (94% >= 85%) in 260ms (<< 630ms)!
        bandit.record_navigation(ARM_DCL_200_TOP, 260, true, Some(9_500), ARM_BASE);
        bandit.record_navigation(ARM_DCL_200_TOP, 270, true, Some(9_600), ARM_BASE);
        assert!(bandit.arms[ARM_DCL_200_TOP].is_feasible(bandit.reference_chars));

        // Exploitation pull selects the faster feasible arm dcl_200_top over slower base (630ms) and rejects infeasible dcl_0_top!
        let exploit_choice = bandit.peek_best_arm(ARM_BASE);
        assert_eq!(exploit_choice, ARM_DCL_200_TOP);

        // Verify 24-route LRU cap on SiteAccessProfile
        let mut prof = SiteAccessProfile::default();
        for idx in 0..30u64 {
            let _ = prof.ensure_route_bandit_mut(&format!("/route_{idx}"), 1_000 + idx);
        }
        assert_eq!(prof.route_controllers.len(), MAX_ROUTES_PER_SITE);
        assert!(!prof.route_controllers.contains_key("/route_0"));
        assert!(prof.route_controllers.contains_key("/route_29"));

        // End-to-end SiteLearner wire test: navigate -> snapshot contentChars -> explore -> reject <85% -> safe fallback!
        let mut learner = SiteLearner::default();
        let full_body = "x".repeat(4_000);
        for i in 1..=3 {
            let mut np = json!({ "tabId": 77, "url": format!("https://reddit.com/r/topic{i}/") });
            let cn = learner.prepare_request("s7", "page.navigate", &mut np);
            assert_eq!(cn.selected_route_key.as_deref(), Some("/r/:id"));
            assert_eq!(cn.selected_arm_id.as_deref(), Some(ARM_BASE));
            let mut rn = json!({ "tabId": 77, "url": format!("https://reddit.com/r/topic{i}/"), "loaded": true });
            let _ = learner.observe_response(&cn, true, Some(&mut rn), None);

            let mut sp = json!({ "tabId": 77 });
            let cs = learner.prepare_request("s7", "page.snapshot", &mut sp);
            let mut rs = json!({
                "tabId": 77,
                "text": format!("Tab 77: Reddit\nURL: https://reddit.com/r/topic{i}/\n{full_body}")
            });
            let _ = learner.observe_response(&cs, true, Some(&mut rs), None);
        }

        // Visit 4 (total_pulls == 3 -> exploration) selects a faster arm and injects its wire knobs
        let mut np4 = json!({ "tabId": 77, "url": "https://reddit.com/r/rust/" });
        let cn4 = learner.prepare_request("s7", "page.navigate", &mut np4);
        let explored_arm = cn4.selected_arm_id.clone().unwrap();
        assert_ne!(explored_arm, ARM_BASE);
        assert_eq!(np4["_siteProfile"]["preferredSnapshotFrames"], json!("top"));
        let mut rn4 = json!({ "tabId": 77, "url": "https://reddit.com/r/rust/", "loaded": true });
        let _ = learner.observe_response(&cn4, true, Some(&mut rn4), None);

        // Snapshot returns premature unhydrated 100-char stub (< 85% of 4,000) -> triggers safe_fallback_pending!
        let mut sp4 = json!({ "tabId": 77 });
        let cs4 = learner.prepare_request("s7", "page.snapshot", &mut sp4);
        let mut rs4 = json!({
            "tabId": 77,
            "text": "Tab 77: Reddit\nURL: https://reddit.com/r/rust/\nloading..."
        });
        let _ = learner.observe_response(&cs4, true, Some(&mut rs4), None);

        // Visit 5 automatically falls back to ARM_BASE!
        let mut np5 = json!({ "tabId": 77, "url": "https://reddit.com/r/golang/" });
        let cn5 = learner.prepare_request("s7", "page.navigate", &mut np5);
        assert_eq!(cn5.selected_arm_id.as_deref(), Some(ARM_BASE));

        // Caller maxChars-truncated snapshots and standalone warm snapshots never poison reference_chars or unpulled arms
        let mut rn5 = json!({
            "tabId": 77,
            "url": "https://reddit.com/r/golang/",
            "loaded": true,
            "_telemetry": { "domLoaded": true, "contentChars": 4_000 }
        });
        let _ = learner.observe_response(&cn5, true, Some(&mut rn5), None);
        let mut sp_trunc = json!({ "tabId": 77, "maxChars": 1000 });
        let cs_trunc = learner.prepare_request("s7", "page.snapshot", &mut sp_trunc);
        let mut rs_trunc = json!({
            "tabId": 77,
            "truncated": true,
            "text": format!("Tab 77: Reddit\nURL: https://reddit.com/r/golang/\n{}", "x".repeat(900)),
            "_telemetry": { "contentChars": 900, "truncated": true }
        });
        let _ = learner.observe_response(&cs_trunc, true, Some(&mut rs_trunc), None);
        let pb_after = learner.get_playbook("reddit.com").unwrap();
        let rb_after = pb_after.access_profile.route_controllers.get("/r/:id").unwrap();
        assert_eq!(rb_after.arms.get(ARM_BASE).unwrap().quality_violations, 0);
        assert_eq!(rb_after.reference_chars, 4_000);
    }

    #[test]
    fn field_level_provenance_refreshes_learned_on_seed_patch_and_preserves_user() {
        let _iso = ScopedTestRoutinesDir::new("provenance");

        // Built-in seed stamps FieldProvenance::Seed on non-default accessProfile fields
        let embedded_ppx = parse_embedded_playbook("perplexity.ai").unwrap();
        assert_eq!(
            embedded_ppx.access_profile.field_provenance.get("preferredWaitUntil"),
            Some(&FieldProvenance::Seed)
        );
        assert_eq!(
            embedded_ppx.access_profile.field_provenance.get("hydrationSettleMs"),
            Some(&FieldProvenance::Seed)
        );

        // Construct a commit seed profile to test healing commit -> domcontentloaded drift on PATCH upgrade
        let mut seed_prof = SiteAccessProfile {
            preferred_wait_until: Some("commit".into()),
            hydration_settle_ms: 150,
            preferred_snapshot_frames: Some("top".into()),
            ..Default::default()
        };
        seed_prof.stamp_seed_provenance();

        // Simulate a drifted local disk playbook (older than seed.verifiedAt) that has:
        // - Learned drift: preferredWaitUntil = "domcontentloaded", serviceWorkerNavigation = true, hydrationSettleMs = 600
        // - User lock: actionSettleMs = Some(175) with FieldProvenance::User
        let mut drifted = SitePlaybook::new("perplexity.ai");
        drifted.access_profile.preferred_wait_until = Some("domcontentloaded".into());
        drifted
            .access_profile
            .field_provenance
            .insert("preferredWaitUntil".into(), FieldProvenance::Learned);
        drifted.access_profile.service_worker_navigation = true;
        drifted
            .access_profile
            .field_provenance
            .insert("serviceWorkerNavigation".into(), FieldProvenance::Learned);
        drifted.access_profile.hydration_settle_ms = 600;
        drifted
            .access_profile
            .field_provenance
            .insert("hydrationSettleMs".into(), FieldProvenance::Learned);
        drifted.access_profile.action_settle_ms = Some(175);
        drifted
            .access_profile
            .field_provenance
            .insert("actionSettleMs".into(), FieldProvenance::User);

        // Merge newer seed overlay onto drifted disk profile (`seed.verifiedAt >= disk.updatedAt`)
        let mut merged_prof = drifted.access_profile.clone();
        merged_prof.merge_overlay(&seed_prof);

        assert_eq!(
            merged_prof.preferred_wait_until.as_deref(),
            Some("commit"),
            "Seed PATCH upgrade must heal Learned commit -> domcontentloaded drift"
        );
        assert!(
            !merged_prof.service_worker_navigation,
            "Seed PATCH upgrade must clear drifted Learned serviceWorkerNavigation"
        );
        assert_eq!(
            merged_prof.hydration_settle_ms,
            150,
            "Seed PATCH upgrade must reset drifted Learned hydrationSettleMs to seed value"
        );
        assert_eq!(
            merged_prof.action_settle_ms,
            Some(175),
            "User provenance field must be preserved across seed upgrades"
        );
        assert_eq!(
            merged_prof.field_provenance.get("actionSettleMs"),
            Some(&FieldProvenance::User)
        );

        // Also verify resetAccessProfile resets Learned fields to built-in seed defaults while preserving User fields & notes
        save_playbook(&drifted).unwrap();
        let (_, after_reset) = upsert_site_memory(
            "perplexity.ai",
            Some("Keep custom action settle"),
            None,
            None,
            true,
        )
        .unwrap();
        assert_eq!(
            after_reset.access_profile.preferred_wait_until,
            embedded_ppx.access_profile.preferred_wait_until
        );
        assert_eq!(after_reset.access_profile.action_settle_ms, Some(175));
        assert!(after_reset.notes.iter().any(|n| n == "Keep custom action settle"));
    }

    #[tokio::test]
    async fn execute_routine_auto_repairs_stale_query_and_degrades_gracefully_for_readonly() {
        let _iso = ScopedTestRoutinesDir::new("routine-repair");

        // 1. Query step fails on outdated selector `#legacy-serp`, semantic relocation tries landmark fallback,
        //    verifies post-condition (>=32 chars, non-CAPTCHA), and returns autoRepaired=true + repairedStep=0!
        let routine = RoutineDefinition {
            name: "read_results".to_string(),
            description: "Reads SERP results".to_string(),
            read_only: true,
            verified_at: Some("2026-11-17T09:45:00Z".into()),
            updated_at: Some("2026-11-17T09:45:00Z".into()),
            steps: vec![RoutineStep {
                op: "query".to_string(),
                params: json!({
                    "operation": "innerText",
                    "maxChars": 24000,
                    "locator": {
                        "steps": [
                            { "kind": "css", "value": "#legacy-serp-missing" },
                            { "kind": "nth", "index": 0 }
                        ]
                    }
                }),
                save_as: Some("results".into()),
                optional: false,
            }],
            ..Default::default()
        };
        upsert_site_memory("google.com", None, Some(routine.clone()), None, false).unwrap();

        let mut call_count = 0usize;
        let repaired_out = execute_routine_with_caller(
            &routine,
            &Map::new(),
            Some(5),
            true,
            |method, params| {
                call_count += 1;
                let attempt = call_count;
                async move {
                    assert_eq!(method, "page.query");
                    if attempt == 1 {
                        Err(BridgeError::Command {
                            code: "page_error".into(),
                            message: "No element matches the locator.".into(),
                        })
                    } else {
                        let sel = params["locator"]["steps"][0]["value"].as_str().unwrap_or("");
                        assert!(sel.contains("main") && sel.contains("#rcnt"), "unexpected fallback selector: {sel}");
                        Ok(json!({
                            "tabId": 5,
                            "url": "https://www.google.com/search?q=rust",
                            "value": "Rust Programming Language — Empowering everyone to build reliable and efficient software."
                        }))
                    }
                }
            },
        )
        .await
        .expect("semantic relocation must recover query step");

        assert_eq!(repaired_out["autoRepaired"], json!(true));
        assert_eq!(repaired_out["repairedStep"], json!(0));
        assert!(
            repaired_out["outputs"]["results"]
                .as_str()
                .unwrap_or("")
                .contains("Rust Programming Language")
        );

        // Repaired locator was persisted on disk!
        let saved_pb = resolve_playbook("google.com").unwrap();
        let saved_sel = saved_pb.routines["read_results"].steps[0].params["locator"]["steps"][0]["value"]
            .as_str()
            .unwrap_or("");
        assert!(saved_sel.contains("#rcnt"), "expected repaired selector on disk, got {saved_sel}");

        // 2. Post-condition rejects CAPTCHA boilerplate on relocation AND falls back to top-frame snapshot with _noLearn=true,
        //    while still recording consecutive failures toward [STALE]!
        let mut saw_no_learn_snapshot = false;
        for run_idx in 1..=2 {
            let deg_out = execute_routine_with_caller(
                &routine,
                &Map::new(),
                Some(5),
                true,
                |method, params| {
                    let is_snap = method == "page.snapshot";
                    let has_no_learn = params.get("_noLearn") == Some(&json!(true));
                    async move {
                        if is_snap {
                            assert!(has_no_learn, "fallback snapshot must pass _noLearn=true");
                            Ok(json!({
                                "tabId": 5,
                                "text": "Tab 5: Search\nURL: https://www.google.com/search?q=rust\n- heading \"Organic Result\" [ref=e1]"
                            }))
                        } else {
                            // Primary & relocation both fail (relocation returns /sorry/ bot boilerplate which post-condition rejects!)
                            let sel = params["locator"]["steps"][0]["value"].as_str().unwrap_or("");
                            if sel.contains("#rcnt") {
                                Ok(json!({
                                    "tabId": 5,
                                    "url": "https://www.google.com/sorry/index",
                                    "value": "Our systems have detected unusual traffic from your computer network."
                                }))
                            } else {
                                Err(BridgeError::Command {
                                    code: "page_error".into(),
                                    message: "No element matches the locator.".into(),
                                })
                            }
                        }
                    }
                },
            )
            .await
            .expect("read-only routine must return degradedFallback snapshot when strict != true");

            saw_no_learn_snapshot = true;
            assert_eq!(deg_out["degradedFallback"], json!(true));
            assert!(
                deg_out["outputs"]["fallbackSnapshot"]
                    .as_str()
                    .unwrap_or("")
                    .contains("Organic Result")
            );
            let pb_state = resolve_playbook("google.com").unwrap();
            assert_eq!(pb_state.routines["read_results"].consecutive_failures, run_idx);
            if run_idx == 2 {
                assert!(pb_state.routines["read_results"].stale, "2nd failure must mark routine [STALE]");
            }
        }
        assert!(saw_no_learn_snapshot);

        // With strict=true, read-only failure still returns Err
        let mut strict_args = Map::new();
        strict_args.insert("strict".into(), json!(true));
        let strict_res = execute_routine_with_caller(
            &routine,
            &strict_args,
            Some(5),
            true,
            |_method, _params| async move {
                Err(BridgeError::Command {
                    code: "page_error".into(),
                    message: "No element matches the locator.".into(),
                })
            },
        )
        .await;
        assert!(strict_res.is_err());

        // 3. Safety invariant: mutating step (e.g. click on "Delete") MUST NOT auto-relocate to heuristic substring text matches!
        let mutating_routine = RoutineDefinition {
            name: "dangerous_delete".to_string(),
            description: "Mutating click".to_string(),
            read_only: false,
            steps: vec![RoutineStep {
                op: "click".to_string(),
                params: json!({
                    "locator": {
                        "steps": [{ "kind": "role", "value": "button", "name": "Delete", "exact": true }]
                    }
                }),
                save_as: None,
                optional: false,
            }],
            ..Default::default()
        };
        let mut mut_calls = 0usize;
        let mut_res = execute_routine_with_caller(
            &mutating_routine,
            &Map::new(),
            Some(5),
            false,
            |_method, _params| {
                mut_calls += 1;
                async move {
                    Err(BridgeError::Command {
                        code: "page_error".into(),
                        message: "No element matches the locator.".into(),
                    })
                }
            },
        )
        .await;
        assert!(mut_res.is_err());
        assert_eq!(mut_calls, 1, "mutating step must never fire heuristic substring relocation retries");
    }

    #[test]
    fn safe_arm_strips_readiness_selector_and_disk_sync_preserves_external_routine_repairs() {
        let _iso = ScopedTestRoutinesDir::new("safe-arm-and-sync");

        // 1. ARM_SAFE_LOAD_ALL strips readinessSelector so fallback waits for load + genuine DOM quiet
        let mut prof = SiteAccessProfile {
            preferred_wait_until: Some("domcontentloaded".into()),
            hydration_settle_ms: 150,
            readiness_quiet_ms: Some(60),
            readiness_selector: Some("main, article".into()),
            preferred_snapshot_frames: Some("top".into()),
            ..Default::default()
        };
        prof.stamp_seed_provenance();
        let safe_wire = prof.runtime_wire_json_with_arm(now_epoch_s(), Some(ARM_SAFE_LOAD_ALL)).unwrap();
        assert_eq!(safe_wire["preferredWaitUntil"], json!("load"));
        assert_eq!(safe_wire["hydrationSettleMs"], json!(300));
        assert_eq!(safe_wire["preferredSnapshotFrames"], json!("all"));
        assert!(
            safe_wire.get("readinessSelector").is_none(),
            "ARM_SAFE_LOAD_ALL must omit readinessSelector so unhydrated shell selectors cannot short-circuit at 0ms"
        );

        // 2. Cross-process routine preservation: when native_host saves an older in-memory SitePlaybook,
        //    newer [STALE] / autoRepaired routine updates on disk are preserved!
        let mut host_mem = SitePlaybook::new("sync.example.test");
        host_mem.routines.insert(
            "read_feed".into(),
            RoutineDefinition {
                name: "read_feed".into(),
                read_only: true,
                updated_at: Some("2026-11-18T10:00:00Z".into()),
                steps: vec![RoutineStep {
                    op: "query".into(),
                    params: json!({ "locator": { "steps": [{ "kind": "css", "value": "#old" }] } }),
                    save_as: Some("feed".into()),
                    optional: false,
                }],
                ..Default::default()
            },
        );
        save_playbook(&host_mem).unwrap();

        // Simulate external MCP process repairing #old -> #new-repaired with newer timestamp on disk
        let mut mcp_disk = load_exact_playbook("sync.example.test").unwrap();
        let r = mcp_disk.routines.get_mut("read_feed").unwrap();
        r.steps[0].params = json!({ "locator": { "steps": [{ "kind": "css", "value": "#new-repaired" }] } });
        r.updated_at = Some("2026-11-20T18:00:00Z".into());
        r.last_succeeded_at = Some("2026-11-20T18:00:00Z".into());
        save_playbook(&mcp_disk).unwrap();

        // Native host now persists its older host_mem snapshot after a navigation stats update
        host_mem.access_profile.stats.navigations = 5;
        save_playbook_preserving_newer_disk_routines(&host_mem).unwrap();

        let final_disk = load_exact_playbook("sync.example.test").unwrap();
        assert_eq!(final_disk.access_profile.stats.navigations, 5);
        assert_eq!(
            final_disk.routines["read_feed"].steps[0].params["locator"]["steps"][0]["value"],
            json!("#new-repaired"),
            "host stats flush must not overwrite newer routine repairs on disk"
        );
    }

    #[test]
    fn redacted_activity_ring_log_strips_queries_credentials_and_caps_at_500() {
        let _iso = ScopedTestRoutinesDir::new("activity-log");

        // 1. SharePoint / OAuth query blobs, #hash tokens, user:pass@, and file:// user dirs are 100% stripped
        let sp = "https://contoso-my.sharepoint.com/:x:/g/personal/user_contoso_com/cQqDu9?nav=1&xsdata=SECRET_TOKEN_999#frag_secret";
        let red_sp = redact_url_for_activity_log(sp);
        assert_eq!(
            red_sp,
            "https://contoso-my.sharepoint.com/:x:/g/personal/user_contoso_com/cQqDu9"
        );
        assert!(!red_sp.contains("SECRET_TOKEN"));
        assert!(!red_sp.contains("frag_secret"));

        let cred_url = "https://admin:hunter2@internal.example.com:8443/api/v1/items?api_key=xyz";
        let red_cred = redact_url_for_activity_log(cred_url);
        assert_eq!(red_cred, "https://internal.example.com:8443/api/v1/items");
        assert!(!red_cred.contains("hunter2"));
        assert!(!red_cred.contains("xyz"));

        let file_url = "file:///C:/Users/secret_user/OneDrive/Confidential/Report.html?token=abc";
        let red_file = redact_url_for_activity_log(file_url);
        assert_eq!(red_file, "file:///Report.html");
        assert!(!red_file.contains("secret_user"));

        assert!(!should_log_activity_method("status"));
        assert!(!should_log_activity_method("tabs.inventory"));
        assert!(should_log_activity_method("page.snapshot"));

        // 2. Bounded ring compaction enforces <= 500 entries on disk
        for idx in 1..=530u64 {
            append_activity_log(&ActivityLogEntry {
                ts: "2026-11-20T19:00:00Z".into(),
                browser: "edge".into(),
                instance: "inst01".into(),
                session: "s1".into(),
                tab_id: Some(1671036640),
                method: "page.snapshot".into(),
                target: format!("https://contoso-my.sharepoint.com/doc/{idx}"),
                ok: true,
                ms: 74,
                error_code: None,
            });
        }
        let all = read_activity_log(1000);
        assert_eq!(all.len(), MAX_ACTIVITY_LOG_ENTRIES);
        assert_eq!(all.first().unwrap().target, "https://contoso-my.sharepoint.com/doc/31");
        assert_eq!(all.last().unwrap().target, "https://contoso-my.sharepoint.com/doc/530");
    }
}
