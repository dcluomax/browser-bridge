mod installer;
mod mcp;
mod native_host;
mod rpc;

use bridge_core::client::BridgeClient;
use serde_json::json;
use std::io::{self, Write};

const USAGE: &str = "\
Browser Bridge native host and MCP server (Rust).

Usage:
  BrowserBridge mcp [--read-only] [--allow-evaluate]  Run the MCP server on stdio (--read-only disables all actions).
  BrowserBridge mcp-mode [status|read-only|read-write] Inspect or switch ~/.copilot/mcp-config.json MCP mode.
  BrowserBridge routines [<domain-or-url>] [--json]    Inspect learned Site Memory routines and recorded pitfalls.
  BrowserBridge activity [--limit <N>] [--json]        Inspect recent redacted session activity (origin+path only, <=500 entries).
  BrowserBridge rpc                        Run the managed local-script API on stdio.
  BrowserBridge download [<url>] [--tab <id>] [--browser <sel>] [--output <path>] [--quality best|lowest] [--json]
  BrowserBridge screenshot <output-path> [--tab <id>] [--browser <sel>] [--full-page] [--selector <css>] [--ref <ref>] [--format png|jpeg] [--quality <10-100>] [--max-width <px>]
  BrowserBridge install --chromium-id <id> [--gecko-id <id>] [--browsers edge,chrome,chromium,firefox] [--host-path <exe>]
  BrowserBridge uninstall                  Remove native messaging registrations for the current user.
  BrowserBridge status [--json]            Show registrations and connected browsers.

Browsers start this program themselves as a native messaging host; do not run that mode by hand.";

pub fn is_browser_launch(args: &[String]) -> bool {
    let Some(first) = args.first() else {
        return false;
    };
    first.to_ascii_lowercase().starts_with("chrome-extension://")
        || (first.to_ascii_lowercase().ends_with(".json") && args.get(1).is_some_and(|s| s.contains('@')))
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if is_browser_launch(&args) {
        let code = native_host::run_from_stdio(&args).await;
        std::process::exit(code);
    }

    let code = match args.first().map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("mcp") => mcp::run_async(&args[1..]).await,
        Some("mcp-mode") => mcp_mode(&args[1..]),
        Some("routines") => routines_cmd(&args[1..]),
        Some("activity") => activity_cmd(&args[1..]),
        Some("rpc") => rpc::run_async().await,
        Some("download") => download_async(&args[1..]).await,
        Some("screenshot") => screenshot_async(&args[1..]).await,
        Some("install") => installer::install(&args[1..], &mut io::stdout()),
        Some("uninstall") => installer::uninstall(&mut io::stdout()),
        Some("status") => status_async(args.iter().any(|a| a == "--json")).await,
        Some("--version") | Some("version") => {
            println!("{}", bridge_core::VERSION);
            0
        }
        _ => {
            println!("{USAGE}");
            if args.is_empty() || matches!(args[0].as_str(), "-h" | "--help" | "help") {
                0
            } else {
                2
            }
        }
    };
    let _ = io::stdout().flush();
    std::process::exit(code);
}

