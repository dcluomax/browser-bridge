use bridge_core::native_messaging::{read_message, write_message};
use bridge_core::pipes;
use bridge_core::routines::{PreparedCall, RoutineDefinition, SiteLearner, SitePlaybook};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, mpsc};

const MAX_IPC_LINE_BYTES: usize = 1024 * 1024 + 65536;

struct ClientSession {
    subscribed_events: bool,
    tx: mpsc::Sender<String>,
}

struct PendingRequest {
    client_id: Value,
    prepared: PreparedCall,
}

struct State {
    sessions: HashMap<String, ClientSession>,
    pending: HashMap<String, PendingRequest>,
    learner: SiteLearner,
    ext_tx: mpsc::UnboundedSender<Value>,
    extension_info: Value,
    counter: AtomicI64,
}

impl State {
    fn new(ext_tx: mpsc::UnboundedSender<Value>, extension_info: Value) -> Self {
        Self {
            sessions: HashMap::new(),
            pending: HashMap::new(),
            learner: SiteLearner::default(),
            ext_tx,
            extension_info,
            counter: AtomicI64::new(1),
        }
    }
}

pub async fn run_from_stdio(_args: &[String]) -> i32 {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    run_with_streams(stdin, stdout, &pipes::current_user_key()).await
}

pub async fn run_with_streams<R, W>(mut input: R, mut output: W, user_key: &str) -> i32
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let first = match read_message(&mut input).await {
        Ok(Some(msg)) => msg,
        Ok(None) => return 0,
        Err(_) => return 1,
    };
    if first.get("type").and_then(Value::as_str) != Some("hello") {
        return 2;
    }

    let browser = pipes::normalize_browser(first.get("browser").and_then(Value::as_str));
    let requested_instance_id = first.get("instanceId").and_then(Value::as_str).unwrap_or("");
    if pipes::build(user_key, browser, requested_instance_id).is_err() {
        return 2;
    }
    let Some(bound) = bind_initial_ipc(user_key, browser, requested_instance_id).await else {
        return 1;
    };
    let pipe_name = bound.pipe_name.clone();
    let effective_instance_id = bound.instance_id.clone();

    let guide_path = bridge_core::ensure_agent_guide(None).display().to_string();
    let mut extension_info = first.clone();
    if let Some(obj) = extension_info.as_object_mut() {
        obj.insert("instanceId".into(), Value::String(effective_instance_id.clone()));
        obj.insert("hostVersion".into(), Value::String(bridge_core::VERSION.into()));
        obj.insert("pipeName".into(), Value::String(pipe_name.clone()));
        obj.insert("agentGuide".into(), Value::String(guide_path.clone()));
    }

    let host_hello = json!({
        "type": "hostHello",
        "protocol": bridge_core::PROTOCOL_VERSION,
        "hostVersion": bridge_core::VERSION,
        "pipeName": pipe_name,
        "instanceId": effective_instance_id,
        "agentGuide": guide_path,
    });
    if write_message(&mut output, &host_hello).await.is_err() {
        return 1;
    }

    let (ext_tx, mut ext_rx) = mpsc::unbounded_channel::<Value>();
    let state = Arc::new(Mutex::new(State::new(ext_tx, extension_info)));

    let writer_task = tokio::spawn(async move {
        while let Some(msg) = ext_rx.recv().await {
            if write_message(&mut output, &msg).await.is_err() {
                break;
            }
        }
    });

    let listener_state = Arc::clone(&state);
    let listener_task = tokio::spawn(async move {
        serve_ipc(bound, listener_state).await;
    });

    while let Ok(Some(msg)) = read_message(&mut input).await {
        handle_extension_message(&state, msg).await;
    }

    listener_task.abort();
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(pipes::unix_socket_path(&pipe_name));
    }
    writer_task.abort();
    0
}

