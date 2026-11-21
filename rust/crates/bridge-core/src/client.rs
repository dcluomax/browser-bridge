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
        Self::connect_with_dirty(endpoint, client_name, subscribe_events, event_tx, None, timeout).await
    }

    pub async fn connect_with_dirty(
        endpoint: BridgeEndpoint,
        client_name: &str,
        subscribe_events: bool,
        event_tx: Option<broadcast::Sender<BrowserEvent>>,
        inventory_dirty: Option<Arc<AtomicBool>>,
        timeout: Duration,
    ) -> Result<Self, BridgeError> {
        let stream = connect_stream(&endpoint.pipe_name, timeout).await?;
        let (read_half, mut write_half) = tokio::io::split(stream);

        let hello = json!({
            "type": "hello",
            "client": client_name,
            "pid": std::process::id(),
            "events": subscribe_events || inventory_dirty.is_some(),
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
                            let event = msg.get("event").and_then(Value::as_str).unwrap_or("").to_string();
                            if event == "tabs.changed" {
                                if let Some(d) = &inventory_dirty {
                                    d.store(true, Ordering::Release);
                                }
                            }
                            if subscribe_events {
                                if let Some(tx) = &event_tx {
                                    let data = msg.get("data").cloned().unwrap_or(Value::Null);
                                    let _ = tx.send(BrowserEvent { pipe_name: pipe_name.clone(), event, data });
                                }
                            }
                        }
                    }
                }
            }
            closed_clone.store(true, Ordering::Relaxed);
            if let Some(d) = &inventory_dirty {
                d.store(true, Ordering::Release);
            }
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