fn routines_cmd(args: &[String]) -> i32 {
    let as_json = args.iter().any(|a| a == "--json");
    let reset_profile = args.iter().any(|a| a == "--reset-profile");
    let target = args.iter().find(|a| !a.starts_with('-')).map(String::as_str);
    if let Some(domain_or_url) = target {
        let Some(domain) = bridge_core::routines::extract_domain(domain_or_url) else {
            eprintln!("error: invalid domain or URL '{domain_or_url}'.");
            return 2;
        };
        if reset_profile {
            if let Err(e) = bridge_core::routines::upsert_site_memory(&domain, None, None, None, true) {
                eprintln!("error: {e}");
                return 1;
            }
        }
        let pb = bridge_core::routines::resolve_playbook(&domain)
            .unwrap_or_else(|| bridge_core::routines::SitePlaybook::new(domain));
        if as_json {
            println!("{}", serde_json::to_string_pretty(&pb).unwrap_or_default());
        } else {
            println!(
                "Site Memory for {} (schema v{}, verifiedAt={}, updatedAt={}):",
                pb.domain,
                pb.schema_version,
                pb.verified_at.as_deref().unwrap_or("unverified"),
                if pb.updated_at.is_empty() { "-" } else { pb.updated_at.as_str() }
            );
            if let Some(speed) = &pb.speedup_summary {
                println!("  Speedup: {speed}");
            }
            let perf_lines = pb.access_profile.summary_lines();
            if !perf_lines.is_empty() {
                println!("  Learned Access & Perf Profile:");
                for line in perf_lines {
                    println!("    + {line}");
                }
            }
            println!(
                "  Perf Stats: navs={} (avg {}ms, loadTimeouts={}, slowLoadTails={}), snapshots={} (avg {}ms), inPageActions={}, cdpFallbacks={}",
                pb.access_profile.stats.navigations,
                pb.access_profile.stats.avg_nav_ms,
                pb.access_profile.stats.load_timeouts,
                pb.access_profile.stats.slow_load_tails,
                pb.access_profile.stats.snapshots,
                pb.access_profile.stats.avg_snapshot_ms,
                pb.access_profile.stats.in_page_actions,
                pb.access_profile.stats.cdp_fallbacks,
            );
            println!("  Routines ({}):", pb.routines.len());
            for r in pb.routines.values() {
                let stale = if r.stale { " [STALE - DOM may have changed]" } else { "" };
                let v = r.verified_at.as_deref().map(|t| format!(" (verified {t})")).unwrap_or_default();
                println!("    - {}{stale}{v}: {}", r.name, r.description);
            }
            println!("  Notes ({}):", pb.notes.len());
            for n in &pb.notes {
                println!("    * {n}");
            }
            println!("  Recorded pitfalls ({}):", pb.pitfalls.len());
            for p in &pb.pitfalls {
                println!("    ! [{} x{} on {}] {}", p.code, p.count, p.method, p.summary);
            }
        }
        return 0;
    }

    let all = bridge_core::routines::list_all_playbooks();
    if as_json {
        println!("{}", serde_json::to_string_pretty(&all).unwrap_or_default());
    } else {
        println!("Site Memory directory: {}", bridge_core::routines::routines_directory().display());
        for pb in all {
            let v = pb.verified_at.as_deref().unwrap_or("-");
            println!(
                "  {:<30} {} routine(s), {} note(s), {} pitfall(s)  [verifiedAt: {v}]",
                pb.domain,
                pb.routines.len(),
                pb.notes.len(),
                pb.pitfalls.len()
            );
        }
    }
    0
}

