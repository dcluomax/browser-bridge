use crate::pipes::{self, BridgeEndpoint};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, broadcast, oneshot};

#[derive(Debug, Clone)]
pub enum BridgeError {
    Command { code: String, message: String },
    Unavailable(String),
    Io(String),
}

impl BridgeError {
    pub fn code(&self) -> &str {
        match self {
            Self::Command { code, .. } => code,
            Self::Unavailable(_) => "unavailable",
            Self::Io(_) => "connection_lost",
        }
    }
    pub fn message(&self) -> &str {
        match self {
            Self::Command { message, .. } => message,
            Self::Unavailable(m) | Self::Io(m) => m,
        }
    }
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Command { code, message } => write!(f, "{message} [{code}]"),
            Self::Unavailable(m) | Self::Io(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for BridgeError {}

#[derive(Debug, Clone)]
pub struct BrowserEvent {
    pub pipe_name: String,
    pub event: String,
    pub data: Value,
}

trait AsyncReadWrite: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> AsyncReadWrite for T {}

pub struct BridgeConnection {
    pub endpoint: BridgeEndpoint,
    pub info: Value,
    closed: Arc<AtomicBool>,
    next_id: AtomicI64,
    writer: Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    reader_task: tokio::task::JoinHandle<()>,
}

impl BridgeConnection {
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    pub fn label(&self) -> &str {
        self.info.get("label").and_then(Value::as_str).unwrap_or("")
    }

    pub fn describe(&self) -> String {
        let label = self.label();
        let label_part = if label.is_empty() { String::new() } else { format!(" \"{label}\"") };
        let bv = self.info.get("browserVersion").and_then(Value::as_str).unwrap_or("");
        let ev = self.info.get("extensionVersion").and_then(Value::as_str).unwrap_or("");
        let hv = self.info.get("hostVersion").and_then(Value::as_str).unwrap_or("");
        format!(
            "{}{label_part} {bv} (instance {}, extension {ev}, host {hv})",
            self.endpoint.browser, self.endpoint.instance_id
        )
    }

    pub async fn connect(
        endpoint: BridgeEndpoint,
        client_name: &str,
        subscribe_events: bool,
        event_tx: Option<broadcast::Sender<BrowserEvent>>,
        timeout: Duration,
    ) -> Result<Self, BridgeError> {
        let stream = connect_stream(&endpoint.pipe_name, timeout).await?;
        let (read_half, mut write_half) = tokio::io::split(stream);

        let hello = json!({
            "type": "hello",
            "client": client_name,
            "pid": std::process::id(),
            "events": subscribe_events,
        });
        let hello_bytes = format!("{hello}\n");
        tokio::time::timeout(timeout, async {
            write_half.write_all(hello_bytes.as_bytes()).await?;
            write_half.flush().await
        })
        .await
        .map_err(|_| BridgeError::Unavailable(format!("Timed out connecting to {}.", endpoint.browser)))?
        .map_err(|e| BridgeError::Unavailable(format!("Could not connect to {} ({e}).", endpoint.browser)))?;

        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        let n = tokio::time::timeout(timeout, reader.read_line(&mut line))
            .await
            .map_err(|_| BridgeError::Unavailable(format!("Timed out waiting for {} hello.", endpoint.browser)))?
            .map_err(|e| BridgeError::Unavailable(format!("Could not read {} hello ({e}).", endpoint.browser)))?;
        if n == 0 {
            return Err(BridgeError::Unavailable(format!("{} closed the connection immediately.", endpoint.browser)));
        }
        let info: Value = serde_json::from_str(&line)
            .map_err(|e| BridgeError::Unavailable(format!("Invalid hello JSON from {}: {e}", endpoint.browser)))?;

        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let pending_clone = Arc::clone(&pending);
        let closed_clone = Arc::clone(&closed);
        let pipe_name = endpoint.pipe_name.clone();

        let reader_task = tokio::spawn(async move {
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                        if let Some(id) = msg.get("id").and_then(Value::as_i64) {
                            if let Some(tx) = pending_clone.lock().await.remove(&id) {
                                let _ = tx.send(msg);
                            }
                        } else if msg.get("type").and_then(Value::as_str) == Some("event") {
                            if let Some(tx) = &event_tx {
                                let event = msg.get("event").and_then(Value::as_str).unwrap_or("").to_string();
                                let data = msg.get("data").cloned().unwrap_or(Value::Null);
                                let _ = tx.send(BrowserEvent { pipe_name: pipe_name.clone(), event, data });
                            }
                        }
                    }
                }
            }
            closed_clone.store(true, Ordering::Relaxed);
            pending_clone.lock().await.clear();
        });