async fn handle_extension_message(state: &Arc<Mutex<State>>, msg: Value) {
    match msg.get("type").and_then(Value::as_str) {
        Some("response") => {
            let Some(req_id) = msg.get("id").and_then(Value::as_str) else {
                return;
            };
            let ok = msg.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let mut clean_res = msg.get("result").cloned();
            let err_ref = msg.get("error");

            let (tx, client_id, persists, activity_entry) = {
                let mut guard = state.lock().await;
                let Some(pending) = guard.pending.remove(req_id) else {
                    return;
                };
                let duration_ms = pending.prepared.started_at.elapsed().as_millis() as u64;
                let to_persist = guard.learner.observe_response(
                    &pending.prepared,
                    ok,
                    clean_res.as_mut(),
                    err_ref,
                );
                let mut persists = guard.learner.take_extra_persists();
                if let Some(pb) = to_persist {
                    persists.push(pb);
                }

                let activity_entry = if !pending.prepared.no_learn
                    && bridge_core::routines::should_log_activity_method(&pending.prepared.method)
                {
                    let resolved_tab = clean_res
                        .as_ref()
                        .and_then(|r| r.get("tabId"))
                        .and_then(Value::as_i64)
                        .or(pending.prepared.tab_id);
                    let raw_target = if pending.prepared.method == "page.fetch" {
                        pending.prepared.target_summary.clone()
                    } else {
                        clean_res
                            .as_ref()
                            .and_then(|r| r.get("url"))
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                            .or_else(|| {
                                resolved_tab.and_then(|tid| guard.learner.tab_urls.get(&tid).cloned())
                            })
                            .or_else(|| pending.prepared.url_hint.clone())
                            .unwrap_or_default()
                    };
                    let browser_name = guard
                        .extension_info
                        .get("browser")
                        .and_then(Value::as_str)
                        .unwrap_or("browser")
                        .to_string();
                    let instance_id = guard
                        .extension_info
                        .get("instanceId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let error_code = if ok {
                        None
                    } else {
                        err_ref
                            .and_then(|e| e.get("code"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    };
                    Some(bridge_core::routines::ActivityLogEntry {
                        ts: bridge_core::routines::now_iso8601(),
                        browser: browser_name,
                        instance: instance_id,
                        session: pending.prepared.session_id.clone(),
                        tab_id: resolved_tab,
                        method: pending.prepared.method.clone(),
                        target: bridge_core::routines::redact_url_for_activity_log(&raw_target),
                        ok,
                        ms: duration_ms,
                        error_code,
                    })
                } else {
                    None
                };

                let Some(session) = guard.sessions.get(&pending.prepared.session_id) else {
                    if !persists.is_empty() || activity_entry.is_some() {
                        tokio::task::spawn_blocking(move || {
                            if let Some(entry) = activity_entry {
                                bridge_core::routines::append_activity_log(&entry);
                            }
                            for pb in persists {
                                let _ = bridge_core::routines::save_playbook_preserving_newer_disk_routines(&pb);
                            }
                        });
                    }
                    return;
                };
                (session.tx.clone(), pending.client_id, persists, activity_entry)
            };

            if !persists.is_empty() || activity_entry.is_some() {
                tokio::task::spawn_blocking(move || {
                    if let Some(entry) = activity_entry {
                        bridge_core::routines::append_activity_log(&entry);
                    }
                    for pb in persists {
                        let _ = bridge_core::routines::save_playbook_preserving_newer_disk_routines(&pb);
                    }
                });
            }

            let mut payload = json!({
                "id": client_id,
                "ok": ok,
            });
            if let Some(res) = clean_res {
                payload["result"] = res;
            }
            if let Some(err) = err_ref {
                payload["error"] = err.clone();
            }
            let _ = tx.send(format!("{payload}\n")).await;
        }
        Some("hello") => {
            let mut guard = state.lock().await;
            let pipe = guard.extension_info.get("pipeName").cloned().unwrap_or(Value::Null);
            let inst = guard.extension_info.get("instanceId").cloned().unwrap_or(Value::Null);
            let guide = guard.extension_info.get("agentGuide").cloned().unwrap_or(Value::Null);
            let mut updated = msg;
            if let Some(obj) = updated.as_object_mut() {
                obj.insert("hostVersion".into(), Value::String(bridge_core::VERSION.into()));
                obj.insert("pipeName".into(), pipe);
                obj.insert("instanceId".into(), inst);
                obj.insert("agentGuide".into(), guide);
            }
            guard.extension_info = updated;
        }
        Some("event") => {
            let guard = state.lock().await;
            let line = format!("{msg}\n");
            for session in guard.sessions.values() {
                if session.subscribed_events {
                    let _ = session.tx.try_send(line.clone());
                }
            }
        }
        Some("saveScreenshot") => {
            let req_id = msg.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let title = msg.get("title").and_then(Value::as_str).unwrap_or("page").to_string();
            let full_page = msg.get("fullPage").and_then(Value::as_bool).unwrap_or(false);
            let data = msg.get("data").and_then(Value::as_str).unwrap_or("").to_string();
            let ext_tx = state.lock().await.ext_tx.clone();
            tokio::task::spawn_blocking(move || {
                let reply = match bridge_core::save_screenshot_to_downloads(&title, full_page, &data) {
                    Ok(path) => {
                        let file_name = path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("screenshot.png")
                            .to_string();
                        json!({
                            "type": "savedScreenshot",
                            "id": req_id,
                            "ok": true,
                            "fileName": file_name,
                            "path": path.to_string_lossy(),
                        })
                    }
                    Err(err) => json!({
                        "type": "savedScreenshot",
                        "id": req_id,
                        "ok": false,
                        "error": err,
                    }),
                };
                let _ = ext_tx.send(reply);
            });
        }
        Some("saveDemonstratedRoutine") => {
            let url = msg.get("url").and_then(Value::as_str).unwrap_or("").to_string();
            let name = msg.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
            let desc = msg.get("description").and_then(Value::as_str).unwrap_or("").to_string();
            let raw_steps = msg.get("steps").cloned().unwrap_or_else(|| json!([]));
            if !url.is_empty() && !name.is_empty() {
                if let Ok(steps) = serde_json::from_value::<Vec<bridge_core::routines::RoutineStep>>(raw_steps) {
                    if !steps.is_empty() {
                        let now_ts = bridge_core::routines::now_iso8601();
                        let routine = RoutineDefinition {
                            name,
                            description: desc,
                            read_only: false,
                            verified_at: Some(now_ts.clone()),
                            updated_at: Some(now_ts),
                            params: std::collections::BTreeMap::new(),
                            steps,
                            ..Default::default()
                        };
                        let mut guard = state.lock().await;
                        let _ = guard.learner.upsert_memory(&url, None, Some(routine), None, false);
                    }
                }
            }
        }
        _ => {}
    }
}

async fn read_bounded_line<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R, buf: &mut Vec<u8>) -> std::io::Result<usize> {
    buf.clear();
    let mut limited = reader.take((MAX_IPC_LINE_BYTES + 1) as u64);
    let n = limited.read_until(b'\n', buf).await?;
    if buf.len() > MAX_IPC_LINE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "IPC request line exceeds maximum allowed length.",
        ));
    }
    Ok(n)
}