fn activity_cmd(args: &[String]) -> i32 {
    let as_json = args.iter().any(|a| a == "--json");
    let mut limit = 50usize;
    let mut idx = 0usize;
    while idx < args.len() {
        if args[idx] == "--limit" {
            if let Some(val) = args.get(idx + 1).and_then(|s| s.parse::<usize>().ok()) {
                limit = val.clamp(1, bridge_core::routines::MAX_ACTIVITY_LOG_ENTRIES);
            }
            idx += 2;
            continue;
        }
        idx += 1;
    }
    let entries = bridge_core::routines::read_activity_log(limit);
    if as_json {
        println!("{}", serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".into()));
    } else if entries.is_empty() {
        println!(
            "No activity entries recorded yet ({}).",
            bridge_core::routines::activity_log_path().display()
        );
    } else {
        println!(
            "Recent redacted activity ({} entries, path: {}):",
            entries.len(),
            bridge_core::routines::activity_log_path().display()
        );
        for e in entries {
            let tid = e.tab_id.map(|t| format!("#{t}")).unwrap_or_else(|| "-".into());
            let status = if e.ok {
                "OK".to_string()
            } else {
                format!("ERR({})", e.error_code.unwrap_or_else(|| "error".into()))
            };
            println!(
                "  {}  {:<6} {:<6} {:<18} {:>5}ms  {:<10} {}",
                e.ts, e.browser, tid, e.method, e.ms, status, e.target
            );
        }
    }
    0
}

fn mcp_mode(args: &[String]) -> i32 {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from);
    let Some(home_dir) = home else {
        eprintln!("error: could not determine user home directory.");
        return 1;
    };
    let config_path = home_dir.join(".copilot").join("mcp-config.json");
    let action = args.first().map(|s| s.to_ascii_lowercase()).unwrap_or_else(|| "status".to_string());

    let mut root: serde_json::Value = if config_path.is_file() {
        match std::fs::read_to_string(&config_path).and_then(|s| {
            serde_json::from_str(&s).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
        }) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("error reading {}: {e}", config_path.display());
                return 1;
            }
        }
    } else {
        json!({ "mcpServers": {} })
    };

    if action == "status" {
        let ro = root
            .get("mcpServers")
            .and_then(|s| s.get("browser-bridge"))
            .and_then(|b| b.get("args"))
            .and_then(|a| a.as_array())
            .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some("--read-only")));
        println!("MCP config: {}", config_path.display());
        println!("browser-bridge MCP mode: {}", if ro { "read-only (no action capability)" } else { "read-write" });
        return 0;
    }

    let want_ro = match action.as_str() {
        "read-only" | "readonly" | "ro" => true,
        "read-write" | "readwrite" | "rw" => false,
        other => {
            eprintln!("Usage: BrowserBridge mcp-mode [status|read-only|read-write] (got '{other}')");
            return 2;
        }
    };

    let exe_str = bridge_core::default_host_executable().display().to_string();
    let Some(root_obj) = root.as_object_mut() else {
        eprintln!("error: mcp-config.json root must be an object.");
        return 1;
    };
    let servers = root_obj
        .entry("mcpServers")
        .or_insert_with(|| json!({}));
    let Some(servers_obj) = servers.as_object_mut() else {
        eprintln!("error: mcpServers must be an object.");
        return 1;
    };
    let entry = servers_obj
        .entry("browser-bridge")
        .or_insert_with(|| json!({ "type": "local", "command": exe_str, "args": ["mcp"], "tools": ["*"] }));

    if let Some(obj) = entry.as_object_mut() {
        let mut cur_args: Vec<String> = obj
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_else(|| vec!["mcp".to_string()]);
        if !cur_args.iter().any(|a| a == "mcp") {
            cur_args.insert(0, "mcp".to_string());
        }
        cur_args.retain(|a| !a.eq_ignore_ascii_case("--read-only"));
        if want_ro {
            cur_args.push("--read-only".to_string());
        }
        obj.insert("args".to_string(), json!(cur_args));
    }

    if let Some(parent) = config_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(&root).map_err(|e| e.to_string()).and_then(|txt| {
        std::fs::write(&config_path, format!("{txt}\n")).map_err(|e| e.to_string())
    }) {
        Ok(_) => {
            println!(
                "Updated {}: browser-bridge MCP is now {}.",
                config_path.display(),
                if want_ro { "read-only (--read-only)" } else { "read-write" }
            );
            0
        }
        Err(e) => {
            eprintln!("error writing {}: {e}", config_path.display());
            1
        }
    }
}