pub fn normalize_label_slug(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut prev_sep = true;
    for ch in value.trim().chars() {
        if ch.is_whitespace() || matches!(ch, '-' | '_' | '[' | ']') {
            if !prev_sep {
                out.push('-');
                prev_sep = true;
            }
        } else {
            for lc in ch.to_lowercase() {
                out.push(lc);
            }
            prev_sep = false;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn is_hex_prefix(value: &str) -> bool {
    (4..=12).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn label_matches(actual: &str, query: &str) -> bool {
    if actual.is_empty() || query.is_empty() {
        return false;
    }
    if actual.eq_ignore_ascii_case(query) {
        return true;
    }
    let s_actual = normalize_label_slug(actual);
    let s_query = normalize_label_slug(query);
    !s_actual.is_empty() && s_actual == s_query
}

fn describe_endpoint_choice(ep: &BridgeEndpoint, label: &str) -> String {
    if label.is_empty() {
        format!("{}:{}", ep.browser, ep.instance_id)
    } else {
        format!("{}:{label} ({})", ep.browser, ep.instance_id)
    }
}

pub fn choose_candidates<'a, F>(
    endpoints: &'a [BridgeEndpoint],
    selector: &str,
    label_of: &F,
) -> Vec<&'a BridgeEndpoint>
where
    F: Fn(&BridgeEndpoint) -> String,
{
    let sel = selector.trim();
    if sel.is_empty() {
        return Vec::new();
    }
    if let Some((b_raw, q_raw)) = sel.split_once(':') {
        let b = b_raw.trim();
        let q = q_raw.trim();
        if b.is_empty() || q.is_empty() {
            return Vec::new();
        }
        let mut pool: Vec<&'a BridgeEndpoint> = endpoints
            .iter()
            .filter(|e| e.browser.eq_ignore_ascii_case(b))
            .collect();
        if pool.is_empty() && b.eq_ignore_ascii_case("chrome") {
            pool = endpoints.iter().filter(|e| e.browser == "chromium").collect();
        }
        if pool.is_empty() {
            return Vec::new();
        }
        let exact_id: Vec<&'a BridgeEndpoint> = pool
            .iter()
            .copied()
            .filter(|e| e.instance_id.eq_ignore_ascii_case(q))
            .collect();
        if !exact_id.is_empty() {
            return exact_id;
        }
        let by_label: Vec<&'a BridgeEndpoint> = pool
            .iter()
            .copied()
            .filter(|e| label_matches(&label_of(e), q))
            .collect();
        if !by_label.is_empty() {
            return by_label;
        }
        if is_hex_prefix(q) {
            let q_low = q.to_ascii_lowercase();
            let by_prefix: Vec<&'a BridgeEndpoint> = pool
                .iter()
                .copied()
                .filter(|e| e.instance_id.starts_with(&q_low))
                .collect();
            if !by_prefix.is_empty() {
                return by_prefix;
            }
        }
        return Vec::new();
    }

    let exact_id: Vec<&'a BridgeEndpoint> = endpoints
        .iter()
        .filter(|e| e.instance_id.eq_ignore_ascii_case(sel))
        .collect();
    if !exact_id.is_empty() {
        return exact_id;
    }
    let by_label: Vec<&'a BridgeEndpoint> = endpoints
        .iter()
        .filter(|e| label_matches(&label_of(e), sel))
        .collect();
    if !by_label.is_empty() {
        return by_label;
    }
    let by_browser: Vec<&'a BridgeEndpoint> = endpoints
        .iter()
        .filter(|e| e.browser.eq_ignore_ascii_case(sel))
        .collect();
    if !by_browser.is_empty() {
        return by_browser;
    }
    if sel.eq_ignore_ascii_case("chrome") {
        let by_chromium: Vec<&'a BridgeEndpoint> = endpoints
            .iter()
            .filter(|e| e.browser == "chromium")
            .collect();
        if !by_chromium.is_empty() {
            return by_chromium;
        }
    }
    if is_hex_prefix(sel) {
        let low = sel.to_ascii_lowercase();
        let by_prefix: Vec<&'a BridgeEndpoint> = endpoints
            .iter()
            .filter(|e| e.instance_id.starts_with(&low))
            .collect();
        if !by_prefix.is_empty() {
            return by_prefix;
        }
    }
    Vec::new()
}

fn browser_priority_rank(browser: &str) -> u8 {
    match browser {
        "edge" => 0,
        "chrome" => 1,
        "chromium" => 2,
        "firefox" => 3,
        _ => 4,
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
        let matches = choose_candidates(endpoints, sel, &label_of);
        return match matches.as_slice() {
            [] => {
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
                Err(BridgeError::Unavailable(format!(
                    "No connected browser matches \"{sel}\". Connected: {}.",
                    list.join(", ")
                )))
            }
            [only] => Ok(*only),
            many => {
                let choices: Vec<String> = many
                    .iter()
                    .map(|e| describe_endpoint_choice(e, &label_of(e)))
                    .collect();
                Err(BridgeError::Command {
                    code: "ambiguous_browser".to_string(),
                    message: format!(
                        "Multiple connected browsers match \"{sel}\": {}. Pass browser:label or browser:instanceId (e.g. \"{}:{}\") to disambiguate.",
                        choices.join(", "),
                        many[0].browser,
                        &many[0].instance_id[..4]
                    ),
                })
            }
        };
    }
    if let Some(pipe) = selected_pipe {
        if let Some(ep) = endpoints.iter().find(|e| e.pipe_name == pipe) {
            return Ok(ep);
        }
    }
    Ok(endpoints.iter().min_by_key(|e| browser_priority_rank(&e.browser)).unwrap())
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
            | "page.media"
            | "page.screenshot"
    )
}

const ENDPOINT_CACHE_TTL: Duration = Duration::from_millis(250);

#[derive(Default)]
struct EndpointCache {
    endpoints: Vec<BridgeEndpoint>,
    pipe_sig: u64,
    discovered_at: Option<std::time::Instant>,
}

#[derive(Debug, Clone)]
pub struct TabOwnerInfo {
    pub pipe_name: String,
    pub browser: String,
    pub instance_id: String,
    pub label: String,
    pub url: String,
    pub controllable: bool,
}

#[derive(Default)]
struct RoutingTable {
    tab_owners: HashMap<i64, Vec<TabOwnerInfo>>,
    controllable_counts: HashMap<String, usize>,
    synced_pipe_sig: u64,
}

#[derive(Default)]
struct SelectionState {
    pipe_name: Option<String>,
    explicit: bool,
}

fn compute_pipe_sig(endpoints: &[BridgeEndpoint]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut names: Vec<&str> = endpoints.iter().map(|e| e.pipe_name.as_str()).collect();
    names.sort_unstable();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    names.hash(&mut hasher);
    hasher.finish()
}

pub struct BridgeClient {
    client_name: String,
    user_key: String,
    subscribe_events: bool,
    event_tx: broadcast::Sender<BrowserEvent>,
    inventory_dirty: Arc<AtomicBool>,
    endpoint_cache: Mutex<EndpointCache>,
    routing: Mutex<RoutingTable>,
    connections: Mutex<HashMap<String, Arc<BridgeConnection>>>,
    selection: Mutex<SelectionState>,
}

impl BridgeClient {
    pub fn new(client_name: impl Into<String>, subscribe_events: bool) -> Self {
        Self::with_user_key(client_name, subscribe_events, pipes::current_user_key())
    }

    pub fn with_user_key(
        client_name: impl Into<String>,
        subscribe_events: bool,
        user_key: impl Into<String>,
    ) -> Self {
        let (event_tx, _) = broadcast::channel(64);
        Self {
            client_name: client_name.into(),
            user_key: user_key.into(),
            subscribe_events,
            event_tx,
            inventory_dirty: Arc::new(AtomicBool::new(true)),
            endpoint_cache: Mutex::new(EndpointCache::default()),
            routing: Mutex::new(RoutingTable::default()),
            connections: Mutex::new(HashMap::new()),
            selection: Mutex::new(SelectionState::default()),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BrowserEvent> {
        self.event_tx.subscribe()
    }

    pub fn discover(&self) -> Vec<BridgeEndpoint> {
        pipes::enumerate(&self.user_key)
    }

    async fn discover_cached(&self, force: bool) -> (Vec<BridgeEndpoint>, u64) {
        {
            let cache = self.endpoint_cache.lock().await;
            if !force
                && !self.inventory_dirty.load(Ordering::Acquire)
                && !cache.endpoints.is_empty()
                && cache.discovered_at.is_some_and(|t| t.elapsed() < ENDPOINT_CACHE_TTL)
            {
                return (cache.endpoints.clone(), cache.pipe_sig);
            }
        }
        let endpoints = pipes::enumerate(&self.user_key);
        let sig = compute_pipe_sig(&endpoints);
        let mut cache = self.endpoint_cache.lock().await;
        if cache.pipe_sig != sig {
            self.inventory_dirty.store(true, Ordering::Release);
        }
        cache.endpoints = endpoints.clone();
        cache.pipe_sig = sig;
        cache.discovered_at = Some(std::time::Instant::now());
        (endpoints, sig)
    }

    pub async fn connect_endpoint(&self, endpoint: &BridgeEndpoint) -> Result<Arc<BridgeConnection>, BridgeError> {
        {
            let mut conns = self.connections.lock().await;
            if let Some(existing) = conns.get(&endpoint.pipe_name) {
                if !existing.is_closed() {
                    return Ok(Arc::clone(existing));
                }
                conns.remove(&endpoint.pipe_name);
            }
        }
        let conn = Arc::new(
            BridgeConnection::connect_with_dirty(
                endpoint.clone(),
                &self.client_name,
                self.subscribe_events,
                Some(self.event_tx.clone()),
                Some(Arc::clone(&self.inventory_dirty)),
                Duration::from_secs(5),
            )
            .await?,
        );
        let mut conns = self.connections.lock().await;
        if let Some(existing) = conns.get(&endpoint.pipe_name) {
            if !existing.is_closed() {
                return Ok(Arc::clone(existing));
            }
        }
        conns.insert(endpoint.pipe_name.clone(), Arc::clone(&conn));
        Ok(conn)
    }

    pub async fn connect_all(&self) -> Vec<(BridgeEndpoint, Option<Arc<BridgeConnection>>, Option<String>)> {
        let (endpoints, _) = self.discover_cached(true).await;
        self.connect_endpoints_parallel(&endpoints).await
    }

    async fn connect_endpoints_parallel(
        &self,
        endpoints: &[BridgeEndpoint],
    ) -> Vec<(BridgeEndpoint, Option<Arc<BridgeConnection>>, Option<String>)> {
        if endpoints.is_empty() {
            return Vec::new();
        }
        if endpoints.len() == 1 {
            let ep = endpoints[0].clone();
            return match self.connect_endpoint(&ep).await {
                Ok(conn) => vec![(ep, Some(conn), None)],
                Err(err) => vec![(ep, None, Some(err.message().to_string()))],
            };
        }
        let mut existing_map: HashMap<String, Arc<BridgeConnection>> = {
            let mut conns = self.connections.lock().await;
            conns.retain(|pipe, c| !c.is_closed() && endpoints.iter().any(|e| &e.pipe_name == pipe));
            conns.clone()
        };
        let mut set = tokio::task::JoinSet::new();
        let mut ready: HashMap<String, (Option<Arc<BridgeConnection>>, Option<String>)> =
            HashMap::with_capacity(endpoints.len());

        for ep in endpoints {
            if let Some(conn) = existing_map.remove(&ep.pipe_name) {
                ready.insert(ep.pipe_name.clone(), (Some(conn), None));
            } else {
                let ep_clone = ep.clone();
                let client_name = self.client_name.clone();
                let sub = self.subscribe_events;
                let tx = self.event_tx.clone();
                let dirty = Arc::clone(&self.inventory_dirty);
                set.spawn(async move {
                    let res = BridgeConnection::connect_with_dirty(
                        ep_clone.clone(),
                        &client_name,
                        sub,
                        Some(tx),
                        Some(dirty),
                        Duration::from_secs(3),
                    )
                    .await;
                    (ep_clone, res)
                });
            }
        }

        let mut newly_connected = Vec::new();
        while let Some(joined) = set.join_next().await {
            if let Ok((ep, res)) = joined {
                match res {
                    Ok(conn) => {
                        let arc = Arc::new(conn);
                        newly_connected.push((ep.pipe_name.clone(), Arc::clone(&arc)));
                        ready.insert(ep.pipe_name, (Some(arc), None));
                    }
                    Err(err) => {
                        ready.insert(ep.pipe_name, (None, Some(err.message().to_string())));
                    }
                }
            }
        }
        if !newly_connected.is_empty() {
            let mut conns = self.connections.lock().await;
            for (pipe, arc) in newly_connected {
                conns.entry(pipe).or_insert(arc);
            }
        }

        endpoints
            .iter()
            .map(|ep| {
                let (c, e) = ready.remove(&ep.pipe_name).unwrap_or((None, None));
                (ep.clone(), c, e)
            })
            .collect()
    }

    async fn sync_inventory(&self, endpoints: &[BridgeEndpoint], pipe_sig: u64) {
        let connected = self.connect_endpoints_parallel(endpoints).await;
        let mut set = tokio::task::JoinSet::new();
        for (ep, conn_opt, _) in connected {
            if let Some(conn) = conn_opt {
                set.spawn(async move {
                    let inv = conn
                        .send(
                            "tabs.inventory",
                            json!({ "_noLearn": true }),
                            Duration::from_millis(1500),
                        )
                        .await;
                    (ep, conn, inv)
                });
            }
        }

        let mut tab_owners: HashMap<i64, Vec<TabOwnerInfo>> = HashMap::new();
        let mut controllable_counts: HashMap<String, usize> = HashMap::new();
        while let Some(joined) = set.join_next().await {
            let Ok((ep, conn, Ok(inv))) = joined else { continue };
            let label = conn.label().to_string();
            let mut ctrl_count = 0usize;
            if let Some(tabs) = inv.get("tabs").and_then(Value::as_array) {
                for tab in tabs {
                    let Some(tid) = tab.get("tabId").and_then(Value::as_i64) else {
                        continue;
                    };
                    let controllable = tab
                        .get("controllable")
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    if controllable {
                        ctrl_count += 1;
                    }
                    let url = tab
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    tab_owners.entry(tid).or_default().push(TabOwnerInfo {
                        pipe_name: ep.pipe_name.clone(),
                        browser: ep.browser.clone(),
                        instance_id: ep.instance_id.clone(),
                        label: label.clone(),
                        url,
                        controllable,
                    });
                }
            }
            controllable_counts.insert(ep.pipe_name, ctrl_count);
        }

        let mut routing = self.routing.lock().await;
        routing.tab_owners = tab_owners;
        routing.controllable_counts = controllable_counts;
        routing.synced_pipe_sig = pipe_sig;
        self.inventory_dirty.store(false, Ordering::Release);
    }

    async fn ensure_inventory_fresh(&self, endpoints: &[BridgeEndpoint], pipe_sig: u64, force: bool) {
        if endpoints.len() < 2 {
            return;
        }
        let needs_sync = force || self.inventory_dirty.load(Ordering::Acquire) || {
            let r = self.routing.lock().await;
            r.synced_pipe_sig != pipe_sig
        };
        if needs_sync {
            self.sync_inventory(endpoints, pipe_sig).await;
        }
    }

    async fn record_response_tabs(&self, conn: &BridgeConnection, method: &str, params: &Value, result: &Value) {
        let mut routing = self.routing.lock().await;
        if method == "tabs.close" {
            if let Some(closed_id) = result.get("closed").and_then(Value::as_i64) {
                if let Some(owners) = routing.tab_owners.get_mut(&closed_id) {
                    owners.retain(|o| o.pipe_name != conn.endpoint.pipe_name);
                    if owners.is_empty() {
                        routing.tab_owners.remove(&closed_id);
                    }
                }
            }
            if let Some(arr) = result.get("closedTabs").and_then(Value::as_array) {
                for v in arr {
                    if let Some(tid) = v.as_i64() {
                        if let Some(owners) = routing.tab_owners.get_mut(&tid) {
                            owners.retain(|o| o.pipe_name != conn.endpoint.pipe_name);
                            if owners.is_empty() {
                                routing.tab_owners.remove(&tid);
                            }
                        }
                    }
                }
            }
            return;
        }

        let mut observed_ids: Vec<(i64, String)> = Vec::new();
        if let Some(tid) = result
            .get("tabId")
            .and_then(Value::as_i64)
            .or_else(|| params.get("tabId").and_then(Value::as_i64))
        {
            let url = result
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            observed_ids.push((tid, url));
        }
        if let Some(opened) = result.get("openedTabs").and_then(Value::as_array) {
            for v in opened {
                if let Some(tid) = v.as_i64() {
                    observed_ids.push((tid, String::new()));
                }
            }
        }
        if observed_ids.is_empty() {
            return;
        }
        let label = conn.label().to_string();
        for (tid, url) in observed_ids {
            let owners = routing.tab_owners.entry(tid).or_default();
            if let Some(existing) = owners.iter_mut().find(|o| o.pipe_name == conn.endpoint.pipe_name) {
                if !url.is_empty() {
                    existing.url = url;
                }
                existing.controllable = true;
            } else {
                owners.push(TabOwnerInfo {
                    pipe_name: conn.endpoint.pipe_name.clone(),
                    browser: conn.endpoint.browser.clone(),
                    instance_id: conn.endpoint.instance_id.clone(),
                    label: label.clone(),
                    url,
                    controllable: true,
                });
                *routing
                    .controllable_counts
                    .entry(conn.endpoint.pipe_name.clone())
                    .or_insert(0) += 1;
            }
        }
    }

    async fn known_labels(&self) -> HashMap<String, String> {
        let conns = self.connections.lock().await;
        conns
            .iter()
            .filter(|(_, v)| !v.is_closed())
            .map(|(k, v)| (k.clone(), v.label().to_string()))
            .collect()
    }

    pub async fn get_connection(&self, selector: Option<&str>) -> Result<Arc<BridgeConnection>, BridgeError> {
        self.resolve_connection_for_call("status", &json!({}), selector, false).await
    }

    async fn resolve_connection_for_call(
        &self,
        method: &str,
        params: &Value,
        selector: Option<&str>,
        force_discover: bool,
    ) -> Result<Arc<BridgeConnection>, BridgeError> {
        let sel_clean = selector.map(str::trim).filter(|s| !s.is_empty());
        let (mut endpoints, mut pipe_sig) = self.discover_cached(force_discover).await;
        if endpoints.is_empty() && !force_discover {
            (endpoints, pipe_sig) = self.discover_cached(true).await;
        }
        if endpoints.is_empty() {
            return Err(BridgeError::Unavailable(
                "No browser is connected to Browser Bridge. Make sure Edge, Chrome or Firefox is running with the Browser Bridge extension loaded (toolbar icon shows a green dot) and that the native host is installed.".to_string(),
            ));
        }

        let requested_tab = params.get("tabId").and_then(Value::as_i64);

        // 1. Explicit selector provided (e.g. "chrome", "edge:Work", "a1b2", "a1b2c3d4e5f6").
        if let Some(sel) = sel_clean {
            let mut labels = self.known_labels().await;
            let mut candidates = choose_candidates(&endpoints, sel, &|e| {
                labels.get(&e.pipe_name).cloned().unwrap_or_default()
            });
            // Connect disconnected endpoints in parallel only if selector didn't match yet (custom label)
            // or matched multiple profiles of the same browser.
            let need_all_labels = candidates.is_empty() || candidates.len() > 1;
            if need_all_labels {
                let (fresh_eps, fresh_sig) = self.discover_cached(true).await;
                endpoints = fresh_eps;
                pipe_sig = fresh_sig;
                let _ = self.connect_endpoints_parallel(&endpoints).await;
                labels = self.known_labels().await;
                candidates = choose_candidates(&endpoints, sel, &|e| {
                    labels.get(&e.pipe_name).cloned().unwrap_or_default()
                });
            }

            let chosen: BridgeEndpoint = match candidates.as_slice() {
                [] => {
                    return Err(choose(&endpoints, Some(sel), None, |e| {
                        labels.get(&e.pipe_name).cloned().unwrap_or_default()
                    })
                    .unwrap_err());
                }
                [only] => (*only).clone(),
                many => {
                    // Multiple profiles matched selector (e.g. two unlabeled Chrome profiles).
                    // Disambiguate cleanly via tabId ownership or sole shared-tab profile before failing!
                    self.ensure_inventory_fresh(&endpoints, pipe_sig, false).await;
                    let candidate_pipes: std::collections::HashSet<&str> =
                        many.iter().map(|e| e.pipe_name.as_str()).collect();
                    let disambiguated_pipe: Option<String> = if let Some(tid) = requested_tab {
                        let mut matched_pipes: Vec<String> = {
                            let r = self.routing.lock().await;
                            r.tab_owners
                                .get(&tid)
                                .into_iter()
                                .flatten()
                                .filter(|o| candidate_pipes.contains(o.pipe_name.as_str()))
                                .map(|o| o.pipe_name.clone())
                                .collect()
                        };
                        if matched_pipes.is_empty() {
                            self.ensure_inventory_fresh(&endpoints, pipe_sig, true).await;
                            let r = self.routing.lock().await;
                            matched_pipes = r
                                .tab_owners
                                .get(&tid)
                                .into_iter()
                                .flatten()
                                .filter(|o| candidate_pipes.contains(o.pipe_name.as_str()))
                                .map(|o| o.pipe_name.clone())
                                .collect();
                        }
                        if matched_pipes.len() == 1 {
                            Some(matched_pipes.remove(0))
                        } else {
                            None
                        }
                    } else if method != "tabs.new" && method != "status" {
                        let r = self.routing.lock().await;
                        let with_tabs: Vec<&BridgeEndpoint> = many
                            .iter()
                            .copied()
                            .filter(|e| r.controllable_counts.get(&e.pipe_name).copied().unwrap_or(0) > 0)
                            .collect();
                        if with_tabs.len() == 1 {
                            Some(with_tabs[0].pipe_name.clone())
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                    if let Some(p) = disambiguated_pipe {
                        endpoints.iter().find(|e| e.pipe_name == p).unwrap().clone()
                    } else {
                        return Err(choose(&endpoints, Some(sel), None, |e| {
                            labels.get(&e.pipe_name).cloned().unwrap_or_default()
                        })
                        .unwrap_err());
                    }
                }
            };

            {
                let mut sel_state = self.selection.lock().await;
                sel_state.pipe_name = Some(chosen.pipe_name.clone());
                sel_state.explicit = true;
            }
            return self.connect_endpoint(&chosen).await;
        }

        // 2. Fast single-browser path: 0 inventory roundtrips, ~50ns resolution.
        if endpoints.len() == 1 {
            let target = endpoints[0].clone();
            {
                let mut sel_state = self.selection.lock().await;
                if sel_state.pipe_name.as_deref() != Some(target.pipe_name.as_str()) {
                    sel_state.pipe_name = Some(target.pipe_name.clone());
                    sel_state.explicit = false;
                }
            }
            return self.connect_endpoint(&target).await;
        }

        // 3. Multi-browser path (>= 2 connected browsers, selector omitted).
        self.ensure_inventory_fresh(&endpoints, pipe_sig, false).await;
        let live_pipes: std::collections::HashSet<&str> =
            endpoints.iter().map(|e| e.pipe_name.as_str()).collect();

        if let Some(tid) = requested_tab {
            let mut owners: Vec<TabOwnerInfo> = {
                let r = self.routing.lock().await;
                r.tab_owners
                    .get(&tid)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|o| live_pipes.contains(o.pipe_name.as_str()))
                    .collect()
            };
            if owners.is_empty() {
                // Force one parallel refresh in case tab was shared <50ms ago before debounce.
                self.ensure_inventory_fresh(&endpoints, pipe_sig, true).await;
                let r = self.routing.lock().await;
                owners = r
                    .tab_owners
                    .get(&tid)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|o| live_pipes.contains(o.pipe_name.as_str()))
                    .collect();
            }

            if owners.len() == 1 {
                let owner_pipe = &owners[0].pipe_name;
                if let Some(target) = endpoints.iter().find(|e| &e.pipe_name == owner_pipe).cloned() {
                    let mut sel_state = self.selection.lock().await;
                    if sel_state.pipe_name.as_deref() != Some(target.pipe_name.as_str()) {
                        sel_state.pipe_name = Some(target.pipe_name.clone());
                        sel_state.explicit = false;
                    }
                    drop(sel_state);
                    return self.connect_endpoint(&target).await;
                }
            } else if owners.len() >= 2 {
                let details: Vec<String> = owners
                    .iter()
                    .map(|o| {
                        let tag = if o.label.is_empty() {
                            format!("{}:{}", o.browser, &o.instance_id[..4])
                        } else {
                            format!("{}:{}", o.browser, normalize_label_slug(&o.label))
                        };
                        if o.url.is_empty() {
                            tag
                        } else {
                            format!("{tag} ({})", o.url)
                        }
                    })
                    .collect();
                return Err(BridgeError::Command {
                    code: "ambiguous_tab".to_string(),
                    message: format!(
                        "Tab {tid} is shared in multiple connected browsers: {}. Pass 'browser' (e.g. \"{}\") to target the intended browser.",
                        details.join(", "),
                        if owners[0].label.is_empty() {
                            format!("{}:{}", owners[0].browser, &owners[0].instance_id[..4])
                        } else {
                            format!("{}:{}", owners[0].browser, normalize_label_slug(&owners[0].label))
                        }
                    ),
                });
            }
        }

        // No tabId (or tabId not found in any shared inventory): check explicit selection, then sole active browser.
        let (cur_pipe, is_explicit) = {
            let sel_state = self.selection.lock().await;
            (
                sel_state
                    .pipe_name
                    .clone()
                    .filter(|p| live_pipes.contains(p.as_str())),
                sel_state.explicit,
            )
        };

        if is_explicit {
            if let Some(pipe) = cur_pipe {
                let target = endpoints.iter().find(|e| e.pipe_name == pipe).unwrap().clone();
                return self.connect_endpoint(&target).await;
            }
        }

        let target = {
            let r = self.routing.lock().await;
            let cur_has_tabs = cur_pipe
                .as_ref()
                .is_some_and(|p| r.controllable_counts.get(p).copied().unwrap_or(0) > 0);
            if cur_has_tabs {
                endpoints
                    .iter()
                    .find(|e| Some(&e.pipe_name) == cur_pipe.as_ref())
                    .unwrap()
                    .clone()
            } else {
                let active_eps: Vec<&BridgeEndpoint> = endpoints
                    .iter()
                    .filter(|e| r.controllable_counts.get(&e.pipe_name).copied().unwrap_or(0) > 0)
                    .collect();
                if active_eps.len() == 1 {
                    active_eps[0].clone()
                } else if active_eps.len() >= 2
                    && requested_tab.is_none()
                    && cur_pipe.is_none()
                    && !matches!(method, "status" | "tabs.list" | "tabs.inventory" | "tabs.new")
                {
                    let names: Vec<String> = active_eps
                        .iter()
                        .map(|e| format!("{}:{}", e.browser, &e.instance_id[..4]))
                        .collect();
                    return Err(BridgeError::Command {
                        code: "ambiguous_tab".to_string(),
                        message: format!(
                            "Multiple connected browsers currently have shared tabs ({}). Pass 'tabId' or 'browser' to specify which browser to act on.",
                            names.join(", ")
                        ),
                    });
                } else {
                    let labels = HashMap::<String, String>::new();
                    choose(&endpoints, None, cur_pipe.as_deref(), |e| {
                        labels.get(&e.pipe_name).cloned().unwrap_or_default()
                    })?
                    .clone()
                }
            }
        };

        {
            let mut sel_state = self.selection.lock().await;
            sel_state.pipe_name = Some(target.pipe_name.clone());
        }
        self.connect_endpoint(&target).await
    }

    pub async fn send(
        &self,
        method: &str,
        params: Value,
        selector: Option<&str>,
        timeout: Duration,
    ) -> Result<(Value, Arc<BridgeConnection>), BridgeError> {
        let mut attempt = 0;
        loop {
            let conn = self
                .resolve_connection_for_call(method, &params, selector, attempt > 0)
                .await?;
            match conn.send(method, params.clone(), timeout).await {
                Ok(val) => {
                    self.record_response_tabs(&conn, method, &params, &val).await;
                    return Ok((val, conn));
                }
                Err(BridgeError::Io(msg)) if attempt == 0 && (is_idempotent_read(method) || method == "status") => {
                    attempt += 1;
                    self.connections.lock().await.remove(&conn.endpoint.pipe_name);
                    self.inventory_dirty.store(true, Ordering::Release);
                    let _ = msg;
                }
                Err(BridgeError::Io(msg)) => {
                    self.connections.lock().await.remove(&conn.endpoint.pipe_name);
                    self.inventory_dirty.store(true, Ordering::Release);
                    return Err(BridgeError::Unavailable(msg));
                }
                Err(BridgeError::Command { ref code, .. })
                    if code == "no_tab"
                        && attempt == 0
                        && selector.map(str::trim).filter(|s| !s.is_empty()).is_none()
                        && params.get("tabId").and_then(Value::as_i64).is_some() =>
                {
                    let tid = params.get("tabId").and_then(Value::as_i64).unwrap();
                    let (eps, _) = self.discover_cached(true).await;
                    let others: Vec<BridgeEndpoint> = eps
                        .into_iter()
                        .filter(|e| e.pipe_name != conn.endpoint.pipe_name)
                        .collect();
                    if others.is_empty() {
                        return Err(BridgeError::Command {
                            code: code.clone(),
                            message: "Tab does not exist. Call browser_tabs with action \"list\".".to_string(),
                        });
                    }
                    let connected = self.connect_endpoints_parallel(&others).await;
                    let mut matches: Vec<Arc<BridgeConnection>> = Vec::new();
                    for (_, c_opt, _) in connected {
                        if let Some(c) = c_opt {
                            if let Ok(list) = c
                                .send("tabs.list", json!({ "_noLearn": true }), Duration::from_millis(1500))
                                .await
                            {
                                let has_tid = list
                                    .get("tabs")
                                    .and_then(Value::as_array)
                                    .is_some_and(|arr| arr.iter().any(|t| t.get("tabId").and_then(Value::as_i64) == Some(tid)));
                                if has_tid {
                                    matches.push(c);
                                }
                            }
                        }
                    }
                    if matches.len() == 1 {
                        let alt = matches.remove(0);
                        let val = alt.send(method, params.clone(), timeout).await?;
                        self.record_response_tabs(&alt, method, &params, &val).await;
                        let mut sel_state = self.selection.lock().await;
                        sel_state.pipe_name = Some(alt.endpoint.pipe_name.clone());
                        sel_state.explicit = false;
                        return Ok((val, alt));
                    } else if matches.len() >= 2 {
                        return Err(BridgeError::Command {
                            code: "ambiguous_tab".to_string(),
                            message: format!(
                                "Tab {tid} exists in multiple connected browsers. Pass 'browser' to target the intended browser."
                            ),
                        });
                    }
                    return Err(BridgeError::Command {
                        code: code.clone(),
                        message: format!("Tab {tid} does not exist in any connected browser. Call browser_tabs with action \"list\"."),
                    });
                }
                Err(err) => return Err(err),
            }
        }
    }

    pub async fn close_all(&self) {
        let mut conns = self.connections.lock().await;
        conns.clear();
        *self.selection.lock().await = SelectionState::default();
        *self.routing.lock().await = RoutingTable::default();
        self.inventory_dirty.store(true, Ordering::Release);
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

    #[test]
    fn resolves_composite_browser_labels_hex_prefixes_and_ambiguity() {
        let edge_work = BridgeEndpoint { pipe_name: "p.ew".into(), browser: "edge".into(), instance_id: "a1b2c3d4e5f6".into() };
        let chrome_a = BridgeEndpoint { pipe_name: "p.ca".into(), browser: "chrome".into(), instance_id: "111122223333".into() };
        let chrome_b = BridgeEndpoint { pipe_name: "p.cb".into(), browser: "chrome".into(), instance_id: "999988887777".into() };
        let all = vec![edge_work.clone(), chrome_a.clone(), chrome_b.clone()];
        let label = |e: &BridgeEndpoint| {
            if e == &edge_work {
                "Work Profile".to_string()
            } else {
                String::new()
            }
        };

        assert_eq!(choose(&all, Some("edge:Work-Profile"), None, label).unwrap(), &edge_work);
        assert_eq!(choose(&all, Some("edge:work profile"), None, label).unwrap(), &edge_work);
        assert_eq!(choose(&all, Some("edge:a1b2"), None, label).unwrap(), &edge_work);
        assert_eq!(choose(&all, Some("chrome:9999"), None, label).unwrap(), &chrome_b);
        assert_eq!(choose(&all, Some("1111"), None, label).unwrap(), &chrome_a);

        let err = choose(&all, Some("chrome"), None, label).unwrap_err();
        assert_eq!(err.code(), "ambiguous_browser");
        assert!(err.to_string().contains("chrome:1111"));
        assert!(err.to_string().contains("chrome:9999"));
    }
}