async fn handle_pipe_client<S>(stream: S, state: Arc<Mutex<State>>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (read_half, mut write_half) = tokio::io::split(stream);
    let mut reader = BufReader::new(read_half);
    let (tx, mut rx) = mpsc::channel::<String>(256);

    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() || write_half.flush().await.is_err() {
                break;
            }
        }
    });

    let session_id = {
        let guard = state.lock().await;
        let seq = guard.counter.fetch_add(1, Ordering::Relaxed);
        format!("s{seq}")
    };
    let mut opened = false;
    let mut raw_line = Vec::with_capacity(1024);

    loop {
        match read_bounded_line(&mut reader, &mut raw_line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let Ok(msg) = serde_json::from_slice::<Value>(&raw_line) else {
                    continue;
                };
                if msg.get("type").and_then(Value::as_str) == Some("hello") {
                    let subscribed = msg.get("events").and_then(Value::as_bool).unwrap_or(false);
                    let ack = {
                        let mut guard = state.lock().await;
                        if !opened {
                            opened = true;
                            guard.sessions.insert(
                                session_id.clone(),
                                ClientSession {
                                    subscribed_events: subscribed,
                                    tx: tx.clone(),
                                },
                            );
                            let _ = guard.ext_tx.send(json!({
                                "type": "session",
                                "event": "open",
                                "session": session_id,
                                "client": {
                                    "name": msg.get("client").cloned().unwrap_or(Value::String("agent".into())),
                                    "pid": msg.get("pid").cloned().unwrap_or(Value::Null),
                                }
                            }));
                        }
                        let mut ack = guard.extension_info.clone();
                        if let Some(obj) = ack.as_object_mut() {
                            obj.insert("session".into(), Value::String(session_id.clone()));
                        }
                        ack
                    };
                    let _ = tx.send(format!("{ack}\n")).await;
                    continue;
                }

                let Some(client_id) = msg.get("id").cloned() else {
                    let _ = tx.send(format!("{}\n", json!({"id": null, "ok": false, "error": {"code": "bad_request", "message": "Requests need id and method."}}))).await;
                    continue;
                };
                let Some(method) = msg.get("method").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                    let _ = tx.send(format!("{}\n", json!({"id": client_id, "ok": false, "error": {"code": "bad_request", "message": "Requests need id and method."}}))).await;
                    continue;
                };

                let mut params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

                // Host-native Site Memory & Adaptive Access Profile RPCs (0.05 ms, no browser extension round-trip)
                if matches!(method, "site.profile" | "site.save" | "site.recordHttp") {
                    let (reply, persists) = {
                        let mut guard = state.lock().await;
                        match method {
                            "site.profile" => {
                                let force_flush = params
                                    .get("flushAutoRoutines")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false);
                                let min_idle = if force_flush {
                                    std::time::Duration::ZERO
                                } else {
                                    std::time::Duration::from_secs(5)
                                };
                                let flushed = guard.learner.flush_idle_trajectories(min_idle);
                                let tab_id = params.get("tabId").and_then(Value::as_i64);
                                let domain_opt = params
                                    .get("domain")
                                    .and_then(Value::as_str)
                                    .and_then(bridge_core::routines::canonical_site_key)
                                    .or_else(|| guard.learner.domain_for_session_or_tab(&session_id, tab_id));
                                match domain_opt {
                                    Some(dom) => {
                                        let pb = guard
                                            .learner
                                            .get_playbook(&dom)
                                            .unwrap_or_else(|| SitePlaybook::new(dom));
                                        (json!({ "id": client_id, "ok": true, "result": pb }), flushed)
                                    }
                                    None => (
                                        json!({
                                            "id": client_id,
                                            "ok": false,
                                            "error": { "code": "bad_request", "message": "Provide domain or a tabId with a loaded URL." }
                                        }),
                                        flushed,
                                    ),
                                }
                            }
                            "site.save" => {
                                let tab_id = params.get("tabId").and_then(Value::as_i64);
                                let domain_opt = params
                                    .get("domain")
                                    .and_then(Value::as_str)
                                    .and_then(bridge_core::routines::canonical_site_key)
                                    .or_else(|| guard.learner.domain_for_session_or_tab(&session_id, tab_id));
                                let Some(dom) = domain_opt else {
                                    let r = json!({
                                        "id": client_id,
                                        "ok": false,
                                        "error": { "code": "bad_request", "message": "Provide domain or a tabId with a loaded URL." }
                                    });
                                    let _ = tx.send(format!("{r}\n")).await;
                                    continue;
                                };
                                let note = params.get("note").and_then(Value::as_str);
                                let del = params.get("deleteRoutine").and_then(Value::as_str);
                                let reset = params.get("resetAccessProfile").and_then(Value::as_bool) == Some(true);
                                let parsed_routine = match params.get("routine").filter(|v| !v.is_null()) {
                                    Some(raw) => match serde_json::from_value::<RoutineDefinition>(raw.clone()) {
                                        Ok(r) => Some(r),
                                        Err(e) => {
                                            let r = json!({
                                                "id": client_id,
                                                "ok": false,
                                                "error": { "code": "bad_request", "message": format!("Invalid routine schema: {e}") }
                                            });
                                            let _ = tx.send(format!("{r}\n")).await;
                                            continue;
                                        }
                                    },
                                    None => None,
                                };
                                match guard.learner.upsert_memory(&dom, note, parsed_routine, del, reset) {
                                    Ok((_, pb)) => (json!({ "id": client_id, "ok": true, "result": pb }), Vec::new()),
                                    Err(e) => (
                                        json!({ "id": client_id, "ok": false, "error": { "code": "bad_request", "message": e } }),
                                        Vec::new(),
                                    ),
                                }
                            }
                            _ => {
                                let url = params.get("url").and_then(Value::as_str).unwrap_or("");
                                let status = params
                                    .get("status")
                                    .and_then(Value::as_u64)
                                    .and_then(|s| u16::try_from(s).ok());
                                let blocked = params.get("blocked").and_then(Value::as_bool).unwrap_or(false);
                                let persist = guard.learner.record_direct_http(url, status, blocked);
                                (
                                    json!({ "id": client_id, "ok": true, "result": { "recorded": true } }),
                                    persist.into_iter().collect(),
                                )
                            }
                        }
                    };
                    if !persists.is_empty() {
                        tokio::task::spawn_blocking(move || {
                            for pb in persists {
                                let _ = bridge_core::routines::save_playbook_preserving_newer_disk_routines(&pb);
                            }
                        });
                    }
                    let _ = tx.send(format!("{reply}\n")).await;
                    continue;
                }

                let mut guard = state.lock().await;
                if !opened {
                    opened = true;
                    guard.sessions.insert(
                        session_id.clone(),
                        ClientSession {
                            subscribed_events: false,
                            tx: tx.clone(),
                        },
                    );
                    let _ = guard.ext_tx.send(json!({
                        "type": "session",
                        "event": "open",
                        "session": session_id,
                    }));
                }
                let prepared = guard.learner.prepare_request(&session_id, method, &mut params);
                let seq = guard.counter.fetch_add(1, Ordering::Relaxed);
                let host_id = format!("{session_id}:{seq}");
                guard.pending.insert(
                    host_id.clone(),
                    PendingRequest {
                        client_id,
                        prepared,
                    },
                );
                let _ = guard.ext_tx.send(json!({
                    "type": "request",
                    "id": host_id,
                    "session": session_id,
                    "method": method,
                    "params": params,
                }));
            }
        }
    }

    if opened {
        let persists = {
            let mut guard = state.lock().await;
            guard.sessions.remove(&session_id);
            let flushed = guard.learner.close_session(&session_id);
            guard.pending.retain(|_, p| p.prepared.session_id != session_id);
            let _ = guard.ext_tx.send(json!({
                "type": "session",
                "event": "close",
                "session": session_id,
            }));
            flushed
        };
        if !persists.is_empty() {
            tokio::task::spawn_blocking(move || {
                for pb in persists {
                    let _ = bridge_core::routines::save_playbook_preserving_newer_disk_routines(&pb);
                }
            });
        }
    }
    drop(tx);
    writer.abort();
}

