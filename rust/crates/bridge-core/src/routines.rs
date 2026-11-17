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

fn now_epoch_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn routines_directory() -> PathBuf {
    if let Some(custom) = std::env::var_os("BROWSER_BRIDGE_ROUTINES_DIR") {
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    data_directory().join("routines")
}

/// Extracts a clean lowercase hostname from a URL or raw domain string.
pub fn extract_domain(url_or_domain: &str) -> Option<String> {
    let trimmed = url_or_domain.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_scheme = if let Some((_, rest)) = trimmed.split_once("://") {
        rest
    } else {
        trimmed
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
        None
    } else {
        Some(clean)
    }
}

pub fn is_loopback_domain(domain: &str) -> bool {
    domain == "localhost"
        || domain
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| ip.is_loopback())
}

pub fn should_persist_domain(domain: &str) -> bool {
    !is_loopback_domain(domain)
        || std::env::var_os("BROWSER_BRIDGE_ROUTINES_DIR").is_some_and(|v| !v.is_empty())
}

/// Host-level canonical key for learned access profiles (strips leading `www.` while keeping distinct app subdomains).
pub fn canonical_site_key(url_or_domain: &str) -> Option<String> {
    let host = extract_domain(url_or_domain)?;
    if let Some(stripped) = host.strip_prefix("www.") {
        if stripped.contains('.') {
            return Some(stripped.to_string());
        }
    }
    Some(host)
}