        Ok(Self {
            endpoint,
            info,
            closed,
            next_id: AtomicI64::new(1),
            writer: Mutex::new(Box::new(write_half)),
            pending,
            reader_task,
        })
    }

    pub async fn send(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, BridgeError> {
        if self.is_closed() {
            return Err(BridgeError::Io("The browser connection is closed.".to_string()));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let payload = format!(
            "{}\n",
            json!({
                "id": id,
                "method": method,
                "params": if params.is_object() { params } else { json!({}) },
            })
        );
        let write_result = {
            let mut writer = self.writer.lock().await;
            let res = writer.write_all(payload.as_bytes()).await;
            if res.is_ok() {
                writer.flush().await
            } else {
                res
            }
        };
        if let Err(err) = write_result {
            self.closed.store(true, Ordering::Relaxed);
            self.pending.lock().await.remove(&id);
            return Err(BridgeError::Io(format!("The browser connection was lost ({err}).")));
        }

        let response = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(val)) => val,
            Ok(Err(_)) => {
                return Err(BridgeError::Io("The browser connection was closed while waiting for a response.".to_string()));
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                return Err(BridgeError::Command {
                    code: "timeout".to_string(),
                    message: format!("The browser did not answer {method} within {}s.", timeout.as_secs()),
                });
            }
        };

        if response.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(response.get("result").cloned().unwrap_or(Value::Null));
        }
        let err = response.get("error");
        let code = err.and_then(|e| e.get("code")).and_then(Value::as_str).unwrap_or("error").to_string();
        let message = err.and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or("The browser reported an error.").to_string();
        Err(BridgeError::Command { code, message })
    }
}

impl Drop for BridgeConnection {
    fn drop(&mut self) {
        self.reader_task.abort();
    }
}

async fn connect_stream(pipe_name: &str, timeout: Duration) -> Result<Box<dyn AsyncReadWrite>, BridgeError> {
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        let path = pipes::windows_pipe_path(pipe_name);
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match ClientOptions::new().open(&path) {
                Ok(client) => return Ok(Box::new(client)),
                Err(err) if err.raw_os_error() == Some(231) && tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(err) => {
                    return Err(BridgeError::Unavailable(format!("Could not connect to {pipe_name}: {err}")));
                }
            }
        }
    }
    #[cfg(unix)]
    {
        let path = pipes::unix_socket_path(pipe_name);
        let stream = tokio::time::timeout(timeout, tokio::net::UnixStream::connect(&path))
            .await
            .map_err(|_| BridgeError::Unavailable(format!("Timed out connecting to {}.", path.display())))?
            .map_err(|err| BridgeError::Unavailable(format!("Could not connect to {}: {err}", path.display())))?;
        Ok(Box::new(stream))
    }
}