#[cfg(windows)]
struct BoundIpc {
    pipe_name: String,
    instance_id: String,
    initial_server: tokio::net::windows::named_pipe::NamedPipeServer,
}

#[cfg(windows)]
async fn bind_initial_ipc(user_key: &str, browser: &str, requested_instance_id: &str) -> Option<BoundIpc> {
    let mut candidate = requested_instance_id.to_string();
    for _ in 0..8 {
        let pipe_name = pipes::build(user_key, browser, &candidate).ok()?;
        let path = pipes::windows_pipe_path(&pipe_name);
        match create_current_user_pipe(&path, true) {
            Ok(initial_server) => {
                return Some(BoundIpc {
                    pipe_name,
                    instance_id: candidate,
                    initial_server,
                });
            }
            Err(err)
                if err.kind() == std::io::ErrorKind::PermissionDenied
                    || err.raw_os_error() == Some(5) =>
            {
                candidate = pipes::generate_instance_id();
            }
            Err(_) => return None,
        }
    }
    None
}

#[cfg(windows)]
async fn serve_ipc(bound: BoundIpc, state: Arc<Mutex<State>>) {
    let path = pipes::windows_pipe_path(&bound.pipe_name);
    let mut next_server = Some(bound.initial_server);
    loop {
        let server = match next_server.take() {
            Some(s) => s,
            None => {
                let Ok(s) = create_current_user_pipe(&path, false) else {
                    break;
                };
                s
            }
        };
        if server.connect().await.is_err() {
            break;
        }
        let st = Arc::clone(&state);
        tokio::spawn(async move {
            handle_pipe_client(server, st).await;
        });
    }
}