async fn download_async(args: &[String]) -> i32 {
    let mut url: Option<String> = None;
    let mut output_path: Option<String> = None;
    let mut tab_id: Option<i64> = None;
    let mut browser: Option<String> = None;
    let mut prefer_quality = "best".to_string();
    let mut max_bytes = bridge_core::media::DEFAULT_MAX_DOWNLOAD_BYTES;
    let mut as_json = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => as_json = true,
            "--tab" => {
                i += 1;
                tab_id = args.get(i).and_then(|v| v.parse::<i64>().ok());
            }
            "--browser" => {
                i += 1;
                browser = args.get(i).cloned();
            }
            "--output" | "-o" => {
                i += 1;
                output_path = args.get(i).cloned();
            }
            "--quality" => {
                i += 1;
                if let Some(q) = args.get(i) {
                    prefer_quality = q.clone();
                }
            }
            "--max-bytes" => {
                i += 1;
                if let Some(mb) = args.get(i).and_then(|v| v.parse::<usize>().ok()) {
                    max_bytes = mb;
                }
            }
            arg if !arg.starts_with('-') && url.is_none() => {
                url = Some(arg.to_string());
            }
            other => {
                eprintln!("Unknown download option: {other}");
                return 2;
            }
        }
        i += 1;
    }

    let client = BridgeClient::new("cli-download", false);
    let opts = bridge_core::media::DownloadOptions {
        url: url.as_deref(),
        output_path: output_path.as_deref(),
        tab_id,
        frame_id: None,
        browser: browser.as_deref(),
        prefer_quality: &prefer_quality,
        max_bytes,
    };
    let result = bridge_core::media::download_media(&client, opts).await;
    client.close_all().await;

    match result {
        Ok(res) => {
            if as_json {
                println!("{}", serde_json::to_string_pretty(&res).unwrap_or_else(|_| res.to_string()));
            } else {
                println!(
                    "Saved {} ({} bytes, {}) -> {}",
                    res.get("mimeType").and_then(serde_json::Value::as_str).unwrap_or("media"),
                    res.get("bytes").and_then(serde_json::Value::as_u64).unwrap_or(0),
                    res.get("delivery").and_then(serde_json::Value::as_str).unwrap_or("direct"),
                    res.get("path").and_then(serde_json::Value::as_str).unwrap_or("")
                );
            }
            0
        }
        Err(err) => {
            eprintln!("error: {err}");
            1
        }
    }
}

async fn screenshot_async(args: &[String]) -> i32 {
    let mut output_path: Option<String> = None;
    let mut tab_id: Option<i64> = None;
    let mut browser: Option<String> = None;
    let mut full_page = false;
    let mut selector: Option<String> = None;
    let mut elem_ref: Option<String> = None;
    let mut format: Option<String> = None;
    let mut quality: Option<i64> = None;
    let mut max_width: i64 = 4096;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--full-page" => full_page = true,
            "--tab" => {
                i += 1;
                tab_id = args.get(i).and_then(|v| v.parse::<i64>().ok());
            }
            "--browser" => {
                i += 1;
                browser = args.get(i).cloned();
            }
            "--selector" => {
                i += 1;
                selector = args.get(i).cloned();
            }
            "--ref" => {
                i += 1;
                elem_ref = args.get(i).cloned();
            }
            "--format" => {
                i += 1;
                format = args.get(i).cloned();
            }
            "--quality" => {
                i += 1;
                quality = args.get(i).and_then(|v| v.parse::<i64>().ok());
            }
            "--max-width" => {
                i += 1;
                if let Some(w) = args.get(i).and_then(|v| v.parse::<i64>().ok()) {
                    max_width = w;
                }
            }
            arg if !arg.starts_with('-') && output_path.is_none() => {
                output_path = Some(arg.to_string());
            }
            other => {
                eprintln!("Unknown screenshot option: {other}");
                return 2;
            }
        }
        i += 1;
    }

    let Some(raw_out) = output_path else {
        eprintln!("Usage: BrowserBridge screenshot <output-path> [--tab <id>] [--browser <sel>] [--full-page] [--selector <css>] [--ref <ref>]");
        return 2;
    };
    let lower = raw_out.to_ascii_lowercase();
    let fmt = format.unwrap_or_else(|| {
        if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
            "jpeg".to_string()
        } else {
            "png".to_string()
        }
    });
    if fmt != "png" && fmt != "jpeg" {
        eprintln!("format must be png or jpeg.");
        return 2;
    }

    let mut params = serde_json::Map::new();
    params.insert("format".into(), json!(fmt));
    params.insert("maxWidth".into(), json!(max_width));
    if full_page {
        params.insert("fullPage".into(), json!(true));
    }
    if let Some(t) = tab_id {
        params.insert("tabId".into(), json!(t));
    }
    if let Some(q) = quality {
        params.insert("quality".into(), json!(q));
    }
    if let Some(r) = elem_ref {
        params.insert("ref".into(), json!(r));
    } else if let Some(css) = selector {
        params.insert("locator".into(), json!({ "steps": [{ "kind": "css", "value": css }] }));
    }

    let client = BridgeClient::new("cli-screenshot", false);
    let timeout = if full_page {
        std::time::Duration::from_secs(45)
    } else {
        std::time::Duration::from_secs(30)
    };
    let res = match client
        .send("page.screenshot", serde_json::Value::Object(params), browser.as_deref(), timeout)
        .await
    {
        Ok((r, _)) => r,
        Err(err) => {
            client.close_all().await;
            eprintln!("error: {err}");
            return 1;
        }
    };
    client.close_all().await;

    let Some(data) = res.get("data").and_then(|v| v.as_str()) else {
        eprintln!("error: missing image data in response.");
        return 1;
    };
    let bytes = match bridge_core::decode_base64(data) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };
    let out = std::path::PathBuf::from(&raw_out);
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!("error: could not create directory {}: {e}", parent.display());
                return 1;
            }
        }
    }
    if let Err(e) = std::fs::write(&out, &bytes) {
        eprintln!("error: could not write {}: {e}", out.display());
        return 1;
    }
    println!(
        "Saved {}x{} ({} bytes) -> {}",
        res.get("width").and_then(|v| v.as_i64()).unwrap_or(0),
        res.get("height").and_then(|v| v.as_i64()).unwrap_or(0),
        bytes.len(),
        out.display()
    );
    0
}

