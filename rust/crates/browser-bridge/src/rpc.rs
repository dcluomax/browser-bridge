use bridge_core::client::{BridgeClient, BridgeError};
use bridge_core::http;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub async fn run_async() -> i32 {
    let client = Arc::new(BridgeClient::new("local-rpc", false));
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();

    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response = handle_line(trimmed, &client).await;
        let out = format!("{response}\n");
        if stdout.write_all(out.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
            break;
        }
    }
    client.close_all().await;
    0
}

pub async fn handle_line(line: &str, client: &BridgeClient) -> Value {
    if line.len() > 1_000_000 {
        return err_resp(Value::Null, "bad_request", "RPC request exceeds 1000000 characters.");
    }
    let request: Value = match serde_json::from_str::<Value>(line) {
        Ok(val) if val.is_object() => val,
        _ => return err_resp(Value::Null, "bad_request", "RPC requests must be JSON objects."),
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let Some(req_id) = id.as_i64() else {
        return err_resp(Value::Null, "bad_request", "id must be a positive integer.");
    };
    if req_id < 1 {
        return err_resp(id, "bad_request", "id must be a positive integer.");
    }
    let Some(method) = request.get("method").and_then(Value::as_str).filter(|m| !m.trim().is_empty()) else {
        return err_resp(id, "bad_request", "method is required.");
    };
    let params = match request.get("params") {
        None | Some(Value::Null) => json!({}),
        Some(v) if v.is_object() => v.clone(),
        Some(_) => return err_resp(id, "bad_request", "params must be an object."),
    };
    let selector = request.get("browser").and_then(Value::as_str);
    let timeout_ms = match request.get("timeoutMs") {
        None | Some(Value::Null) => 60_000.0,
        Some(v) => match v.as_f64() {
            Some(n) if n.is_finite() && n > 0.0 && n <= 600_000.0 => n,
            _ => return err_resp(id, "bad_request", "timeoutMs must be greater than zero and at most 600000."),
        },
    };
    let timeout = Duration::from_secs_f64(timeout_ms / 1000.0);

    if method == "request.fetch" {
        let p = params.clone();
        let req_url = p.get("url").and_then(Value::as_str).unwrap_or("").to_string();
        let res = tokio::task::spawn_blocking(move || http::fetch_sync(&p, timeout)).await;
        return match res {
            Ok(Ok(val)) => {
                let status = val
                    .get("status")
                    .and_then(Value::as_u64)
                    .and_then(|s| u16::try_from(s).ok());
                bridge_core::routines::record_direct_http_outcome_on_disk(&req_url, status, false);
                json!({ "id": id, "ok": true, "result": val })
            }
            Ok(Err(err)) => err_resp(id, err.code, &err.message),
            Err(err) => err_resp(id, "request_failed", &err.to_string()),
        };
    }

    if method == "bridge.connect" {
        if selector.is_some_and(|s| !s.trim().is_empty()) {
            let _ = client.connect_all().await;
        }
        let conn = match client.get_connection(selector).await {
            Ok(c) => c,
            Err(err) => return err_resp(id, err.code(), err.message()),
        };
        return match conn.send("status", json!({}), timeout).await {
            Ok(status) => json!({
                "id": id,
                "ok": true,
                "result": {
                    "protocol": bridge_core::PROTOCOL_VERSION,
                    "hostVersion": bridge_core::VERSION,
                    "browser": conn.info,
                    "status": status,
                }
            }),
            Err(err) => err_resp(id, err.code(), err.message()),
        };
    }

    if method == "routine.list" {
        if let Some(d) = params.get("domain").and_then(Value::as_str) {
            let flush = params
                .get("flushAutoRoutines")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if let Ok((live_pb, _)) = client
                .send(
                    "site.profile",
                    json!({ "domain": d, "flushAutoRoutines": flush }),
                    selector,
                    Duration::from_secs(3),
                )
                .await
            {
                return json!({ "id": id, "ok": true, "result": live_pb });
            }
            let pb = bridge_core::routines::resolve_playbook(d)
                .unwrap_or_else(|| bridge_core::routines::SitePlaybook::new(d));
            return json!({ "id": id, "ok": true, "result": pb });
        }
        return json!({ "id": id, "ok": true, "result": bridge_core::routines::list_all_playbooks() });
    }

    if method == "routine.run" {
        let Some(name) = params.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            return err_resp(id, "bad_request", "routine.run requires 'name'.");
        };
        let tab_id = params.get("tabId").and_then(Value::as_i64);
        let domain = match params.get("domain").and_then(Value::as_str).and_then(bridge_core::routines::extract_domain) {
            Some(d) => d,
            None => {
                let mut ip = serde_json::Map::new();
                if let Some(t) = tab_id {
                    ip.insert("tabId".into(), json!(t));
                }
                match client.send("page.info", Value::Object(ip), selector, timeout).await {
                    Ok((info, _)) => match info.get("url").and_then(Value::as_str).and_then(bridge_core::routines::extract_domain) {
                        Some(d) => d,
                        None => return err_resp(id, "bad_request", "Could not resolve domain from tab; pass 'domain'."),
                    },
                    Err(err) => return err_resp(id, err.code(), err.message()),
                }
            }
        };
        let Some(pb) = bridge_core::routines::resolve_playbook(&domain) else {
            return err_resp(id, "not_found", &format!("No routines found for '{domain}'."));
        };
        let Some(routine) = pb.routines.get(name).cloned() else {
            return err_resp(id, "not_found", &format!("Routine '{name}' not found for '{}'.", pb.domain));
        };
        let args_obj = params.get("arguments").and_then(Value::as_object).cloned().unwrap_or_default();
        let ro = params.get("readOnly").and_then(Value::as_bool) == Some(true);
        return match bridge_core::routines::execute_routine(client, &routine, &args_obj, tab_id, selector, ro).await {
            Ok(res) => json!({ "id": id, "ok": true, "result": res }),
            Err(msg) => err_resp(id, if msg.contains("[read_only]") { "read_only" } else { "routine_failed" }, &msg),
        };
    }

    if method == "page.download" {
        let url = params
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let out_path = params
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let prefer_quality = params
            .get("preferQuality")
            .and_then(Value::as_str)
            .unwrap_or("best");
        let max_bytes = params
            .get("maxBytes")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .unwrap_or(bridge_core::media::DEFAULT_MAX_DOWNLOAD_BYTES);
        let tab_id = params.get("tabId").and_then(Value::as_i64);
        let frame_id = params.get("frameId").and_then(Value::as_i64);
        let dl_opts = bridge_core::media::DownloadOptions {
            url,
            output_path: out_path,
            tab_id,
            frame_id,
            browser: selector,
            prefer_quality,
            max_bytes,
        };
        return match bridge_core::media::download_media(client, dl_opts).await {
            Ok(res) => json!({ "id": id, "ok": true, "result": res }),
            Err(msg) => err_resp(
                id,
                if msg.contains("[drm_protected]") {
                    "drm_protected"
                } else if msg.contains("[not_found]") {
                    "not_found"
                } else {
                    "download_failed"
                },
                &msg,
            ),
        };
    }

    if matches!(method, "page.batch" | "routine.batch") {
        let Some(raw_steps) = params.get("steps") else {
            return err_resp(id, "bad_request", "page.batch requires 'steps' array.");
        };
        let steps: Vec<bridge_core::routines::RoutineStep> = match serde_json::from_value(raw_steps.clone()) {
            Ok(s) => s,
            Err(e) => return err_resp(id, "bad_request", &format!("Invalid batch steps schema: {e}")),
        };
        let vars = params.get("variables").and_then(Value::as_object).cloned().unwrap_or_default();
        let tab_id = params.get("tabId").and_then(Value::as_i64);
        let ro = params.get("readOnly").and_then(Value::as_bool) == Some(true);
        let stop_on_error = params.get("stopOnError").and_then(Value::as_bool).unwrap_or(true);
        let save_name = params
            .get("saveAsRoutine")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let save_desc = params.get("description").and_then(Value::as_str).unwrap_or("");
        let batch_opts = bridge_core::routines::BatchRunOptions {
            steps: &steps,
            variables: &vars,
            tab_id,
            browser: selector,
            enforce_read_only: ro,
            stop_on_error,
            save_as_routine: save_name.map(|n| (n, save_desc)),
        };
        return match bridge_core::routines::execute_batch(client, batch_opts).await {
            Ok(res) => json!({ "id": id, "ok": true, "result": res }),
            Err(msg) => err_resp(id, if msg.contains("[read_only]") { "read_only" } else { "batch_failed" }, &msg),
        };
    }

    if method == "routine.save" {
        let Some(domain) = params.get("domain").and_then(Value::as_str) else {
            return err_resp(id, "bad_request", "routine.save requires 'domain'.");
        };
        let note = params.get("note").and_then(Value::as_str);
        let del = params.get("deleteRoutine").and_then(Value::as_str);
        let reset = params.get("resetAccessProfile").and_then(Value::as_bool) == Some(true);
        let parsed = match params.get("routine").filter(|v| !v.is_null()) {
            Some(raw) => match serde_json::from_value::<bridge_core::routines::RoutineDefinition>(raw.clone()) {
                Ok(r) => Some(r),
                Err(e) => return err_resp(id, "bad_request", &format!("Invalid routine schema: {e}")),
            },
            None => None,
        };
        if let Ok((res, _)) = client.send("site.save", params.clone(), selector, timeout).await {
            return json!({ "id": id, "ok": true, "result": res });
        }
        return match bridge_core::routines::upsert_site_memory(domain, note, parsed, del, reset) {
            Ok((_, pb)) => json!({ "id": id, "ok": true, "result": pb }),
            Err(msg) => err_resp(id, "bad_request", &msg),
        };
    }

    match client.send(method, params, selector, timeout).await {
        Ok((result, _)) => json!({ "id": id, "ok": true, "result": result }),
        Err(BridgeError::Command { code, message }) => err_resp(id, &code, &message),
        Err(BridgeError::Unavailable(msg)) => err_resp(id, "unavailable", &msg),
        Err(BridgeError::Io(msg)) => err_resp(id, "connection_lost", &msg),
    }
}

fn err_resp(id: Value, code: &str, message: &str) -> Value {
    json!({
        "id": id,
        "ok": false,
        "error": { "code": code, "message": message },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_malformed_envelopes_before_dispatch() {
        let client = BridgeClient::new("test", false);
        for bad in [
            "not json",
            "[]",
            r#"{"id":0,"method":"status"}"#,
            r#"{"id":1,"method":"status","params":[]}"#,
            r#"{"id":1,"method":"status","timeoutMs":0}"#,
            r#"{"id":1,"method":"status","timeoutMs":600001}"#,
        ] {
            let res = handle_line(bad, &client).await;
            assert_eq!(res["ok"], false, "expected error for {bad}");
        }
    }
}