pub fn choose<'a, F>(
    endpoints: &'a [BridgeEndpoint],
    selector: Option<&str>,
    selected_pipe: Option<&str>,
    label_of: F,
) -> Result<&'a BridgeEndpoint, BridgeError>
where
    F: Fn(&BridgeEndpoint) -> String,
{
    if endpoints.is_empty() {
        return Err(BridgeError::Unavailable(
            "No browser is connected to Browser Bridge. Make sure Edge, Chrome or Firefox is running with the Browser Bridge extension loaded (toolbar icon shows a green dot) and that the native host is installed.".to_string(),
        ));
    }
    if let Some(sel) = selector.map(str::trim).filter(|s| !s.is_empty()) {
        let found = endpoints
            .iter()
            .find(|e| e.instance_id.eq_ignore_ascii_case(sel))
            .or_else(|| endpoints.iter().find(|e| label_of(e).eq_ignore_ascii_case(sel)))
            .or_else(|| endpoints.iter().find(|e| e.browser.eq_ignore_ascii_case(sel)))
            .or_else(|| {
                if sel.eq_ignore_ascii_case("chrome") {
                    endpoints.iter().find(|e| e.browser == "chromium")
                } else {
                    None
                }
            });
        return found.ok_or_else(|| {
            let list: Vec<String> = endpoints
                .iter()
                .map(|e| {
                    let lbl = label_of(e);
                    if lbl.is_empty() {
                        format!("{} ({})", e.browser, e.instance_id)
                    } else {
                        format!("{} \"{lbl}\" ({})", e.browser, e.instance_id)
                    }
                })
                .collect();
            BridgeError::Unavailable(format!("No connected browser matches \"{sel}\". Connected: {}.", list.join(", ")))
        });
    }
    if let Some(pipe) = selected_pipe {
        if let Some(ep) = endpoints.iter().find(|e| e.pipe_name == pipe) {
            return Ok(ep);
        }
    }
    let rank = |browser: &str| match browser {
        "edge" => 0,
        "chrome" => 1,
        "chromium" => 2,
        "firefox" => 3,
        _ => 4,
    };
    Ok(endpoints.iter().min_by_key(|e| rank(&e.browser)).unwrap())
}

pub fn is_idempotent_read(method: &str) -> bool {
    matches!(
        method,
        "status"
            | "tabs.list"
            | "tabs.inventory"
            | "page.snapshot"
            | "page.text"
            | "page.info"
            | "page.locate"
            | "page.query"
            | "page.queryAll"
            | "page.screenshot"
    )
}

pub struct BridgeClient {
    client_name: String,
    subscribe_events: bool,
    event_tx: broadcast::Sender<BrowserEvent>,
    connections: Mutex<HashMap<String, Arc<BridgeConnection>>>,
    selected_pipe: Mutex<Option<String>>,
}