#[cfg(windows)]
fn create_current_user_pipe(path: &str, first: bool) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use tokio::net::windows::named_pipe::NamedPipeServer;
    use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, LocalFree};
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX};
    use windows_sys::Win32::System::Pipes::{CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT};

    let wide_path: Vec<u16> = std::ffi::OsStr::new(path).encode_wide().chain(Some(0)).collect();
    // Grant full pipe access only to the current user (OW = Owner) and SYSTEM, denying everyone else.
    let sddl: Vec<u16> = std::ffi::OsStr::new("D:(A;;GA;;;OW)(A;;GA;;;SY)").encode_wide().chain(Some(0)).collect();
    let mut sd: PSECURITY_DESCRIPTOR = null_mut();
    let ok = unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut sd, null_mut()) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd,
        bInheritHandle: 0,
    };
    let mut open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
    if first {
        open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    let handle = unsafe {
        CreateNamedPipeW(
            wide_path.as_ptr(),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            255,
            65536,
            65536,
            0,
            &mut sa,
        )
    };
    unsafe { LocalFree(sd.cast()) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    unsafe { NamedPipeServer::from_raw_handle(handle.cast()) }
}

#[cfg(unix)]
struct BoundIpc {
    pipe_name: String,
    instance_id: String,
    listener: tokio::net::UnixListener,
}

#[cfg(unix)]
async fn bind_initial_ipc(user_key: &str, browser: &str, requested_instance_id: &str) -> Option<BoundIpc> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let dir = pipes::unix_socket_dir();
    let _ = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir);
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    let meta = std::fs::symlink_metadata(&dir).ok()?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || (meta.mode() & 0o077) != 0 {
        return None;
    }
    let mut candidate = requested_instance_id.to_string();
    for _ in 0..8 {
        let pipe_name = pipes::build(user_key, browser, &candidate).ok()?;
        let path = dir.join(&pipe_name);
        if std::fs::symlink_metadata(&path).is_ok() {
            let live = tokio::time::timeout(
                std::time::Duration::from_millis(50),
                tokio::net::UnixStream::connect(&path),
            )
            .await
            .is_ok_and(|res| res.is_ok());
            if live {
                candidate = pipes::generate_instance_id();
                continue;
            }
            let _ = std::fs::remove_file(&path);
        }
        if let Ok(listener) = tokio::net::UnixListener::bind(&path) {
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            return Some(BoundIpc {
                pipe_name,
                instance_id: candidate,
                listener,
            });
        }
        candidate = pipes::generate_instance_id();
    }
    None
}