/// Returns candidate lookup domains from most specific to registrable base (e.g. `["app.diagrams.net", "diagrams.net"]`).
pub fn domain_candidates(url_or_domain: &str) -> Vec<String> {
    let Some(host) = extract_domain(url_or_domain) else {
        return Vec::new();
    };
    let mut out = vec![host.clone()];
    if is_loopback_domain(&host) {
        return out;
    }
    if let Some(stripped) = host.strip_prefix("www.") {
        if stripped.contains('.') && !out.contains(&stripped.to_string()) {
            out.push(stripped.to_string());
        }
    }
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() >= 3 {
        let tail2 = format!("{}.{}", parts[parts.len() - 2], parts[parts.len() - 1]);
        if tail2.len() >= 5 && !out.contains(&tail2) {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub read_only: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SitePlaybook {
    pub domain: String,
    pub updated_at_epoch_s: u64,
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
        Self {
            domain: domain.into(),
            updated_at_epoch_s: now_epoch_s(),
            access_profile: SiteAccessProfile::default(),
            notes: Vec::new(),
            pitfalls: Vec::new(),
            routines: BTreeMap::new(),
        }
    }
}

fn builtin_diagrams_net() -> SitePlaybook {
    let mut pb = SitePlaybook::new("diagrams.net");
    pb.access_profile.service_worker_navigation = true;
    pb.access_profile.submit_settle_ms = Some(80);
    pb.notes = vec![
        "SVG diagram nodes and connector labels appear directly in browser_snapshot as role=\"shape\" with clickable, double-clickable, and draggable [ref=e...] handles.".to_string(),
        "For lossless diagram reading or generating/editing multi-node diagrams, run routine \"read_diagram_xml\" or \"write_diagram_xml\" (~250 ms in 1 call via Extras -> Edit Diagram) instead of dozens of manual canvas clicks.".to_string(),
        "Inserting or double-clicking a shape focuses the inline \"Edit Text\" box; press Escape before clicking top menubar items (File, Edit, Extras).".to_string(),
    ];

    pb.routines.insert(
        "read_diagram_xml".to_string(),
        RoutineDefinition {
            name: "read_diagram_xml".to_string(),
            description: "Opens Extras -> Edit Diagram, reads the complete <mxGraphModel> XML into outputs.xml, and closes the dialog cleanly via Cancel.".to_string(),
            read_only: false,
            params: BTreeMap::new(),
            steps: vec![
                RoutineStep {
                    op: "press".into(),
                    params: json!({ "key": "Escape" }),
                    save_as: None,
                    optional: true,
                },
                RoutineStep {
                    op: "click".into(),
                    params: json!({
                        "locator": { "steps": [{ "kind": "role", "value": "button", "name": "Extras", "exact": true }] }
                    }),
                    save_as: None,
                    optional: false,
                },
                RoutineStep {
                    op: "click".into(),
                    params: json!({
                        "locator": { "steps": [{ "kind": "role", "value": "menuitem", "name": "Edit Diagram..." }] }
                    }),
                    save_as: None,
                    optional: false,
                },
                RoutineStep {
                    op: "query".into(),
                    params: json!({
                        "operation": "inputValue",
                        "maxChars": 100000,
                        "locator": {
                            "steps": [
                                { "kind": "role", "value": "dialog", "name": "Edit Diagram" },
                                { "kind": "css", "value": "textarea" }
                            ]
                        }
                    }),
                    save_as: Some("xml".into()),
                    optional: false,
                },
                RoutineStep {
                    op: "click".into(),
                    params: json!({
                        "locator": {
                            "steps": [
                                { "kind": "role", "value": "dialog", "name": "Edit Diagram" },
                                { "kind": "role", "value": "button", "name": "Cancel", "exact": true }
                            ]
                        }
                    }),
                    save_as: None,
                    optional: false,
                },
            ],
        },
    );

    let mut write_params = BTreeMap::new();
    write_params.insert(
        "xml".to_string(),
        RoutineParamSpec {
            kind: "string".to_string(),
            description: "Complete <mxGraphModel>...</mxGraphModel> XML for the active page.".to_string(),
            required: true,
            default: None,
        },
    );
    pb.routines.insert(
        "write_diagram_xml".to_string(),
        RoutineDefinition {
            name: "write_diagram_xml".to_string(),
            description: "Replaces the active draw.io page diagram with the supplied <mxGraphModel> XML in one fast step via Extras -> Edit Diagram -> Apply.".to_string(),
            read_only: false,
            params: write_params,
            steps: vec![
                RoutineStep {
                    op: "press".into(),
                    params: json!({ "key": "Escape" }),
                    save_as: None,
                    optional: true,
                },
                RoutineStep {
                    op: "click".into(),
                    params: json!({
                        "locator": { "steps": [{ "kind": "role", "value": "button", "name": "Extras", "exact": true }] }
                    }),
                    save_as: None,
                    optional: false,
                },
                RoutineStep {
                    op: "click".into(),
                    params: json!({
                        "locator": { "steps": [{ "kind": "role", "value": "menuitem", "name": "Edit Diagram..." }] }
                    }),
                    save_as: None,
                    optional: false,
                },
                RoutineStep {
                    op: "type".into(),
                    params: json!({
                        "text": "{{xml}}",
                        "clear": true,
                        "locator": {
                            "steps": [
                                { "kind": "role", "value": "dialog", "name": "Edit Diagram" },
                                { "kind": "css", "value": "textarea" }
                            ]
                        }
                    }),
                    save_as: None,
                    optional: false,
                },
                RoutineStep {
                    op: "click".into(),
                    params: json!({
                        "locator": {
                            "steps": [
                                { "kind": "role", "value": "dialog", "name": "Edit Diagram" },
                                { "kind": "role", "value": "button", "name": "Apply", "exact": true }
                            ]
                        }
                    }),
                    save_as: None,
                    optional: false,
                },
            ],
        },
    );

    let mut shape_params = BTreeMap::new();
    shape_params.insert(
        "shape".to_string(),
        RoutineParamSpec {
            kind: "string".to_string(),
            description: "Sidebar shape button name (e.g. Rectangle, Rounded Rectangle, Diamond, Cylinder, Cloud, Actor).".to_string(),
            required: false,
            default: Some(json!("Rectangle")),
        },
    );
    shape_params.insert(
        "label".to_string(),
        RoutineParamSpec {
            kind: "string".to_string(),
            description: "Text label to write inside the newly inserted shape.".to_string(),
            required: false,
            default: Some(json!("")),
        },
    );
    pb.routines.insert(
        "insert_shape".to_string(),
        RoutineDefinition {
            name: "insert_shape".to_string(),
            description: "Searches for any shape by name in draw.io's sidebar, inserts it onto the canvas, writes its text label, and exits inline editing.".to_string(),
            read_only: false,
            params: shape_params,
            steps: vec![
                RoutineStep {
                    op: "press".into(),
                    params: json!({ "key": "Escape" }),
                    save_as: None,
                    optional: true,
                },
                RoutineStep {
                    op: "click".into(),
                    params: json!({
                        "timeoutMs": 300,
                        "locator": {
                            "steps": [
                                { "kind": "css", "value": "body:has(.geSidebarContainer[style*=\"width: 0px\"])" },
                                { "kind": "role", "value": "button", "name": "View", "exact": true }
                            ]
                        }
                    }),
                    save_as: None,
                    optional: true,
                },
                RoutineStep {
                    op: "click".into(),
                    params: json!({
                        "timeoutMs": 400,
                        "locator": { "steps": [{ "kind": "role", "value": "menuitem", "name": "Shapes Ctrl+Shift+K" }] }
                    }),
                    save_as: None,
                    optional: true,
                },
                RoutineStep {
                    op: "type".into(),
                    params: json!({
                        "text": "{{shape}}",
                        "clear": true,
                        "submit": true,
                        "locator": { "steps": [{ "kind": "role", "value": "textbox", "name": "Type / to search" }] }
                    }),
                    save_as: None,
                    optional: false,
                },
                RoutineStep {
                    op: "click".into(),
                    params: json!({
                        "locator": {
                            "steps": [
                                { "kind": "role", "value": "button", "name": "{{shape}}", "exact": true },
                                { "kind": "nth", "index": 0 }
                            ]
                        }
                    }),
                    save_as: None,
                    optional: false,
                },
                RoutineStep {
                    op: "press".into(),
                    params: json!({
                        "key": "Enter",
                        "timeoutMs": 1500,
                        "locator": { "steps": [{ "kind": "role", "value": "textbox", "name": "Edit Text" }] }
                    }),
                    save_as: None,
                    optional: true,
                },
                RoutineStep {
                    op: "type".into(),
                    params: json!({
                        "text": "{{label}}",
                        "clear": true,
                        "timeoutMs": 3000,
                        "locator": { "steps": [{ "kind": "css", "value": ".mxCellEditor" }] }
                    }),
                    save_as: None,
                    optional: true,
                },
                RoutineStep {
                    op: "press".into(),
                    params: json!({ "key": "Escape" }),
                    save_as: None,
                    optional: true,
                },
                RoutineStep {
                    op: "click".into(),
                    params: json!({
                        "timeoutMs": 500,
                        "locator": { "steps": [{ "kind": "role", "value": "button", "name": "Reset", "exact": true }] }
                    }),
                    save_as: None,
                    optional: true,
                },
            ],
        },
    );

    pb.routines.insert(
        "add_page".to_string(),
        RoutineDefinition {
            name: "add_page".to_string(),
            description: "Creates and activates a new page tab in the current draw.io diagram.".to_string(),
            read_only: false,
            params: BTreeMap::new(),
            steps: vec![
                RoutineStep {
                    op: "press".into(),
                    params: json!({ "key": "Escape" }),
                    save_as: None,
                    optional: true,
                },
                RoutineStep {
                    op: "click".into(),
                    params: json!({
                        "locator": { "steps": [{ "kind": "role", "value": "button", "name": "Insert Page", "exact": true }] }
                    }),
                    save_as: None,
                    optional: false,
                },
            ],
        },
    );

    pb
}

fn builtin_playbook_for(domain: &str) -> Option<SitePlaybook> {
    if domain == "diagrams.net" || domain.ends_with(".diagrams.net") || domain == "draw.io" || domain.ends_with(".draw.io") {
        Some(builtin_diagrams_net())
    } else {
        None
    }
}

fn playbook_path(domain: &str) -> PathBuf {
    routines_directory().join(format!("{domain}.json"))
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
    let path = dir.join(format!("{clean_domain}.json"));
    let mut normalized = playbook.clone();
    normalized.domain = clean_domain;
    normalized.updated_at_epoch_s = now_epoch_s();
    let pretty = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{pretty}\n")).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(path)
}

/// Loads merged playbook for a URL or domain (combining built-in seed routines with user/agent saved routines & pitfalls).
pub fn resolve_playbook(url_or_domain: &str) -> Option<SitePlaybook> {
    let candidates = domain_candidates(url_or_domain);
    if candidates.is_empty() {
        return None;
    }
    let primary = candidates[0].clone();
    let mut merged: Option<SitePlaybook> = None;

    for cand in candidates.iter().rev() {
        if let Some(seed) = builtin_playbook_for(cand) {
            merged = Some(seed);
        }
    }
    for cand in candidates.iter().rev() {
        if let Some(disk) = load_exact_playbook(cand) {
            let entry = merged.get_or_insert_with(|| SitePlaybook::new(disk.domain.clone()));
            entry.domain = disk.domain;
            entry.updated_at_epoch_s = entry.updated_at_epoch_s.max(disk.updated_at_epoch_s);
            entry.access_profile.merge_overlay(&disk.access_profile);
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
            for (k, r) in disk.routines {
                entry.routines.insert(k, r);
            }
        }
    }
    if let Some(pb) = &mut merged {
        if pb.domain.is_empty() {
            pb.domain = primary;
        }
    }
    merged
}

pub fn list_all_playbooks() -> Vec<SitePlaybook> {
    let mut by_domain: BTreeMap<String, SitePlaybook> = BTreeMap::new();
    let seed = builtin_diagrams_net();
    by_domain.insert(seed.domain.clone(), seed);

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
    if let Some(r) = routine {
        if r.name.trim().is_empty() || r.steps.is_empty() {
            return Err("Routine requires a non-empty name and at least one step.".to_string());
        }
        pb.routines.insert(r.name.trim().to_string(), r);
    }
    let path = save_playbook(&pb)?;
    let merged = resolve_playbook(&target_domain).unwrap_or(pb);
    Ok((path, merged))
}

pub fn format_site_memory_hint_from_playbook(pb: &SitePlaybook) -> Option<String> {
    let perf_lines = pb.access_profile.summary_lines();
    if pb.routines.is_empty() && pb.notes.is_empty() && pb.pitfalls.is_empty() && perf_lines.is_empty() {
        return None;
    }
    let mut lines = vec![format!("\n[Site Memory & Fast Routines — {}]", pb.domain)];
    for pl in perf_lines.iter().take(3) {
        lines.push(pl.clone());
    }
    if !pb.routines.is_empty() {
        let summary: Vec<String> = pb
            .routines
            .values()
            .map(|r| {
                let args: Vec<&str> = r.params.keys().map(String::as_str).collect();
                if args.is_empty() {
                    r.name.clone()
                } else {
                    format!("{}({})", r.name, args.join(", "))
                }
            })
            .collect();
        lines.push(format!(
            "Available routines (call browser_routine_run to execute in 1 step): {}",
            summary.join(" | ")
        ));
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
                pb.updated_at_epoch_s = now_epoch_s();
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
            | "page.webmcp.list"
    )
}

fn interpolate_value(template: &Value, vars: &Map<String, Value>) -> Value {
    match template {
        Value::String(s) => {
            if let Some(inner) = s.strip_prefix("{{").and_then(|rest| rest.strip_suffix("}}")) {
                let key = inner.trim();
                if !key.contains('{') && !key.contains('}') {
                    if let Some(exact) = vars.get(key) {
                        return exact.clone();
                    }
                }
            }
            let mut rendered = s.clone();
            for (k, v) in vars {
                let token = format!("{{{{{k}}}}}");
                if rendered.contains(&token) {
                    let rep = match v {
                        Value::String(vs) => vs.clone(),
                        Value::Null => String::new(),
                        other => other.to_string(),
                    };
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
    for (name, spec) in &routine.params {
        if let Some(val) = arguments.get(name) {
            vars.insert(name.clone(), val.clone());
        } else if let Some(def) = &spec.default {
            vars.insert(name.clone(), def.clone());
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
    let mut active_tab = tab_id;

    for (idx, step) in routine.steps.iter().enumerate() {
        let method = canonical_step_method(&step.op)?;
        if enforce_read_only && !is_read_safe_step(method) {
            return Err(format!(
                "Step {} ({method}) is not allowed in read-only mode. [read_only]",
                idx + 1
            ));
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
            .send(method, p_val, browser, Duration::from_secs(45))
            .await
        {
            Ok((res, _)) => {
                if active_tab.is_none() {
                    active_tab = res.get("tabId").and_then(Value::as_i64);
                }
                if let Some(out_key) = &step.save_as {
                    let extracted = if let Some(v) = res.get("value") {
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
                return Err(format!(
                    "Routine '{}' failed at step {} ({}): {}",
                    routine.name,
                    idx + 1,
                    step.op,
                    err
                ));
            }
        }
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
            "inline": "Node: {{shape}} #{{count}}"
        });
        let out = interpolate_value(&tpl, &vars);
        assert_eq!(out["exact"], json!(3));
        assert_eq!(out["inline"], json!("Node: Cylinder #3"));
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
