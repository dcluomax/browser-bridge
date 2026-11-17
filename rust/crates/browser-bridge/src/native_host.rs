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
    let instance_id = first.get("instanceId").and_then(Value::as_str).unwrap_or("");
    let Ok(pipe_name) = pipes::build(user_key, browser, instance_id) else {
        return 2;
    };

    let guide_path = bridge_core::ensure_agent_guide(None).display().to_string();
    let mut extension_info = first.clone();
    if let Some(obj) = extension_info.as_object_mut() {
        obj.insert("hostVersion".into(), Value::String(bridge_core::VERSION.into()));
        obj.insert("pipeName".into(), Value::String(pipe_name.clone()));
        obj.insert("agentGuide".into(), Value::String(guide_path.clone()));
    }

    let host_hello = json!({
        "type": "hostHello",
        "protocol": bridge_core::PROTOCOL_VERSION,
        "hostVersion": bridge_core::VERSION,
        "pipeName": pipe_name,
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
    let pipe_for_listener = pipe_name.clone();
    let listener_task = tokio::spawn(async move {
        serve_ipc(&pipe_for_listener, listener_state).await;
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

            let (tx, client_id, to_persist) = {
                let mut guard = state.lock().await;
                let Some(pending) = guard.pending.remove(req_id) else {
                    return;
                };
                let to_persist = guard.learner.observe_response(
                    &pending.prepared,
                    ok,
                    clean_res.as_mut(),
                    err_ref,
                );
                let Some(session) = guard.sessions.get(&pending.prepared.session_id) else {
                    if let Some(pb) = to_persist {
                        tokio::task::spawn_blocking(move || {
                            let _ = bridge_core::routines::save_playbook(&pb);
                        });
                    }
                    return;
                };
                (session.tx.clone(), pending.client_id, to_persist)
            };

            if let Some(pb) = to_persist {
                tokio::task::spawn_blocking(move || {
                    let _ = bridge_core::routines::save_playbook(&pb);
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
            let guide = guard.extension_info.get("agentGuide").cloned().unwrap_or(Value::Null);
            let mut updated = msg;
            if let Some(obj) = updated.as_object_mut() {
                obj.insert("hostVersion".into(), Value::String(bridge_core::VERSION.into()));
                obj.insert("pipeName".into(), pipe);
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
                    let (reply, to_persist) = {
                        let mut guard = state.lock().await;
                        match method {
                            "site.profile" => {
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
                                        (json!({ "id": client_id, "ok": true, "result": pb }), None)
                                    }
                                    None => (
                                        json!({
                                            "id": client_id,
                                            "ok": false,
                                            "error": { "code": "bad_request", "message": "Provide domain or a tabId with a loaded URL." }
                                        }),
                                        None,
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
                                    Ok((_, pb)) => (json!({ "id": client_id, "ok": true, "result": pb }), None),
                                    Err(e) => (
                                        json!({ "id": client_id, "ok": false, "error": { "code": "bad_request", "message": e } }),
                                        None,
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
                                (json!({ "id": client_id, "ok": true, "result": { "recorded": true } }), persist)
                            }
                        }
                    };
                    if let Some(pb) = to_persist {
                        tokio::task::spawn_blocking(move || {
                            let _ = bridge_core::routines::save_playbook(&pb);
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
        let mut guard = state.lock().await;
        guard.sessions.remove(&session_id);
        guard.learner.close_session(&session_id);
        guard.pending.retain(|_, p| p.prepared.session_id != session_id);
        let _ = guard.ext_tx.send(json!({
            "type": "session",
            "event": "close",
            "session": session_id,
        }));
    }
    drop(tx);
    writer.abort();
}

#[cfg(windows)]
async fn serve_ipc(pipe_name: &str, state: Arc<Mutex<State>>) {
    let path = pipes::windows_pipe_path(pipe_name);
    let mut first = true;
    loop {
        let Ok(server) = create_current_user_pipe(&path, first) else {
            break;
        };
        first = false;
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
async fn serve_ipc(pipe_name: &str, state: Arc<Mutex<State>>) {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let dir = pipes::unix_socket_dir();
    let _ = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir);
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    let Ok(meta) = std::fs::symlink_metadata(&dir) else {
        return;
    };
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || (meta.mode() & 0o077) != 0 {
        return;
    }
    let path = dir.join(pipe_name);
    let _ = std::fs::remove_file(&path);
    let Ok(listener) = tokio::net::UnixListener::bind(&path) else {
        return;
    };
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    while let Ok((stream, _)) = listener.accept().await {
        let st = Arc::clone(&state);
        tokio::spawn(async move {
            handle_pipe_client(stream, st).await;
        });
    }
}