#[cfg(unix)]
async fn serve_ipc(bound: BoundIpc, state: Arc<Mutex<State>>) {
    while let Ok((stream, _)) = bound.listener.accept().await {
        let st = Arc::clone(&state);
        tokio::spawn(async move {
            handle_pipe_client(stream, st).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_core::client::BridgeClient;

    async fn spawn_mock_browser_host(
        user_key: &str,
        browser: &str,
        instance_id: &str,
        label: &str,
        tabs: Arc<Mutex<Vec<(i64, String)>>>,
    ) -> (
        Value,
        mpsc::UnboundedSender<Value>,
        tokio::task::JoinHandle<i32>,
    ) {
        let (ext_to_host_w, host_in) = tokio::io::duplex(65536);
        let (host_out, mut ext_from_host_r) = tokio::io::duplex(65536);
        let uk = user_key.to_string();
        let host_task = tokio::spawn(async move { run_with_streams(host_in, host_out, &uk).await });

        let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<Value>();
        let mut writer = ext_to_host_w;
        let hello = json!({
            "type": "hello",
            "protocol": bridge_core::PROTOCOL_VERSION,
            "browser": browser,
            "browserVersion": "157.0",
            "extensionVersion": bridge_core::VERSION,
            "instanceId": instance_id,
            "label": label,
        });
        write_message(&mut writer, &hello).await.unwrap();
        let host_hello = read_message(&mut ext_from_host_r).await.unwrap().unwrap();

        tokio::spawn(async move {
            while let Some(out_msg) = msg_rx.recv().await {
                if write_message(&mut writer, &out_msg).await.is_err() {
                    break;
                }
            }
        });

        let responder_tx = msg_tx.clone();
        let browser_tag = browser.to_string();
        tokio::spawn(async move {
            while let Ok(Some(msg)) = read_message(&mut ext_from_host_r).await {
                if msg.get("type").and_then(Value::as_str) != Some("request") {
                    continue;
                }
                let id = msg.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
                let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
                let snap_tabs = tabs.lock().await.clone();
                let resp = match method {
                    "status" => json!({
                        "type": "response",
                        "id": id,
                        "ok": true,
                        "result": {
                            "managedApi": 1,
                            "accessibleTabs": snap_tabs.len(),
                            "currentTabId": snap_tabs.first().map(|(t, _)| *t),
                            "readOnlyMode": false,
                            "accessAllTabs": false,
                            "trustedInput": true,
                            "allowEvaluate": false
                        }
                    }),
                    "tabs.inventory" | "tabs.list" => {
                        let items: Vec<Value> = snap_tabs
                            .iter()
                            .map(|(tid, url)| {
                                json!({
                                    "tabId": tid,
                                    "title": format!("{browser_tag}-{tid}"),
                                    "url": url,
                                    "controllable": true,
                                    "mode": "write",
                                    "access": "shared by user"
                                })
                            })
                            .collect();
                        json!({ "type": "response", "id": id, "ok": true, "result": { "tabs": items } })
                    }
                    "page.snapshot" | "page.info" => {
                        let req_tid = params
                            .get("tabId")
                            .and_then(Value::as_i64)
                            .or_else(|| snap_tabs.first().map(|(t, _)| *t));
                        if let Some((tid, url)) = req_tid.and_then(|t| snap_tabs.iter().find(|(id, _)| *id == t).cloned()) {
                            json!({
                                "type": "response",
                                "id": id,
                                "ok": true,
                                "result": {
                                    "tabId": tid,
                                    "browser": browser_tag,
                                    "url": url,
                                    "title": format!("{browser_tag}-{tid}"),
                                    "text": format!("URL: {url}\n[{browser_tag} tab {tid}]")
                                }
                            })
                        } else {
                            json!({
                                "type": "response",
                                "id": id,
                                "ok": false,
                                "error": { "code": "no_tab", "message": "Tab does not exist." }
                            })
                        }
                    }
                    _ => json!({ "type": "response", "id": id, "ok": true, "result": {} }),
                };
                let _ = responder_tx.send(resp);
            }
        });

        (host_hello, msg_tx, host_task)
    }

    #[tokio::test]
    async fn multi_browser_zero_collision_routing_and_cloned_instance_self_heal() {
        let user_key = format!("bbtest-{}", pipes::generate_instance_id());
        let edge_tabs = Arc::new(Mutex::new(vec![
            (101_i64, "https://github.com/org/repo".to_string()),
            (2_i64, "https://edge-only.example/two".to_string()),
        ]));
        let chrome_tabs = Arc::new(Mutex::new(vec![
            (202_i64, "https://docs.google.com/document/d/1".to_string()),
            (2_i64, "https://chrome-only.example/two".to_string()),
        ]));
        let clone_tabs = Arc::new(Mutex::new(vec![
            (303_i64, "https://x.com/home".to_string()),
        ]));

        let (edge_hello, _edge_tx, edge_task) =
            spawn_mock_browser_host(&user_key, "edge", "aaaaaaaaaaaa", "", Arc::clone(&edge_tabs)).await;
        let (chrome_hello, chrome_tx, chrome_task) =
            spawn_mock_browser_host(&user_key, "chrome", "bbbbbbbbbbbb", "Work Profile", Arc::clone(&chrome_tabs)).await;
        // Cloned Chrome profile booting with the EXACT same instanceId "bbbbbbbbbbbb":
        let (clone_hello, _clone_tx, clone_task) =
            spawn_mock_browser_host(&user_key, "chrome", "bbbbbbbbbbbb", "", Arc::clone(&clone_tabs)).await;

        assert_eq!(edge_hello.get("instanceId").and_then(Value::as_str), Some("aaaaaaaaaaaa"));
        assert_eq!(chrome_hello.get("instanceId").and_then(Value::as_str), Some("bbbbbbbbbbbb"));
        let rotated_id = clone_hello.get("instanceId").and_then(Value::as_str).unwrap();
        assert_ne!(rotated_id, "bbbbbbbbbbbb", "Cloned profile instanceId must self-heal immediately!");
        assert_eq!(rotated_id.len(), 12);

        let client = BridgeClient::with_user_key("multi-test", false, &user_key);
        let timeout = std::time::Duration::from_secs(5);

        // 1. Without specifying browser, tabId=202 auto-routes straight to Chrome (even though Edge has higher default priority)!
        let (res_202, conn_202) = client
            .send("page.snapshot", json!({ "tabId": 202 }), None, timeout)
            .await
            .unwrap();
        assert_eq!(conn_202.endpoint.browser, "chrome");
        assert_eq!(conn_202.endpoint.instance_id, "bbbbbbbbbbbb");
        assert!(res_202.get("text").and_then(Value::as_str).unwrap().contains("[chrome tab 202]"));

        // 2. Without specifying browser, tabId=303 auto-routes straight to the self-healed cloned Chrome profile!
        let (res_303, conn_303) = client
            .send("page.snapshot", json!({ "tabId": 303 }), None, timeout)
            .await
            .unwrap();
        assert_eq!(conn_303.endpoint.instance_id, rotated_id);
        assert!(res_303.get("text").and_then(Value::as_str).unwrap().contains("[chrome tab 303]"));

        // 3. Warm routing speed benchmark across 3 live browser pipes: 20 alternating cross-browser calls!
        let bench_start = std::time::Instant::now();
        for i in 0..20 {
            let target_tid = if i % 2 == 0 { 101 } else { 202 };
            let (_, c) = client
                .send("page.info", json!({ "tabId": target_tid }), None, timeout)
                .await
                .unwrap();
            assert_eq!(c.endpoint.browser, if i % 2 == 0 { "edge" } else { "chrome" });
        }
        let avg_us = bench_start.elapsed().as_micros() / 20;
        assert!(
            avg_us < 2_500,
            "Warm cross-browser tab routing should be sub-millisecond/ultra-fast, got {avg_us} us/call"
        );

        // 4. Colliding tabId=2 shared in BOTH Edge and Chrome refuses to guess when browser is omitted!
        let Err(ambig) = client
            .send("page.snapshot", json!({ "tabId": 2 }), None, timeout)
            .await
        else {
            panic!("expected ambiguous_tab error for colliding tabId=2");
        };
        assert_eq!(ambig.code(), "ambiguous_tab");
        assert!(ambig.message().contains("edge:aaaa"));
        assert!(ambig.message().contains("chrome:work-profile"));

        // 5. Passing composite browser:label ("chrome:Work-Profile") disambiguates tabId=2 immediately!
        let (res_disambig, conn_disambig) = client
            .send("page.snapshot", json!({ "tabId": 2 }), Some("chrome:Work-Profile"), timeout)
            .await
            .unwrap();
        assert_eq!(conn_disambig.endpoint.instance_id, "bbbbbbbbbbbb");
        assert!(res_disambig.get("text").and_then(Value::as_str).unwrap().contains("[chrome tab 2]"));

        // 6. Push invalidation via tabs.changed: Chrome shares a brand-new tab 909 -> immediately routed!
        chrome_tabs.lock().await.push((909, "https://linear.app/issue/1".to_string()));
        let _ = chrome_tx.send(json!({ "type": "event", "event": "tabs.changed" }));
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let (res_909, conn_909) = client
            .send("page.snapshot", json!({ "tabId": 909 }), None, timeout)
            .await
            .unwrap();
        assert_eq!(conn_909.endpoint.instance_id, "bbbbbbbbbbbb");
        assert!(res_909.get("text").and_then(Value::as_str).unwrap().contains("[chrome tab 909]"));

        client.close_all().await;
        edge_task.abort();
        chrome_task.abort();
        clone_task.abort();
    }
}
