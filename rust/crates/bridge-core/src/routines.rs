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

pub fn routines_directory() -> PathBuf {
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
    !is_loopback_domain(domain)
        || std::env::var_os("BROWSER_BRIDGE_ROUTINES_DIR").is_some_and(|v| !v.is_empty())
}

/// Host-or-app canonical key for learned access profiles (strips leading `www.`, preserves `docs.google.com/document` vs `/spreadsheets`).
pub fn canonical_site_key(url_or_domain: &str) -> Option<String> {
    let extracted = extract_domain(url_or_domain)?;
    if extracted.contains('/') {
        return Some(extracted);
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
const MAX_BLOCKERS_PER_SITE: usize = 12;
const MAX_RECOVERIES_PER_SITE: usize = 16;

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
    #[serde(default)]
    pub known_blockers: Vec<String>,
    #[serde(default)]
    pub learned_recoveries: Vec<LearnedRecoveryRule>,
    #[serde(default)]
    pub stats: SitePerfStats,
}

impl SiteAccessProfile {
    pub fn effective_preferred_input(&self, now_s: u64) -> Option<&str> {
        let mode = self.preferred_input.as_deref()?;
        if mode == "dom" && now_s.saturating_sub(self.preferred_input_learned_at) >= INPUT_FALLBACK_TTL_S {
            return None;
        }
        Some(mode)
    }

    pub fn runtime_wire_json(&self) -> Option<Value> {
        let now_s = now_epoch_s();
        let mut map = Map::new();
        if let Some(w) = &self.preferred_wait_until {
            map.insert("preferredWaitUntil".into(), json!(w));
        }
        if self.service_worker_navigation {
            map.insert("serviceWorkerNavigation".into(), json!(true));
        }
        if self.hydration_settle_ms > 0 {
            map.insert("hydrationSettleMs".into(), json!(self.hydration_settle_ms));
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
        if map.is_empty() {
            None
        } else {
            Some(Value::Object(map))
        }
    }

    pub fn merge_overlay(&mut self, newer: &SiteAccessProfile) {
        if newer.preferred_wait_until.is_some() {
            self.preferred_wait_until = newer.preferred_wait_until.clone();
        }
        self.service_worker_navigation |= newer.service_worker_navigation;
        if newer.hydration_settle_ms > 0 {
            self.hydration_settle_ms = newer.hydration_settle_ms;
        }
        if newer.preferred_snapshot_frames.is_some() {
            self.preferred_snapshot_frames = newer.preferred_snapshot_frames.clone();
        }
        if newer.preferred_input.is_some() {
            self.preferred_input = newer.preferred_input.clone();
            self.preferred_input_learned_at = newer.preferred_input_learned_at;
        }
        if newer.action_settle_ms.is_some() {
            self.action_settle_ms = newer.action_settle_ms;
        }
        if newer.submit_settle_ms.is_some() {
            self.submit_settle_ms = newer.submit_settle_ms;
        }
        if newer.direct_http_blocked {
            self.direct_http_blocked = true;
            self.direct_http_status = newer.direct_http_status.or(self.direct_http_status);
        }
        self.requires_same_origin_fetch |= newer.requires_same_origin_fetch;
        self.dynamic_dom |= newer.dynamic_dom;
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
        if newer.stats.navigations > 0 || newer.stats.snapshots > 0 || newer.stats.in_page_actions > 0 {
            self.stats = newer.stats.clone();
        }
    }

    pub fn summary_lines(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut knobs = Vec::new();
        if let Some(w) = &self.preferred_wait_until {
            knobs.push(format!("waitUntil={w}"));
        }
        if self.service_worker_navigation {
            knobs.push("swCacheNav=fast(25ms)".to_string());
        }
        if self.hydration_settle_ms > 0 {
            knobs.push(format!("hydrationSettle={}ms", self.hydration_settle_ms));
        }
        if let Some(f) = &self.preferred_snapshot_frames {
            knobs.push(format!("snapshotFrames={f}"));
        }
        if let Some(inp) = self.effective_preferred_input(now_epoch_s()) {
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
    serde_json::from_str(raw).ok()
}

fn all_builtin_playbooks() -> Vec<SitePlaybook> {
    EMBEDDED_PLAYBOOK_JSONS
        .iter()
        .filter_map(|(_, raw)| serde_json::from_str::<SitePlaybook>(raw).ok())
        .collect()
}

fn builtin_playbook_for(domain: &str) -> Option<SitePlaybook> {
    if domain == "docs.google.com/document" {
        parse_embedded_playbook("docs.google.com/document")
    } else if domain == "docs.google.com/spreadsheets" || domain == "sheets.google.com" {
        parse_embedded_playbook("docs.google.com/spreadsheets")
    } else if domain == "mail.google.com" {
        parse_embedded_playbook("mail.google.com")
    } else if domain == "chatgpt.com" || domain.ends_with(".chatgpt.com") || domain == "chat.openai.com" {
        parse_embedded_playbook("chatgpt.com")
    } else if domain == "claude.ai" || domain.ends_with(".claude.ai") {
        parse_embedded_playbook("claude.ai")
    } else if domain == "perplexity.ai" || domain.ends_with(".perplexity.ai") {
        parse_embedded_playbook("perplexity.ai")
    } else if domain == "diagrams.net" || domain.ends_with(".diagrams.net") || domain == "draw.io" || domain.ends_with(".draw.io") {
        parse_embedded_playbook("diagrams.net")
    } else if domain == "google.com" || domain == "www.google.com" {
        parse_embedded_playbook("google.com")
    } else if domain == "youtube.com" || domain == "www.youtube.com" || domain == "m.youtube.com" {
        parse_embedded_playbook("youtube.com")
    } else if domain == "github.com" || domain == "www.github.com" || domain == "gist.github.com" {
        parse_embedded_playbook("github.com")
    } else if domain == "wikipedia.org" || domain.ends_with(".wikipedia.org") {
        parse_embedded_playbook("wikipedia.org")
    } else if domain == "reddit.com" || domain.ends_with(".reddit.com") {
        parse_embedded_playbook("reddit.com")
    } else if domain == "x.com" || domain.ends_with(".x.com") || domain == "twitter.com" || domain.ends_with(".twitter.com") {
        parse_embedded_playbook("x.com")
    } else if domain == "linkedin.com" || domain.ends_with(".linkedin.com") {
        parse_embedded_playbook("linkedin.com")
    } else if domain == "notion.so" || domain.ends_with(".notion.so") || domain == "notion.com" || domain.ends_with(".notion.site") {
        parse_embedded_playbook("notion.so")
    } else if domain == "arxiv.org" || domain.ends_with(".arxiv.org") {
        parse_embedded_playbook("arxiv.org")
    } else if domain == "huggingface.co" || domain.ends_with(".huggingface.co") {
        parse_embedded_playbook("huggingface.co")
    } else if domain == "npmjs.com" || domain == "www.npmjs.com" {
        parse_embedded_playbook("npmjs.com")
    } else if domain == "pypi.org" || domain.ends_with(".pypi.org") {
        parse_embedded_playbook("pypi.org")
    } else if domain == "medium.com" || domain.ends_with(".medium.com") {
        parse_embedded_playbook("medium.com")
    } else if domain == "stackoverflow.com"
        || domain.ends_with(".stackoverflow.com")
        || domain.ends_with(".stackexchange.com")
        || domain == "superuser.com"
        || domain == "serverfault.com"
        || domain == "askubuntu.com"
    {
        parse_embedded_playbook("stackoverflow.com")
    } else if domain == "amazon.com" || domain == "www.amazon.com" {
        parse_embedded_playbook("amazon.com")
    } else if domain == "news.ycombinator.com" {
        parse_embedded_playbook("news.ycombinator.com")
    } else if domain == "finance.yahoo.com" {
        parse_embedded_playbook("finance.yahoo.com")
    } else {
        None
    }
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
    std::fs::write(&path, format!("{pretty}\n")).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(path)
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
            entry.domain = disk.domain;
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
    }
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
    if blocked {
        pb.access_profile.direct_http_blocked = true;
        pb.access_profile.direct_http_status = status;
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
        pb.access_profile = SiteAccessProfile::default();
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
                let stale_prefix = if r.stale { "[STALE] " } else { "" };
                if args.is_empty() {
                    format!("{stale_prefix}{}", r.name)
                } else {
                    format!("{stale_prefix}{}({})", r.name, args.join(", "))
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
    pub explicit_wait_until: bool,
    pub started_at: Instant,
}

#[derive(Debug, Clone)]
struct PendingRecovery {
    failed_method: String,
    failed_target: String,
    error_code: String,
    blocker: String,
    candidate_recovery: Option<(String, String, Value)>,
}

/// Universal gateway learner that observes all browser commands, errors, and telemetry across MCP, Python, RPC, and UI,
/// dynamically optimizing per-site navigation, snapshot, input delivery, and settle parameters.
#[derive(Default)]
pub struct SiteLearner {
    pub session_tabs: HashMap<String, i64>,
    pub tab_urls: HashMap<i64, String>,
    last_nav_at: HashMap<i64, (Instant, String)>,
    last_action_at: HashMap<i64, (Instant, String)>,
    pending_recovery: HashMap<i64, PendingRecovery>,
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

    pub fn close_session(&mut self, session_id: &str) {
        self.session_tabs.remove(session_id);
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
        if reset_access_profile {
            self.playbooks.remove(&key);
        }
        if should_persist_domain(&key) {
            let (path, merged) =
                upsert_site_memory(&key, note, routine, delete_routine, reset_access_profile)?;
            self.playbooks.insert(key, merged.clone());
            Ok((Some(path), merged))
        } else {
            let _ = self.ensure_loaded(&key);
            let pb = self.playbooks.get_mut(&key).unwrap();
            if reset_access_profile {
                pb.access_profile = SiteAccessProfile::default();
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
        let mut dirty = false;
        if blocked {
            if !pb.access_profile.direct_http_blocked || pb.access_profile.direct_http_status != status {
                pb.access_profile.direct_http_blocked = true;
                pb.access_profile.direct_http_status = status;
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
        let explicit_tab = params.get("tabId").and_then(Value::as_i64);
        let effective_tab = explicit_tab.or_else(|| self.session_tabs.get(session_id).copied());
        let explicit_wait_until = params.get("waitUntil").and_then(Value::as_str).is_some();
        let url_hint = if matches!(method, "page.navigate" | "tabs.new") {
            params.get("url").and_then(Value::as_str).map(str::to_string)
        } else {
            effective_tab.and_then(|tid| self.tab_urls.get(&tid).cloned())
        };
        let target_summary = summarize_target(params);
        let sanitized_params = sanitize_recovery_params(params);

        if matches!(method, "tabs.new") || method.starts_with("page.") {
            if let Some(hint) = url_hint.as_deref() {
                if let Some(key) = self.ensure_loaded(hint) {
                    if let Some(wire) = self
                        .playbooks
                        .get(&key)
                        .and_then(|pb| pb.access_profile.runtime_wire_json())
                    {
                        if let Some(obj) = params.as_object_mut() {
                            obj.entry("_siteProfile").or_insert(wire);
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
            explicit_wait_until,
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
                self.tab_urls.remove(&closed_id);
                self.last_nav_at.remove(&closed_id);
                self.last_action_at.remove(&closed_id);
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
        if resolved_url.is_none() {
            if let Some(tid) = resolved_tab {
                resolved_url = self.tab_urls.get(&tid).cloned();
            }
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
                                if !fpb.access_profile.requires_same_origin_fetch {
                                    fpb.access_profile.requires_same_origin_fetch = true;
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

        let recent_nav = resolved_tab
            .and_then(|tid| self.last_nav_at.get(&tid))
            .is_some_and(|(t, d)| d == &key && t.elapsed() <= Duration::from_secs(4));
        let recent_action = resolved_tab
            .and_then(|tid| self.last_action_at.get(&tid))
            .is_some_and(|(t, d)| d == &key && t.elapsed() <= Duration::from_secs(3));

        let mut dirty = false;

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

                        if sw_no_headers && !prof.service_worker_navigation {
                            prof.service_worker_navigation = true;
                            dirty = true;
                        }
                        if load_timed_out && dom_loaded {
                            prof.stats.load_timeouts += 1;
                            if prof.preferred_wait_until.as_deref() != Some("domcontentloaded") {
                                prof.preferred_wait_until = Some("domcontentloaded".to_string());
                                learned_pitfall = Some((
                                    "load_timeout",
                                    "window.onload stalled after DOMContentLoaded; auto-switched default waitUntil to domcontentloaded.".to_string(),
                                ));
                                dirty = true;
                            }
                        } else if let (Some(d_ms), Some(l_ms)) = (dom_ms, load_ms) {
                            if l_ms.saturating_sub(d_ms) >= 4_000 {
                                prof.stats.slow_load_tails += 1;
                                if prof.preferred_wait_until.as_deref() != Some("domcontentloaded") {
                                    prof.preferred_wait_until = Some("domcontentloaded".to_string());
                                    dirty = true;
                                }
                            }
                        }
                    } else if call.method == "page.snapshot" {
                        prof.stats.snapshots += 1;
                        prof.stats.avg_snapshot_ms = update_ema(prof.stats.avg_snapshot_ms, duration_ms);
                        let vis_iframes = telemetry.get("visibleIframes").and_then(Value::as_u64).unwrap_or(0);
                        let child_scanned = telemetry.get("childFramesScanned").and_then(Value::as_u64).unwrap_or(0);
                        let non_empty_child = telemetry.get("nonEmptyChildFrames").and_then(Value::as_u64).unwrap_or(0);

                        if non_empty_child > 0 && prof.preferred_snapshot_frames.is_some() {
                            prof.preferred_snapshot_frames = None;
                            dirty = true;
                        } else if vis_iframes > 0 && child_scanned > 0 && non_empty_child == 0 {
                            prof.stats.empty_multiframe_snapshots += 1;
                            if prof.stats.empty_multiframe_snapshots >= 2
                                && prof.preferred_snapshot_frames.as_deref() != Some("top")
                            {
                                prof.preferred_snapshot_frames = Some("top".to_string());
                                dirty = true;
                            }
                        }
                    } else if matches!(
                        call.method.as_str(),
                        "page.click" | "page.type" | "page.press" | "page.hover" | "page.drag" | "page.select" | "page.check"
                    ) {
                        if telemetry.get("cdpFallback").and_then(Value::as_bool) == Some(true) {
                            prof.stats.cdp_fallbacks += 1;
                            if prof.preferred_input.as_deref() != Some("dom") {
                                prof.preferred_input = Some("dom".to_string());
                                prof.preferred_input_learned_at = now_epoch_s();
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
                                if prof.submit_settle_ms == Some(80) {
                                    prof.submit_settle_ms = None;
                                    dirty = true;
                                }
                            } else {
                                prof.stats.in_page_actions += 1;
                                if prof.stats.in_page_actions >= 3
                                    && prof.stats.navigating_actions == 0
                                    && prof.stats.not_ready_errors == 0
                                    && prof.submit_settle_ms.is_none()
                                {
                                    prof.submit_settle_ms = Some(80);
                                    dirty = true;
                                }
                            }
                        }
                    }
                }
                if let Some((p_code, p_msg)) = learned_pitfall {
                    let _ = append_pitfall_in_memory(pb, p_code, &call.method, &call.target_summary, &p_msg);
                }

                if duration_ms >= 5_000 && call.method != "page.waitFor" && !call.explicit_wait_until {
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
                if matches!(call.method.as_str(), "page.navigate" | "tabs.new") {
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
                                    last_verified_epoch_s: now_epoch_s(),
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
                            prof.stats.load_timeouts += 1;
                            if prof.preferred_wait_until.as_deref() != Some("domcontentloaded") {
                                prof.preferred_wait_until = Some("domcontentloaded".to_string());
                                dirty = true;
                            }
                        } else if recent_nav && call.method != "page.waitFor" {
                            let next_settle = (prof.hydration_settle_ms + 200).clamp(200, 600);
                            if next_settle != prof.hydration_settle_ms {
                                prof.hydration_settle_ms = next_settle;
                                dirty = true;
                            }
                        }
                    }
                    "stale_ref" => {
                        prof.stats.stale_ref_errors += 1;
                        if !prof.dynamic_dom && (prof.stats.stale_ref_errors >= 2 || recent_nav) {
                            prof.dynamic_dom = true;
                            dirty = true;
                        }
                        if recent_nav {
                            let next_settle = (prof.hydration_settle_ms + 200).clamp(200, 600);
                            if next_settle != prof.hydration_settle_ms {
                                prof.hydration_settle_ms = next_settle;
                                dirty = true;
                            }
                        }
                    }
                    "not_ready" => {
                        prof.stats.not_ready_errors += 1;
                        if recent_action {
                            if prof.action_settle_ms != Some(240) {
                                prof.action_settle_ms = Some(240);
                                prof.submit_settle_ms = Some(1200);
                                dirty = true;
                            }
                        } else if recent_nav {
                            let next_settle = (prof.hydration_settle_ms + 250).clamp(250, 600);
                            if next_settle != prof.hydration_settle_ms {
                                prof.hydration_settle_ms = next_settle;
                                dirty = true;
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
                let now = now_epoch_s();
                pb.updated_at_epoch_s = now;
                pb.updated_at = epoch_to_iso8601(now);
                if should_persist_domain(&key) {
                    return Some(pb.clone());
                }
            }
        }
        None
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

/// Executes a named routine step-by-step directly over IPC in Rust (~1 ms dispatch overhead per step).
pub async fn execute_routine(
    client: &BridgeClient,
    routine: &RoutineDefinition,
    arguments: &Map<String, Value>,
    tab_id: Option<i64>,
    browser: Option<&str>,
    enforce_read_only: bool,
) -> Result<Value, String> {
    if enforce_read_only && !routine.read_only {
        return Err(format!(
            "Routine '{}' modifies page state and cannot run in read-only mode. [read_only]",
            routine.name
        ));
    }

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
        if let Ok((info, _)) = client
            .send("page.info", Value::Object(info_p), browser, Duration::from_secs(10))
            .await
        {
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
        }

        let step_start = Instant::now();
        match client
            .send(method, p_val, browser, Duration::from_secs(60))
            .await
        {
            Ok((res, _)) => {
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
                let err_str = err.to_string();
                if !observed_domain.is_empty() {
                    record_routine_outcome_on_disk(&observed_domain, &routine.name, false, Some(&err_str));
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

    Ok(json!({
        "routine": routine.name,
        "tabId": active_tab,
        "elapsedMs": started.elapsed().as_millis() as u64,
        "stepsExecuted": step_log.len(),
        "steps": step_log,
        "outputs": outputs,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_subdomain_to_builtin_diagrams_net_playbook() {
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

        // Verify consecutive selector failures flag routine stale=true (website redesign detection) in isolated temp dir
        let tmp_dir = std::env::temp_dir().join(format!("bb-routines-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        unsafe {
            std::env::set_var("BROWSER_BRIDGE_ROUTINES_DIR", &tmp_dir);
        }
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
        unsafe {
            std::env::remove_var("BROWSER_BRIDGE_ROUTINES_DIR");
        }
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn learner_adapts_wait_until_hydration_input_and_error_recovery() {
        let mut learner = SiteLearner::default();

        // 1. Stalled window.onload on Visit 1 -> learns preferredWaitUntil = "domcontentloaded" and strips _telemetry
        let mut nav_params = json!({ "tabId": 7, "url": "https://help.example.test/docs" });
        let call1 = learner.prepare_request("s1", "page.navigate", &mut nav_params);
        assert!(nav_params.get("_siteProfile").is_none());
        let mut nav_res = json!({
            "tabId": 7,
            "url": "https://help.example.test/docs",
            "loaded": true,
            "_telemetry": { "domLoaded": true, "loadTimedOut": true, "domLoadedMs": 320 }
        });
        let _ = learner.observe_response(&call1, true, Some(&mut nav_res), None);
        assert!(nav_res.get("_telemetry").is_none(), "_telemetry must be stripped before forwarding");

        // Visit 2 automatically injects _siteProfile.preferredWaitUntil = "domcontentloaded"
        let mut nav_params2 = json!({ "tabId": 7, "url": "https://help.example.test/docs/2" });
        let _ = learner.prepare_request("s1", "page.navigate", &mut nav_params2);
        assert_eq!(
            nav_params2["_siteProfile"]["preferredWaitUntil"],
            json!("domcontentloaded")
        );

        // 2. Immediate post-navigation stale_ref -> learns hydrationSettleMs + dynamicDom
        let mut click_stale = json!({ "ref": "e4" });
        let call_stale = learner.prepare_request("s1", "page.click", &mut click_stale);
        let stale_err = json!({ "code": "stale_ref", "message": "Stale element ref e4." });
        let _ = learner.observe_response(&call_stale, false, None, Some(&stale_err));

        let pb_after_stale = learner.get_playbook("help.example.test").unwrap();
        assert!(pb_after_stale.access_profile.dynamic_dom);
        assert_eq!(pb_after_stale.access_profile.hydration_settle_ms, 200);

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
            "url": "https://help.example.test/docs",
            "navigated": false,
            "_telemetry": { "cdpFallback": true }
        });
        let _ = learner.observe_response(&call_dismiss, true, Some(&mut dismiss_res), None);

        // Agent takes an intermediate snapshot (must NOT wipe pending recovery!)
        let mut snap_params = json!({});
        let call_snap = learner.prepare_request("s1", "page.snapshot", &mut snap_params);
        let mut snap_res = json!({
            "tabId": 7,
            "text": "Tab 7: Docs\nURL: https://help.example.test/docs\n- button \"Checkout\" [ref=e9]"
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
            "url": "https://help.example.test/docs",
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
}