async fn status_async(as_json: bool) -> i32 {
    let registrations = installer::registrations();
    let client = BridgeClient::new("status", false);
    let connections = client.connect_all().await;

    if as_json {
        let regs_json: Vec<_> = registrations
            .iter()
            .map(|r| {
                json!({
                    "browser": r.browser,
                    "manifest": r.manifest,
                    "exists": r.exists,
                })
            })
            .collect();
        let browsers_json: Vec<_> = connections
            .iter()
            .map(|(ep, conn, err)| {
                json!({
                    "browser": ep.browser,
                    "instanceId": ep.instance_id,
                    "pipe": ep.pipe_name,
                    "label": conn.as_ref().map(|c| c.label()),
                    "browserVersion": conn.as_ref().and_then(|c| c.info.get("browserVersion").and_then(|v| v.as_str())),
                    "extensionVersion": conn.as_ref().and_then(|c| c.info.get("extensionVersion").and_then(|v| v.as_str())),
                    "error": err,
                })
            })
            .collect();
        let output = json!({
            "hostVersion": bridge_core::VERSION,
            "registrations": regs_json,
            "browsers": browsers_json,
        });
        println!("{}", serde_json::to_string_pretty(&output).unwrap_or_default());
        return 0;
    }

    println!("Browser Bridge host {}", bridge_core::VERSION);
    println!("Native messaging registrations (current user):");
    for reg in &registrations {
        let state = match &reg.manifest {
            None => "not registered".to_string(),
            Some(path) if reg.exists => path.clone(),
            Some(path) => format!("{path} (missing file)"),
        };
        println!("  {:<8} {}", reg.browser, state);
    }

    if connections.is_empty() {
        println!("Connected browsers: none");
    } else {
        println!("Connected browsers:");
        for (ep, conn, err) in &connections {
            match conn {
                Some(c) => println!("  {}", c.describe()),
                None => println!("  {} ({}): {}", ep.browser, ep.instance_id, err.as_deref().unwrap_or("")),
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_browser_launches() {
        assert!(is_browser_launch(&["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/".into(), "--parent-window=0".into()]));
        assert!(is_browser_launch(&[r"C:\Users\alice\AppData\Local\BrowserBridge\manifests\firefox.json".into(), "browser-bridge@dcluomax.github.io".into()]));
        assert!(!is_browser_launch(&["mcp".into()]));
        assert!(!is_browser_launch(&["status.json".into()]));
    }
}