impl BridgeClient {
    pub fn new(client_name: impl Into<String>, subscribe_events: bool) -> Self {
        let (event_tx, _) = broadcast::channel(64);
        Self {
            client_name: client_name.into(),
            subscribe_events,
            event_tx,
            connections: Mutex::new(HashMap::new()),
            selected_pipe: Mutex::new(None),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BrowserEvent> {
        self.event_tx.subscribe()
    }

    pub fn discover(&self) -> Vec<BridgeEndpoint> {
        pipes::enumerate(&pipes::current_user_key())
    }

    pub async fn connect_endpoint(&self, endpoint: &BridgeEndpoint) -> Result<Arc<BridgeConnection>, BridgeError> {
        let mut conns = self.connections.lock().await;
        if let Some(existing) = conns.get(&endpoint.pipe_name) {
            if !existing.is_closed() {
                return Ok(Arc::clone(existing));
            }
            conns.remove(&endpoint.pipe_name);
        }
        let conn = Arc::new(
            BridgeConnection::connect(
                endpoint.clone(),
                &self.client_name,
                self.subscribe_events,
                Some(self.event_tx.clone()),
                Duration::from_secs(5),
            )
            .await?,
        );
        conns.insert(endpoint.pipe_name.clone(), Arc::clone(&conn));
        Ok(conn)
    }

    pub async fn connect_all(&self) -> Vec<(BridgeEndpoint, Option<Arc<BridgeConnection>>, Option<String>)> {
        let endpoints = self.discover();
        let mut results = Vec::with_capacity(endpoints.len());
        for ep in endpoints {
            match self.connect_endpoint(&ep).await {
                Ok(conn) => results.push((ep, Some(conn), None)),
                Err(err) => results.push((ep, None, Some(err.message().to_string()))),
            }
        }
        results
    }

    pub async fn get_connection(&self, selector: Option<&str>) -> Result<Arc<BridgeConnection>, BridgeError> {
        let endpoints = self.discover();
        {
            let mut conns = self.connections.lock().await;
            conns.retain(|pipe, _| endpoints.iter().any(|e| &e.pipe_name == pipe));
        }
        let labels: HashMap<String, String> = {
            let conns = self.connections.lock().await;
            conns.iter().map(|(k, v)| (k.clone(), v.label().to_string())).collect()
        };
        let selected = self.selected_pipe.lock().await.clone();
        let target = choose(&endpoints, selector, selected.as_deref(), |e| {
            labels.get(&e.pipe_name).cloned().unwrap_or_default()
        })?
        .clone();
        *self.selected_pipe.lock().await = Some(target.pipe_name.clone());
        self.connect_endpoint(&target).await
    }

    pub async fn send(
        &self,
        method: &str,
        params: Value,
        selector: Option<&str>,
        timeout: Duration,
    ) -> Result<(Value, Arc<BridgeConnection>), BridgeError> {
        if selector.is_some_and(|s| !s.trim().is_empty()) {
            let _ = self.connect_all().await;
        }
        let mut attempt = 0;
        loop {
            let conn = self.get_connection(selector).await?;
            match conn.send(method, params.clone(), timeout).await {
                Ok(val) => return Ok((val, conn)),
                Err(BridgeError::Io(msg)) if attempt == 0 && (is_idempotent_read(method) || method == "status") => {
                    attempt += 1;
                    self.connections.lock().await.remove(&conn.endpoint.pipe_name);
                    let _ = msg;
                }
                Err(BridgeError::Io(msg)) => return Err(BridgeError::Unavailable(msg)),
                Err(err) => return Err(err),
            }
        }
    }

    pub async fn close_all(&self) {
        let mut conns = self.connections.lock().await;
        conns.clear();
        *self.selected_pipe.lock().await = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_explicit_selector_then_current_then_priority() {
        let edge = BridgeEndpoint { pipe_name: "p.edge".into(), browser: "edge".into(), instance_id: "aaaaaaaaaaaa".into() };
        let firefox = BridgeEndpoint { pipe_name: "p.firefox".into(), browser: "firefox".into(), instance_id: "bbbbbbbbbbbb".into() };
        let chromium = BridgeEndpoint { pipe_name: "p.chromium".into(), browser: "chromium".into(), instance_id: "cccccccccccc".into() };
        let all = vec![firefox.clone(), chromium.clone(), edge.clone()];
        let label = |e: &BridgeEndpoint| if e == &firefox { "Personal".to_string() } else { String::new() };

        assert_eq!(choose(&all, Some("firefox"), None, label).unwrap(), &firefox);
        assert_eq!(choose(&all, Some("personal"), None, label).unwrap(), &firefox);
        assert_eq!(choose(&all, Some("chrome"), None, label).unwrap(), &chromium);
        assert_eq!(choose(&all, Some("cccccccccccc"), None, label).unwrap(), &chromium);
        assert_eq!(choose(&all, None, Some("p.firefox"), label).unwrap(), &firefox);
        assert_eq!(choose(&all, None, None, label).unwrap(), &edge);
    }

    #[test]
    fn explains_missing_browsers() {
        let edge = BridgeEndpoint { pipe_name: "p.edge".into(), browser: "edge".into(), instance_id: "aaaaaaaaaaaa".into() };
        assert!(choose(&[], None, None, |_| String::new()).unwrap_err().to_string().contains("No browser is connected"));
        assert!(choose(&[edge], Some("safari"), None, |_| String::new()).unwrap_err().to_string().contains("Connected: edge"));
    }
}
