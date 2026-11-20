use bridge_core::client::{BridgeClient, BridgeConnection, BridgeError};
use bridge_core::routines::{self, RoutineDefinition, SessionTracker};
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, mpsc};

const INSTRUCTIONS: &str = "Browser Bridge controls the user's own Edge, Chrome or Firefox through an extension. \
Read pages with browser_snapshot (element refs like e12; SVG diagram shapes appear as role=\"shape\") or browser_get_text, \
then act with browser_click, browser_drag, browser_type, browser_fill_form, browser_select_option, browser_press_key, or browser_batch (to execute multi-step sequences such as repeated combobox searches/clicks in 1 fast call without extra LLM roundtrips). \
Site Memory & Auto-Learned Routines: Browser Bridge automatically learns from errors and automatically distills multi-step workflows into reusable routines per domain \
(check [Site Memory & Fast Routines] in snapshots or browser_routine_list; run with browser_routine_run; save custom site workflows/tips with browser_routine_save). \
Refs stay stable across locate/snapshot on the same page and self-heal across same-URL DOM re-renders, expiring on navigation. \
You can only use tabs the user shared or tabs you opened. Confirm with the user before submitting forms, sending messages, purchasing, deleting, or changing account settings. \
Stop and hand over to the user for logins, MFA, CAPTCHAs and other human verification.";

const READ_ONLY_INSTRUCTIONS: &str = "Browser Bridge is running in READ-ONLY MCP mode (--read-only). \
You can inspect shared browser tabs using browser_status, browser_tabs (action=list), browser_snapshot, browser_get_text, \
browser_locate, browser_get_element, browser_wait_for, browser_screenshot, browser_webmcp_list, read-only WebMCP tools, \
and browser_routine_list / read-only routines, or read bridge:// MCP resources. You have NO capability to click, type, drag, navigate, open/close tabs, or mutate page state.";

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone, Copy)]
pub struct McpOptions {
    pub allow_evaluate: bool,
    pub read_only: bool,
}

pub async fn run_async(args: &[String]) -> i32 {
    let env_ro = std::env::var("BROWSER_BRIDGE_READ_ONLY")
        .ok()
        .is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"));
    let opts = McpOptions {
        allow_evaluate: args.iter().any(|a| a.eq_ignore_ascii_case("--allow-evaluate")),
        read_only: env_ro || args.iter().any(|a| a.eq_ignore_ascii_case("--read-only")),
    };
    let client = Arc::new(BridgeClient::new(
        if opts.read_only { "copilot-mcp-ro" } else { "copilot-mcp" },
        false,
    ));
    let tracker = Arc::new(Mutex::new(SessionTracker::default()));
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));

    // Sequential FIFO worker for stateful tools/call requests so batched [click, snapshot] turns never race out of order!
    let (seq_tx, mut seq_rx) = mpsc::unbounded_channel::<(Value, String, Value)>();
    let seq_client = Arc::clone(&client);
    let seq_tracker = Arc::clone(&tracker);
    let seq_out = Arc::clone(&stdout);
    let seq_worker = tokio::spawn(async move {
        while let Some((id, method, params)) = seq_rx.recv().await {
            let reply = handle_rpc_with_tracker(&id, &method, &params, opts, &seq_client, &seq_tracker).await;
            let text = format!("{reply}\n");
            let mut w = seq_out.lock().await;
            let _ = w.write_all(text.as_bytes()).await;
            let _ = w.flush().await;
        }
    });

    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

        if method == "tools/call" {
            let _ = seq_tx.send((id, method, params));
        } else {
            let client_ref = Arc::clone(&client);
            let tracker_ref = Arc::clone(&tracker);
            let out_ref = Arc::clone(&stdout);
            tokio::spawn(async move {
                let reply = handle_rpc_with_tracker(&id, &method, &params, opts, &client_ref, &tracker_ref).await;
                let text = format!("{reply}\n");
                let mut w = out_ref.lock().await;
                let _ = w.write_all(text.as_bytes()).await;
                let _ = w.flush().await;
            });
        }
    }
    drop(seq_tx);
    let _ = seq_worker.await;
    client.close_all().await;
    0
}

#[allow(dead_code)]
pub async fn handle_rpc(id: &Value, method: &str, params: &Value, opts: McpOptions, client: &BridgeClient) -> Value {
    let tracker = Mutex::new(SessionTracker::default());
    handle_rpc_with_tracker(id, method, params, opts, client, &tracker).await
}

pub async fn handle_rpc_with_tracker(
    id: &Value,
    method: &str,
    params: &Value,
    opts: McpOptions,
    client: &BridgeClient,
    tracker: &Mutex<SessionTracker>,
) -> Value {
    match method {
        "initialize" => {
            let protocol_version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-06-18");
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": protocol_version,
                    "capabilities": {
                        "tools": {},
                        "resources": {},
                        "prompts": {}
                    },
                    "serverInfo": {
                        "name": "browser-bridge",
                        "version": bridge_core::VERSION,
                        "readOnly": opts.read_only,
                    },
                    "instructions": if opts.read_only { READ_ONLY_INSTRUCTIONS } else { INSTRUCTIONS },
                }
            })
        }
        "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "tools/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": tool_definitions(opts) }
        }),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let res = call_tool(name, &args, opts, client, tracker).await;
            json!({ "jsonrpc": "2.0", "id": id, "result": res })
        }
        "resources/list" => {
            let resources = list_resources(client).await;
            json!({ "jsonrpc": "2.0", "id": id, "result": { "resources": resources } })
        }
        "resources/read" => {
            let uri = params.get("uri").and_then(Value::as_str).unwrap_or("");
            match read_resource(uri, client).await {
                Ok(contents) => json!({ "jsonrpc": "2.0", "id": id, "result": { "contents": contents } }),
                Err(msg) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": msg } }),
            }
        }
        "prompts/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "prompts": prompt_definitions() }
        }),
        "prompts/get" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            match get_prompt(name, &args, client).await {
                Ok(val) => json!({ "jsonrpc": "2.0", "id": id, "result": val }),
                Err(msg) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": msg } }),
            }
        }
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Method not found: {method}") }
        }),
    }
}

fn locator_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "steps": {
                "type": "array",
                "description": "1-16 ordered finder/filter steps, e.g. [{\"kind\":\"role\",\"value\":\"button\",\"name\":\"Save\",\"exact\":true}]. Finders search descendants, including shadow roots.",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": { "type": "string", "description": "css, role, text, label, placeholder, testId, altText, title, nth or filter." },
                        "value": { "type": "string", "description": "Selector/text/role to find; for filter, descendant text to contain. Omit for nth." },
                        "name": { "type": "string", "description": "Accessible name to match, only for role." },
                        "exact": { "type": "boolean", "description": "Exact case-sensitive normalized text instead of case-insensitive substring." },
                        "includeHidden": { "type": "boolean", "description": "Include hidden elements for role (default false)." },
                        "index": { "type": "integer", "description": "For nth only: zero-based index, or -1 for last." }
                    },
                    "required": ["kind"]
                }
            },
            "frameId": { "type": "integer", "description": "Browser frame id from a snapshot (f3e7 means frame 3); defaults to main frame 0." }
        },
        "required": ["steps"]
    })
}

const READ_SAFE_MCP_TOOLS: &[&str] = &[
    "browser_status",
    "browser_tabs",
    "browser_snapshot",
    "browser_get_text",
    "browser_locate",
    "browser_get_element",
    "browser_wait_for",
    "browser_screenshot",
    "browser_network",
    "browser_console",
    "browser_allowlist",
    "browser_webmcp_list",
    "browser_webmcp_call",
    "browser_routine_list",
    "browser_routine_run",
    "browser_batch",
];

fn tool_definitions(opts: McpOptions) -> Vec<Value> {
    let loc = locator_schema();
    let tabs_schema = if opts.read_only {
        json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["list"], "default": "list" },
                "browser": { "type": "string", "description": "Optional browser selector (edge, chrome, firefox, label or instance id)." }
            }
        })
    } else {
        json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "description": "One of: list, new, select, close.", "default": "list" },
                "tabId": { "type": "integer", "description": "Tab id for select/close." },
                "name": { "type": "string", "description": "Persistent tab handle name (e.g. 'work-mail'). Reuses the existing named tab on action=new without re-navigating and exempts it from idle auto-close." },
                "group": { "type": "string", "description": "Collapsed Chromium tab-group title for action=new (default 'Agent'), or group name to close together on action=close." },
                "url": { "type": "string", "description": "URL to open for action=new." },
                "active": { "type": "boolean", "default": false, "description": "Open tab in background (false, default) or foreground (true)." },
                "allowedOrigins": { "type": "array", "items": { "type": "string" }, "description": "Restrict this tab to allowed origins/hosts (e.g. ['https://app.diagrams.net', '*.github.com'])." },
                "browser": { "type": "string", "description": "Optional browser selector (edge, chrome, firefox, label or instance id)." }
            }
        })
    };

    let mut tools = vec![
        json!({
            "name": "browser_status",
            "description": "Lists browsers connected through the Browser Bridge extension (Edge, Chrome, Firefox) and the selected browser's settings. Pass `browser` to choose which browser later calls use.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "browser": { "type": "string", "description": "Optional browser to select: edge, chrome, chromium, firefox, a profile label, or an instance id." }
                }
            }
        }),
        json!({
            "name": "browser_tabs",
            "description": if opts.read_only {
                "Lists shared browser tabs visible to this read-only MCP session (action=list)."
            } else {
                "Manages tabs this agent may use. action=list shows them; action=new opens a tab (optionally at url) that belongs to this agent; action=select makes tabId the current tab and brings it to front; action=close closes tabId (or the current tab)."
            },
            "annotations": { "readOnlyHint": opts.read_only },
            "inputSchema": tabs_schema
        }),
        json!({
            "name": "browser_navigate",
            "description": "Navigates the current tab (or tabId) to a URL and waits for it to load. Opens a new agent tab when none is available or newTab=true. Follow with browser_snapshot to read the page.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Absolute URL, or a host name such as example.com (https is assumed)." },
                    "tabId": { "type": "integer", "description": "Tab to navigate; defaults to the current tab." },
                    "newTab": { "type": "boolean", "description": "Open the URL in a new tab owned by this agent.", "default": false },
                    "browser": { "type": "string", "description": "Optional browser selector." }
                },
                "required": ["url"]
            }
        }),
        json!({
            "name": "browser_history",
            "description": "Goes back, forward, or reloads the current tab (or tabId).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["back", "forward", "reload"], "description": "One of: back, forward, reload." },
                    "tabId": { "type": "integer", "description": "Tab id; defaults to the current tab." }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "browser_snapshot",
            "description": "Returns an accessibility-style outline of the page (roles, names, values, states) with element refs such as [ref=e12]; refs in iframes look like f3e7. Password values are always masked. Prefer this over screenshots for reading and acting.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "integer" },
                    "maxChars": { "type": "integer" },
                    "viewportOnly": { "type": "boolean", "default": false },
                    "root": { "type": "string" },
                    "frames": { "type": "string", "default": "all" }
                }
            }
        }),
        json!({
            "name": "browser_get_text",
            "description": "Returns visible text of the main frame, or of one element selected by ref or locator.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "integer" },
                    "maxChars": { "type": "integer" },
                    "ref": { "type": "string" },
                    "locator": loc
                }
            }
        }),
        json!({
            "name": "browser_locate",
            "description": "Finds elements by CSS, role/name, text, label, placeholder, data-testid, alt text or title, including shadow roots.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "locator": loc,
                    "maxResults": { "type": "integer", "default": 20 },
                    "tabId": { "type": "integer" }
                },
                "required": ["locator"]
            }
        }),
        json!({
            "name": "browser_get_element",
            "description": "Reads one element's summary, text, input value, attribute or state.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "operation": {
                        "type": "string",
                        "enum": [
                            "inspect", "count", "innerText", "textContent", "inputValue",
                            "getAttribute", "isVisible", "isHidden", "isEnabled",
                            "isDisabled", "isEditable", "isChecked"
                        ],
                        "default": "inspect",
                        "description": "Operation to perform: inspect (summary), count, innerText, textContent, inputValue (alias: value), getAttribute (requires attribute), isVisible, isHidden, isEnabled, isDisabled, isEditable, isChecked."
                    },
                    "ref": { "type": "string" },
                    "locator": loc,
                    "attribute": { "type": "string", "description": "Attribute name when operation=getAttribute." },
                    "maxChars": { "type": "integer" },
                    "tabId": { "type": "integer" }
                }
            }
        }),
        json!({
            "name": "browser_click",
            "description": "Clicks an element by ref or structured locator.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ref": { "type": "string" },
                    "tabId": { "type": "integer" },
                    "button": { "type": "string", "default": "left" },
                    "doubleClick": { "type": "boolean", "default": false },
                    "modifiers": { "type": "array", "items": { "type": "string" } },
                    "locator": loc
                }
            }
        }),
        json!({
            "name": "browser_hover",
            "description": "Moves the mouse over an element by ref or locator.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ref": { "type": "string" },
                    "tabId": { "type": "integer" },
                    "locator": loc.clone()
                }
            }
        }),
        json!({
            "name": "browser_drag",
            "description": "Drags from an element (fromRef/fromLocator) or coordinates (fromX, fromY) to a destination element (toRef/toLocator), coordinates (toX, toY), or relative offset (dx, dy). Ideal for canvas/diagram apps like draw.io.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "fromRef": { "type": "string" },
                    "fromLocator": loc.clone(),
                    "fromX": { "type": "number" },
                    "fromY": { "type": "number" },
                    "fromOffsetX": { "type": "number" },
                    "fromOffsetY": { "type": "number" },
                    "toRef": { "type": "string" },
                    "toLocator": loc.clone(),
                    "toX": { "type": "number" },
                    "toY": { "type": "number" },
                    "toOffsetX": { "type": "number" },
                    "toOffsetY": { "type": "number" },
                    "dx": { "type": "number" },
                    "dy": { "type": "number" },
                    "steps": { "type": "integer", "default": 10 },
                    "tabId": { "type": "integer" }
                }
            }
        }),
        json!({
            "name": "browser_type",
            "description": "Types text into an editable element by ref or locator.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string" },
                    "ref": { "type": "string" },
                    "tabId": { "type": "integer" },
                    "clear": { "type": "boolean", "default": true },
                    "submit": { "type": "boolean", "default": false },
                    "slowly": { "type": "boolean", "default": false },
                    "locator": loc
                },
                "required": ["text"]
            }
        }),
        json!({
            "name": "browser_fill_form",
            "description": "Fills several fields at once.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "fields": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "ref": { "type": "string" },
                                "locator": loc,
                                "value": { "type": "string" }
                            },
                            "required": ["value"]
                        }
                    },
                    "tabId": { "type": "integer" }
                },
                "required": ["fields"]
            }
        }),
        json!({
            "name": "browser_select_option",
            "description": "Selects option(s) in a native <select> by ref or locator.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "values": { "type": "array", "items": { "type": "string" } },
                    "ref": { "type": "string" },
                    "tabId": { "type": "integer" },
                    "locator": loc
                },
                "required": ["values"]
            }
        }),
        json!({
            "name": "browser_set_checked",
            "description": "Sets and verifies a checkbox/radio/aria-checked state.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "checked": { "type": "boolean" },
                    "ref": { "type": "string" },
                    "locator": loc,
                    "tabId": { "type": "integer" }
                },
                "required": ["checked"]
            }
        }),
        json!({
            "name": "browser_press_key",
            "description": "Presses a key or chord in the focused element.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string" },
                    "ref": { "type": "string" },
                    "tabId": { "type": "integer" },
                    "locator": loc
                },
                "required": ["key"]
            }
        }),
        json!({
            "name": "browser_scroll",
            "description": "Scrolls the page or a scrollable element.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "direction": { "type": "string" },
                    "amount": { "type": "number" },
                    "ref": { "type": "string" },
                    "tabId": { "type": "integer" },
                    "locator": loc
                }
            }
        }),
        json!({
            "name": "browser_wait_for",
            "description": "Waits for text, element state, page load state, exact URL, or a delay.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string" },
                    "textGone": { "type": "string" },
                    "seconds": { "type": "number" },
                    "timeoutSeconds": { "type": "number" },
                    "tabId": { "type": "integer" },
                    "ref": { "type": "string" },
                    "locator": loc,
                    "state": { "type": "string" },
                    "loadState": { "type": "string" },
                    "url": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "browser_screenshot",
            "description": "Captures the viewport, the full scrollable page (fullPage=true), or one element (ref/locator). Operates in the background when supported. Pass path to save high-resolution PNG/JPEG bytes directly to disk without consuming model image context.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "integer" },
                    "format": { "type": "string", "enum": ["jpeg", "png"] },
                    "quality": { "type": "integer" },
                    "maxWidth": { "type": "integer" },
                    "fullPage": { "type": "boolean" },
                    "ref": { "type": "string" },
                    "locator": loc.clone(),
                    "path": { "type": "string", "description": "Optional local file path to save the screenshot directly." }
                }
            }
        }),
        json!({
            "name": "browser_webmcp_list",
            "description": "Discovers WebMCP tools exposed by the shared web page itself (both Imperative document.modelContext.registerTool and Declarative <form toolname=...>). Returns each tool's name, description, inputSchema, and readOnlyHint.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "integer" }
                }
            }
        }),
        json!({
            "name": "browser_webmcp_call",
            "description": if opts.read_only {
                "Invokes a read-only WebMCP tool (readOnlyHint=true) exposed by the page."
            } else {
                "Invokes a WebMCP tool exposed by the page (Imperative modelContext tool or Declarative <form toolname=...>) with structured JSON arguments."
            },
            "annotations": { "readOnlyHint": opts.read_only },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Exact WebMCP tool name from browser_webmcp_list." },
                    "arguments": { "type": "object", "description": "JSON object matching the tool's inputSchema." },
                    "submit": { "type": "boolean", "description": "For declarative form tools: override whether to submit after filling." },
                    "tabId": { "type": "integer" }
                },
                "required": ["name"]
            }
        }),
        json!({
            "name": "browser_upload_file",
            "description": "Attaches one or more local files to an <input type=\"file\"> element selected by ref or locator.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "files": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Absolute local file path(s) to attach."
                    },
                    "ref": { "type": "string" },
                    "locator": loc,
                    "tabId": { "type": "integer" }
                },
                "required": ["files"]
            }
        }),
        json!({
            "name": "browser_handle_dialog",
            "description": "Accepts or dismisses a JavaScript alert/confirm/prompt dialog (or pre-arms handling for the next dialog with armNext=true).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "accept": { "type": "boolean", "default": true },
                    "promptText": { "type": "string" },
                    "armNext": { "type": "boolean", "default": false },
                    "tabId": { "type": "integer" }
                }
            }
        }),
        json!({
            "name": "browser_batch",
            "description": if opts.read_only {
                "Executes an ordered batch of read-only steps (locate, query/get_element, snapshot, text, waitFor, screenshot, GET fetch) in a single fast native loop inside this session's tab lease."
            } else {
                "Executes an ordered multi-step sequence (click, type, check, select, press, waitFor, snapshot, fetch, etc.) in a single fast native loop inside this session's tab lease without extra LLM roundtrips. Supports saveAs outputs ({{var}} interpolation across steps) and optional saveAsRoutine persistence."
            },
            "annotations": { "readOnlyHint": opts.read_only },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "description": "1-100 ordered steps executed sequentially in the target tab.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "op": { "type": "string", "description": "click, doubleClick, drag, type, fill, press, select, check, scroll, waitFor, locate, query, snapshot, text, screenshot, fetch, navigate, history, webmcp.call, dialog" },
                                "params": { "type": "object", "description": "Step parameters (e.g. locator/ref, text, checked, values, key); supports {{var}} and {{url.*}} interpolation." },
                                "saveAs": { "type": "string", "description": "Optional key to capture step output into outputs.<saveAs> and {{<saveAs>}} for subsequent steps." },
                                "optional": { "type": "boolean", "default": false, "description": "Continue even if this step fails." }
                            },
                            "required": ["op"]
                        }
                    },
                    "variables": { "type": "object", "description": "Optional initial {{key}} template variables." },
                    "stopOnError": { "type": "boolean", "default": true, "description": "Abort on first non-optional step error (default true)." },
                    "saveAsRoutine": { "type": "string", "description": "Optional routine name to persist into Site Memory if the batch succeeds." },
                    "description": { "type": "string", "description": "Optional description when saveAsRoutine is specified." },
                    "tabId": { "type": "integer" },
                    "browser": { "type": "string" }
                },
                "required": ["steps"]
            }
        }),
        json!({
            "name": "browser_routine_list",
            "description": "Inspects learned Site Memory for a website: reusable fast routines, site tips, auto-recorded pitfalls/errors, and recent session detours on the tab.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "domain": { "type": "string", "description": "Optional domain or URL (defaults to current/specified tabId)." },
                    "tabId": { "type": "integer" },
                    "includeTrace": { "type": "boolean", "default": true, "description": "Include recent session attempts and errors." },
                    "all": { "type": "boolean", "default": false, "description": "List playbooks across all known domains." },
                    "browser": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "browser_routine_run",
            "description": "Executes a learned multi-step site routine (e.g. diagrams.net read_diagram_xml, write_diagram_xml, insert_shape) in a single fast native loop without extra LLM roundtrips.",
            "annotations": { "readOnlyHint": opts.read_only },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Routine name from browser_routine_list or snapshot Site Memory hint." },
                    "arguments": { "type": "object", "description": "Template arguments matching the routine's params." },
                    "domain": { "type": "string", "description": "Optional domain override (resolved automatically from tabId when omitted)." },
                    "tabId": { "type": "integer" },
                    "browser": { "type": "string" }
                },
                "required": ["name"]
            }
        }),
        json!({
            "name": "browser_routine_save",
            "description": "Saves a learned reusable site routine or tip into Browser Bridge Site Memory so future tasks skip trial-and-error detours.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "domain": { "type": "string", "description": "Target site domain (e.g. diagrams.net); resolved from tabId if omitted." },
                    "tabId": { "type": "integer" },
                    "note": { "type": "string", "description": "Concise site lesson or pitfall workaround to remember." },
                    "deleteRoutine": { "type": "string", "description": "Optional routine name to remove." },
                    "resetAccessProfile": { "type": "boolean", "default": false, "description": "Reset learned error/performance adaptations and pitfalls for this domain." },
                    "routine": {
                        "type": "object",
                        "description": "Parameterized multi-step routine definition.",
                        "properties": {
                            "name": { "type": "string" },
                            "description": { "type": "string" },
                            "readOnly": { "type": "boolean", "default": false },
                            "params": { "type": "object" },
                            "steps": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "op": { "type": "string", "description": "click, doubleClick, drag, type, press, select, check, scroll, waitFor, locate, query, snapshot, text, screenshot, webmcp.call, dialog" },
                                        "params": { "type": "object", "description": "Step params; supports {{argName}} placeholders." },
                                        "saveAs": { "type": "string", "description": "Store step output under outputs.<saveAs>." },
                                        "optional": { "type": "boolean", "default": false }
                                    },
                                    "required": ["op"]
                                }
                            }
                        },
                        "required": ["name", "steps"]
                    },
                    "browser": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "browser_allowlist",
            "description": if opts.read_only {
                "Inspects the allowedOrigins domain fence for this session or tab."
            } else {
                "Inspects, sets, or clears the allowedOrigins domain fence (e.g. ['https://app.diagrams.net', '*.github.com']) so agent tabs cannot navigate or redirect outside permitted sites."
            },
            "annotations": { "readOnlyHint": opts.read_only },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "origins": { "type": "array", "items": { "type": "string" }, "description": "Allowed origins, bare hosts, or '*.domain.com' wildcards. Omit to inspect." },
                    "clear": { "type": "boolean", "default": false, "description": "Clear the allowlist." },
                    "tabId": { "type": "integer", "description": "Scope to a single tab instead of the whole session." },
                    "browser": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "browser_handoff",
            "description": "Hands a tab back to the user for human-only steps (login, 2FA/MFA, CAPTCHA/Cloudflare verification, payment). Displays a floating Continue card and WAIT badge on the tab, then resumes automatically once the user clicks Continue.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "message": { "type": "string", "description": "Short instruction telling the user what to complete before clicking Continue." },
                    "tabId": { "type": "integer" },
                    "bringToFront": { "type": "boolean", "default": true },
                    "timeoutSeconds": { "type": "number", "default": 300 },
                    "browser": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "browser_demonstrate",
            "description": "Asks the user to demonstrate a workflow on the tab while Browser Bridge records their clicks and inputs (never passwords or OTPs). Pass saveAs to persist the recorded steps directly into Site Memory as a fast reusable Routine.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "instruction": { "type": "string", "description": "Prompt shown on the floating recorder bar telling the user what flow to demonstrate." },
                    "saveAs": { "type": "string", "description": "Optional routine name to automatically save into Site Memory upon completion." },
                    "description": { "type": "string", "description": "Description stored with the saved routine." },
                    "tabId": { "type": "integer" },
                    "timeoutSeconds": { "type": "number", "default": 300 },
                    "browser": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "browser_network",
            "description": "Captures and reads credential-redacted HTTP/XHR/fetch traffic on a tab (Authorization, Cookie, API keys, passwords, OTPs, and JWTs are replaced with [REDACTED]).",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["start", "status", "stop", "clear"], "default": "status" },
                    "onlyFailures": { "type": "boolean", "default": false, "description": "Filter to HTTP >= 400 or network errors." },
                    "urlInclude": { "type": "string", "description": "Optional substring filter when action=start." },
                    "limit": { "type": "integer", "default": 100 },
                    "maxEntries": { "type": "integer", "default": 200 },
                    "tabId": { "type": "integer" },
                    "browser": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "browser_console",
            "description": "Reads or clears page console messages (log/info/warn/error) and uncaught JavaScript errors/rejections captured since document_start.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["read", "clear"], "default": "read" },
                    "level": { "type": "string", "enum": ["all", "warn", "error"], "default": "all" },
                    "limit": { "type": "integer", "default": 100 },
                    "clear": { "type": "boolean", "default": false },
                    "tabId": { "type": "integer" },
                    "browser": { "type": "string" }
                }
            }
        }),
    ];

    if opts.allow_evaluate && !opts.read_only {
        tools.push(json!({
            "name": "browser_evaluate",
            "description": "Evaluates a JavaScript expression in the page's main frame.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "expression": { "type": "string" },
                    "tabId": { "type": "integer" }
                },
                "required": ["expression"]
            }
        }));
    }

    if opts.read_only {
        tools.retain(|t| {
            t.get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| READ_SAFE_MCP_TOOLS.contains(&n))
        });
    }
    tools
}

async fn list_resources(client: &BridgeClient) -> Vec<Value> {
    let mut resources = vec![
        json!({
            "uri": "bridge://guide",
            "name": "Browser Bridge Agent Guide",
            "description": "Concise instructions and safety rules for interacting with shared browser tabs.",
            "mimeType": "text/markdown"
        }),
        json!({
            "uri": "bridge://routines",
            "name": "Site Memory & Fast Routines Catalog",
            "description": "All learned website routines, site tips, and auto-recorded pitfalls.",
            "mimeType": "application/json"
        }),
    ];
    for pb in routines::list_all_playbooks() {
        resources.push(json!({
            "uri": format!("bridge://routines/{}", pb.domain),
            "name": format!("Site Routines: {} ({} routines, {} pitfalls)", pb.domain, pb.routines.len(), pb.pitfalls.len()),
            "description": format!("Learned routines and pitfalls for {}", pb.domain),
            "mimeType": "application/json"
        }));
    }

    let all = client.connect_all().await;
    for (ep, conn_opt, _) in all {
        if conn_opt.is_none() {
            continue;
        }
        let inv = match client
            .send("tabs.inventory", json!({}), Some(&ep.instance_id), Duration::from_secs(5))
            .await
        {
            Ok((v, _)) => v,
            Err(_) => continue,
        };
        for tab in inv.get("tabs").and_then(Value::as_array).into_iter().flatten() {
            let Some(tab_id) = tab.get("tabId").and_then(Value::as_i64) else {
                continue;
            };
            let title = tab.get("title").and_then(Value::as_str).unwrap_or("Untitled");
            let url = tab.get("url").and_then(Value::as_str).unwrap_or("");
            let mode = tab.get("mode").and_then(Value::as_str).unwrap_or("write");
            resources.push(json!({
                "uri": format!("bridge://tab/{}/{tab_id}/snapshot", ep.instance_id),
                "name": format!("[{} #{tab_id} {mode}] {title} (snapshot)", ep.browser),
                "description": format!("Accessibility outline for {url}"),
                "mimeType": "text/plain"
            }));
            resources.push(json!({
                "uri": format!("bridge://tab/{}/{tab_id}/text", ep.instance_id),
                "name": format!("[{} #{tab_id} {mode}] {title} (text)", ep.browser),
                "description": format!("Visible page text for {url}"),
                "mimeType": "text/plain"
            }));
        }
    }
    resources
}

async fn read_resource(uri: &str, client: &BridgeClient) -> Result<Vec<Value>, String> {
    if uri == "bridge://guide" {
        let text = bridge_core::render_agent_guide(None);
        return Ok(vec![json!({
            "uri": uri,
            "mimeType": "text/markdown",
            "text": text
        })]);
    }
    if uri == "bridge://routines" {
        let all = routines::list_all_playbooks();
        return Ok(vec![json!({
            "uri": uri,
            "mimeType": "application/json",
            "text": serde_json::to_string_pretty(&all).unwrap_or_else(|_| "[]".into())
        })]);
    }
    if let Some(domain) = uri.strip_prefix("bridge://routines/") {
        let pb = routines::resolve_playbook(domain)
            .ok_or_else(|| format!("No site playbook found for '{domain}'."))?;
        return Ok(vec![json!({
            "uri": uri,
            "mimeType": "application/json",
            "text": serde_json::to_string_pretty(&pb).unwrap_or_else(|_| "{}".into())
        })]);
    }
    let Some(rest) = uri.strip_prefix("bridge://tab/") else {
        return Err(format!("Unsupported resource URI: {uri}"));
    };
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() != 3 {
        return Err(format!("Invalid tab resource URI: {uri}"));
    }
    let instance = parts[0];
    let tab_id: i64 = parts[1].parse().map_err(|_| format!("Invalid tabId in URI: {uri}"))?;
    let kind = parts[2];
    let method = match kind {
        "snapshot" => "page.snapshot",
        "text" => "page.text",
        _ => return Err(format!("Unknown resource view '{kind}' in {uri}")),
    };
    let (res, _) = client
        .send(method, json!({ "tabId": tab_id }), Some(instance), DEFAULT_TIMEOUT)
        .await
        .map_err(|e| e.to_string())?;
    let body = res.get("text").and_then(Value::as_str).unwrap_or("");
    Ok(vec![json!({
        "uri": uri,
        "mimeType": "text/plain",
        "text": body
    })])
}

fn prompt_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "inspect-shared-tab",
            "description": "Reads a shared browser tab's accessibility outline and WebMCP tools without modifying the page.",
            "arguments": [
                { "name": "tabId", "description": "Shared tab ID.", "required": true },
                { "name": "browser", "description": "Browser selector or instance ID.", "required": false }
            ]
        }),
        json!({
            "name": "discover-webmcp",
            "description": "Discovers and summarizes all WebMCP tools (imperative modelContext and declarative forms) on a shared tab.",
            "arguments": [
                { "name": "tabId", "description": "Shared tab ID.", "required": true },
                { "name": "browser", "description": "Browser selector or instance ID.", "required": false }
            ]
        }),
    ]
}

async fn get_prompt(name: &str, args: &Value, client: &BridgeClient) -> Result<Value, String> {
    let tab_id = args
        .get("tabId")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())))
        .ok_or_else(|| "Missing required integer argument 'tabId'.".to_string())?;
    let browser = args.get("browser").and_then(Value::as_str);

    match name {
        "inspect-shared-tab" => {
            let (snap, _) = client
                .send("page.snapshot", json!({ "tabId": tab_id }), browser, DEFAULT_TIMEOUT)
                .await
                .map_err(|e| e.to_string())?;
            let wmcp = client
                .send("page.webmcp.list", json!({ "tabId": tab_id }), browser, DEFAULT_TIMEOUT)
                .await
                .ok()
                .map(|(v, _)| v)
                .unwrap_or_else(|| json!({ "tools": [] }));
            let text = format!(
                "Inspect shared tab {tab_id} (mode: {}).\n\n## Snapshot\n{}\n\n## WebMCP Tools\n{}",
                wmcp.get("mode").and_then(Value::as_str).unwrap_or("read"),
                snap.get("text").and_then(Value::as_str).unwrap_or(""),
                serde_json::to_string_pretty(wmcp.get("tools").unwrap_or(&json!([]))).unwrap_or_default()
            );
            Ok(json!({
                "description": format!("Snapshot and WebMCP tools for shared tab {tab_id}"),
                "messages": [{ "role": "user", "content": { "type": "text", "text": text } }]
            }))
        }
        "discover-webmcp" => {
            let (wmcp, _) = client
                .send("page.webmcp.list", json!({ "tabId": tab_id }), browser, DEFAULT_TIMEOUT)
                .await
                .map_err(|e| e.to_string())?;
            let text = format!(
                "WebMCP tools exposed on shared tab {tab_id} (access mode: {}):\n{}",
                wmcp.get("mode").and_then(Value::as_str).unwrap_or("read"),
                serde_json::to_string_pretty(wmcp.get("tools").unwrap_or(&json!([]))).unwrap_or_default()
            );
            Ok(json!({
                "description": format!("WebMCP tool catalog for tab {tab_id}"),
                "messages": [{ "role": "user", "content": { "type": "text", "text": text } }]
            }))
        }
        _ => Err(format!("Unknown prompt: {name}")),
    }
}

fn text_ok(text: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }] })
}

fn text_err(message: impl Into<String>) -> Value {
    json!({ "isError": true, "content": [{ "type": "text", "text": message.into() }] })
}

fn fail(err: BridgeError) -> Value {
    text_err(err.to_string())
}

fn add_tab(params: &mut Map<String, Value>, args: &Value) {
    if let Some(tab_id) = args.get("tabId").and_then(Value::as_i64) {
        params.insert("tabId".into(), json!(tab_id));
    }
}

fn add_target(params: &mut Map<String, Value>, args: &Value, required: bool) -> Result<(), Value> {
    let ref_str = args.get("ref").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let locator = args.get("locator").filter(|v| !v.is_null());
    if (ref_str.is_some() && locator.is_some()) || (required && ref_str.is_none() && locator.is_none()) {
        return Err(text_err("Provide exactly one of ref or locator. [bad_request]"));
    }
    if let Some(r) = ref_str {
        params.insert("ref".into(), json!(r));
    }
    if let Some(l) = locator {
        params.insert("locator".into(), l.clone());
    }
    Ok(())
}

fn val_str(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(other) if !other.is_null() => other.to_string(),
        _ => String::new(),
    }
}

fn format_action(verb: &str, result: &Value) -> String {
    let mut out = verb.to_string();
    if let Some(input) = result.get("input").and_then(Value::as_str) {
        out.push_str(if input == "trusted" { " (trusted input)" } else { " (DOM events)" });
    }
    if let Some(val) = result.get("value").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        out.push_str(&format!("; field value is now {}", serde_json::to_string(val).unwrap_or_default()));
    }
    out.push('.');
    if let Some(url) = result.get("url").and_then(Value::as_str) {
        let nav = if result.get("navigated").and_then(Value::as_bool) == Some(true) { " Navigated to" } else { " Page:" };
        let title = val_str(result.get("title"));
        out.push_str(&format!("{nav} {title} — {url}"));
    }
    if let Some(opened) = result.get("openedTabs").and_then(Value::as_array).filter(|a| !a.is_empty()) {
        let ids: Vec<String> = opened.iter().map(|v| v.to_string()).collect();
        out.push_str(&format!("\nOpened new tab(s): {} (available to this agent; use browser_tabs select).", ids.join(", ")));
    }
    if let Some(warnings) = result.get("warnings").and_then(Value::as_array) {
        for w in warnings {
            if let Some(s) = w.as_str() {
                out.push_str(&format!("\nWarning: {s}"));
            }
        }
    }
    out
}

fn extract_snapshot_url(snapshot_text: &str) -> Option<&str> {
    snapshot_text
        .lines()
        .take(4)
        .find_map(|line| line.strip_prefix("URL: ").map(str::trim))
        .filter(|s| !s.is_empty())
}

async fn tracked_send(
    client: &BridgeClient,
    tracker: &Mutex<SessionTracker>,
    method: &str,
    params: Value,
    browser: Option<&str>,
    timeout: Duration,
) -> Result<(Value, Arc<BridgeConnection>), BridgeError> {
    let tab_id = params.get("tabId").and_then(Value::as_i64);
    let url_hint = params.get("url").and_then(Value::as_str).map(str::to_string);
    let started = Instant::now();
    let outcome = client.send(method, params.clone(), browser, timeout).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let mut guard = tracker.lock().await;
    match &outcome {
        Ok((res, _)) => {
            let snap_url = res
                .get("text")
                .and_then(Value::as_str)
                .and_then(extract_snapshot_url);
            let effective_hint = url_hint.as_deref().or(snap_url);
            guard.record_call(tab_id, effective_hint, method, &params, elapsed_ms, Ok(res));
        }
        Err(err) => {
            guard.record_call(tab_id, url_hint.as_deref(), method, &params, elapsed_ms, Err(err));
        }
    }
    outcome
}

async fn resolve_target_domain(
    args: &Value,
    browser: Option<&str>,
    client: &BridgeClient,
    tracker: &Mutex<SessionTracker>,
) -> Result<(Option<i64>, String), String> {
    if let Some(d) = args
        .get("domain")
        .and_then(Value::as_str)
        .and_then(routines::extract_domain)
    {
        return Ok((args.get("tabId").and_then(Value::as_i64), d));
    }
    let tab_id = args.get("tabId").and_then(Value::as_i64);
    if let Some(tid) = tab_id {
        if let Some(cached) = tracker.lock().await.tab_urls.get(&tid).cloned() {
            if let Some(d) = routines::extract_domain(&cached) {
                return Ok((Some(tid), d));
            }
        }
    }
    let mut p = Map::new();
    if let Some(tid) = tab_id {
        p.insert("tabId".into(), json!(tid));
    }
    let (info, _) = client
        .send("page.info", Value::Object(p), browser, DEFAULT_TIMEOUT)
        .await
        .map_err(|e| e.to_string())?;
    let resolved_tid = info.get("tabId").and_then(Value::as_i64).or(tab_id);
    let url = info.get("url").and_then(Value::as_str).unwrap_or("");
    if !url.is_empty() {
        tracker.lock().await.observe_url(resolved_tid, Some(url));
    }
    let domain = routines::extract_domain(url)
        .ok_or_else(|| format!("Tab URL '{url}' does not have a valid domain; pass 'domain' explicitly."))?;
    Ok((resolved_tid, domain))
}

async fn call_tool(
    name: &str,
    args: &Value,
    opts: McpOptions,
    client: &BridgeClient,
    tracker: &Mutex<SessionTracker>,
) -> Value {
    if opts.read_only && !READ_SAFE_MCP_TOOLS.contains(&name) {
        return text_err(format!(
            "Tool \"{name}\" is disabled because this Browser Bridge MCP server is running in --read-only mode (no page-action capability). [read_only]"
        ));
    }
    let browser = args.get("browser").and_then(Value::as_str);
    match name {
        "browser_status" => {
            let all = client.connect_all().await;
            let (res, conn) = match client.send("status", json!({}), browser, DEFAULT_TIMEOUT).await {
                Ok(v) => v,
                Err(err) => return fail(err),
            };
            let mut lines = vec!["Connected browsers:".to_string()];
            for (ep, c, err) in &all {
                let marker = if ep.pipe_name == conn.endpoint.pipe_name { "* " } else { "  " };
                match c {
                    Some(cc) => lines.push(format!("{marker}{}", cc.describe())),
                    None => lines.push(format!("{marker}{} ({}): {}", ep.browser, ep.instance_id, err.as_deref().unwrap_or(""))),
                }
            }
            lines.push(String::new());
            lines.push(format!("Selected: {}", conn.describe()));
            let cur = res.get("currentTabId").filter(|v| !v.is_null()).map(|v| v.to_string()).unwrap_or_else(|| "none".into());
            lines.push(format!("Tabs this agent may use: {}; current tab: {cur}", val_str(res.get("accessibleTabs"))));
            lines.push(format!(
                "MCP read-only: {}; browser global read-only: {}; all-tabs mode: {}; trusted input: {}; page scripts allowed: {}",
                opts.read_only,
                val_str(res.get("readOnlyMode")),
                val_str(res.get("accessAllTabs")),
                val_str(res.get("trustedInput")),
                val_str(res.get("allowEvaluate"))
            ));
            text_ok(lines.join("\n"))
        }
        "browser_tabs" => {
            let action = args.get("action").and_then(Value::as_str).unwrap_or("list").trim().to_ascii_lowercase();
            if opts.read_only && action != "list" {
                return text_err(format!(
                    "browser_tabs action=\"{action}\" is disabled in --read-only MCP mode; only action=\"list\" is allowed. [read_only]"
                ));
            }
            match action.as_str() {
                "list" => {
                    let (res, conn) = match client.send("tabs.list", json!({}), browser, DEFAULT_TIMEOUT).await {
                        Ok(v) => v,
                        Err(err) => return fail(err),
                    };
                    let tabs = res.get("tabs").and_then(Value::as_array).cloned().unwrap_or_default();
                    if tabs.is_empty() {
                        return text_ok(format!(
                            "No tabs are available to this agent in {}. Open one with action=new, or ask the user to share a tab from the Browser Bridge toolbar button.",
                            conn.endpoint.browser
                        ));
                    }
                    let mut lines = vec![format!("Tabs available in {}:", conn.endpoint.browser)];
                    {
                        let mut guard = tracker.lock().await;
                        for tab in &tabs {
                            let tid = tab.get("tabId").and_then(Value::as_i64);
                            let u = tab.get("url").and_then(Value::as_str);
                            guard.observe_url(tid, u);
                        }
                    }
                    for tab in tabs {
                        let cur = if tab.get("current").and_then(Value::as_bool) == Some(true) { " (current)" } else { "" };
                        let mode = tab.get("mode").and_then(Value::as_str).unwrap_or("write");
                        let name_tag = tab
                            .get("name")
                            .and_then(Value::as_str)
                            .map(|n| format!(" #{n}"))
                            .unwrap_or_default();
                        let grp_tag = tab
                            .get("group")
                            .and_then(Value::as_str)
                            .map(|g| format!("; group={g}"))
                            .unwrap_or_default();
                        let wait_tag = if tab.get("waitingHandoff").and_then(Value::as_bool) == Some(true) {
                            "; WAIT"
                        } else if tab.get("running").and_then(Value::as_bool) == Some(true) {
                            "; RUN"
                        } else {
                            ""
                        };
                        lines.push(format!(
                            "- [{}]{name_tag}{cur} {} — {} [{}; mode={mode}{grp_tag}{wait_tag}]",
                            val_str(tab.get("tabId")),
                            val_str(tab.get("title")),
                            val_str(tab.get("url")),
                            val_str(tab.get("access"))
                        ));
                    }
                    text_ok(lines.join("\n"))
                }
                "new" => {
                    let mut p = Map::new();
                    if let Some(url) = args.get("url").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                        p.insert("url".into(), json!(url));
                    }
                    if let Some(name) = args.get("name").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                        p.insert("name".into(), json!(name));
                    }
                    if let Some(group) = args.get("group").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                        p.insert("group".into(), json!(group));
                    }
                    if let Some(act) = args.get("active").and_then(Value::as_bool) {
                        p.insert("active".into(), json!(act));
                    }
                    if let Some(ao) = args.get("allowedOrigins").and_then(Value::as_array) {
                        p.insert("allowedOrigins".into(), Value::Array(ao.clone()));
                    }
                    match client.send("tabs.new", Value::Object(p), browser, Duration::from_secs(60)).await {
                        Ok((res, _)) => {
                            let reused = if res.get("reused").and_then(Value::as_bool) == Some(true) {
                                "Reused named"
                            } else {
                                "Opened"
                            };
                            let challenge_note = format_challenge_suffix(&res);
                            text_ok(format!(
                                "{reused} tab {}: {} — {}. It is now the current tab.{challenge_note}",
                                val_str(res.get("tabId")),
                                val_str(res.get("title")),
                                val_str(res.get("url"))
                            ))
                        }
                        Err(err) => fail(err),
                    }
                }
                "select" => {
                    let mut p = Map::new();
                    add_tab(&mut p, args);
                    if let Some(n) = args.get("name").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                        p.insert("name".into(), json!(n));
                    }
                    if !p.contains_key("tabId") && !p.contains_key("name") {
                        return text_err("tabId or name is required for action=select. [bad_request]");
                    }
                    match client.send("tabs.select", Value::Object(p), browser, DEFAULT_TIMEOUT).await {
                        Ok((res, _)) => text_ok(format!(
                            "Current tab is now {}: {} — {}",
                            val_str(res.get("tabId")),
                            val_str(res.get("title")),
                            val_str(res.get("url"))
                        )),
                        Err(err) => fail(err),
                    }
                }
                "close" => {
                    let mut p = Map::new();
                    add_tab(&mut p, args);
                    if let Some(n) = args.get("name").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                        p.insert("name".into(), json!(n));
                    }
                    if let Some(g) = args.get("group").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                        p.insert("group".into(), json!(g));
                    }
                    match client.send("tabs.close", Value::Object(p), browser, DEFAULT_TIMEOUT).await {
                        Ok((res, _)) => {
                            if let Some(grp) = res.get("closedGroup").and_then(Value::as_str) {
                                let cnt = res.get("closedTabs").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
                                text_ok(format!("Closed {cnt} tab(s) in group '{grp}'."))
                            } else {
                                text_ok(format!("Closed tab {}.", val_str(res.get("closed"))))
                            }
                        }
                        Err(err) => fail(err),
                    }
                }
                _ => text_err("action must be list, new, select or close. [bad_request]"),
            }
        }
        "browser_navigate" => {
            let Some(url) = args.get("url").and_then(Value::as_str) else {
                return text_err("url is required. [bad_request]");
            };
            let mut p = Map::new();
            p.insert("url".into(), json!(url));
            p.insert("newTab".into(), json!(args.get("newTab").and_then(Value::as_bool).unwrap_or(false)));
            add_tab(&mut p, args);
            match tracked_send(client, tracker, "page.navigate", Value::Object(p), browser, Duration::from_secs(75)).await {
                Ok((res, _)) => {
                    let loading = if res.get("loaded").and_then(Value::as_bool) == Some(false) { " (still loading)" } else { "" };
                    let final_url = val_str(res.get("url"));
                    let challenge_note = format_challenge_suffix(&res);
                    let hint = tracker.lock().await.should_inject_hint(&final_url).unwrap_or_default();
                    text_ok(format!("Tab {}: {} — {final_url}{loading}{challenge_note}{hint}", val_str(res.get("tabId")), val_str(res.get("title"))))
                }
                Err(err) => fail(err),
            }
        }
        "browser_history" => {
            let Some(action) = args.get("action").and_then(Value::as_str) else {
                return text_err("action is required. [bad_request]");
            };
            let mut p = Map::new();
            p.insert("action".into(), json!(action));
            add_tab(&mut p, args);
            match tracked_send(client, tracker, "page.history", Value::Object(p), None, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(format!("Tab {}: {} — {}", val_str(res.get("tabId")), val_str(res.get("title")), val_str(res.get("url")))),
                Err(err) => fail(err),
            }
        }
        "browser_snapshot" => {
            let mut p = Map::new();
            p.insert("viewportOnly".into(), json!(args.get("viewportOnly").and_then(Value::as_bool).unwrap_or(false)));
            if let Some(f) = args.get("frames").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                p.insert("frames".into(), json!(f));
            }
            add_tab(&mut p, args);
            if let Some(m) = args.get("maxChars").and_then(Value::as_i64) {
                p.insert("maxChars".into(), json!(m));
            }
            if let Some(r) = args.get("root").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                p.insert("root".into(), json!(r));
            }
            match tracked_send(client, tracker, "page.snapshot", Value::Object(p), None, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => {
                    let mut out = val_str(res.get("text"));
                    if let Some(u) = extract_snapshot_url(&out) {
                        if let Some(hint) = tracker.lock().await.should_inject_hint(u) {
                            out.push_str(&hint);
                        }
                    }
                    text_ok(out)
                }
                Err(err) => fail(err),
            }
        }
        "browser_get_text" => {
            let mut p = Map::new();
            add_tab(&mut p, args);
            if let Err(err) = add_target(&mut p, args, false) {
                return err;
            }
            if let Some(m) = args.get("maxChars").and_then(Value::as_i64) {
                p.insert("maxChars".into(), json!(m));
            }
            match client.send("page.text", Value::Object(p), None, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => {
                    let trunc = if res.get("truncated").and_then(Value::as_bool) == Some(true) {
                        "\n[truncated; raise maxChars to read more]"
                    } else {
                        ""
                    };
                    text_ok(format!(
                        "Tab {}: {} — {}\n\n{}{trunc}",
                        val_str(res.get("tabId")),
                        val_str(res.get("title")),
                        val_str(res.get("url")),
                        val_str(res.get("text"))
                    ))
                }
                Err(err) => fail(err),
            }
        }
        "browser_locate" => {
            let Some(locator) = args.get("locator") else {
                return text_err("locator is required. [bad_request]");
            };
            let mut p = Map::new();
            p.insert("locator".into(), locator.clone());
            p.insert("maxResults".into(), json!(args.get("maxResults").and_then(Value::as_i64).unwrap_or(20)));
            add_tab(&mut p, args);
            match tracked_send(client, tracker, "page.locate", Value::Object(p), None, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(res.to_string()),
                Err(err) => fail(err),
            }
        }
        "browser_get_element" => {
            let mut p = Map::new();
            let raw_op = args.get("operation").and_then(Value::as_str).unwrap_or("inspect");
            p.insert("operation".into(), json!(normalize_element_operation(raw_op)));
            if let Err(err) = add_target(&mut p, args, true) {
                return err;
            }
            add_tab(&mut p, args);
            if let Some(attr) = args.get("attribute").and_then(Value::as_str) {
                p.insert("attribute".into(), json!(attr));
            }
            if let Some(m) = args.get("maxChars").and_then(Value::as_i64) {
                p.insert("maxChars".into(), json!(m));
            }
            match tracked_send(client, tracker, "page.query", Value::Object(p), None, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(res.to_string()),
                Err(err) => fail(err),
            }
        }
        "browser_click" => {
            let mut p = Map::new();
            p.insert("button".into(), json!(args.get("button").and_then(Value::as_str).unwrap_or("left")));
            p.insert("doubleClick".into(), json!(args.get("doubleClick").and_then(Value::as_bool).unwrap_or(false)));
            if let Err(err) = add_target(&mut p, args, true) {
                return err;
            }
            add_tab(&mut p, args);
            if let Some(mods) = args.get("modifiers").and_then(Value::as_array) {
                p.insert("modifiers".into(), Value::Array(mods.clone()));
            }
            let target_label = args.get("ref").and_then(Value::as_str).unwrap_or("locator");
            match tracked_send(client, tracker, "page.click", Value::Object(p), None, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(format_action(&format!("Clicked {target_label}"), &res)),
                Err(err) => fail(err),
            }
        }
        "browser_hover" => {
            let mut p = Map::new();
            if let Err(err) = add_target(&mut p, args, true) {
                return err;
            }
            add_tab(&mut p, args);
            let target_label = args.get("ref").and_then(Value::as_str).unwrap_or("locator");
            match tracked_send(client, tracker, "page.hover", Value::Object(p), None, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(format_action(&format!("Hovered {target_label}"), &res)),
                Err(err) => fail(err),
            }
        }
        "browser_drag" => {
            let mut p = Map::new();
            add_tab(&mut p, args);
            for key in [
                "fromRef", "fromLocator", "fromX", "fromY", "fromOffsetX", "fromOffsetY",
                "toRef", "toLocator", "toX", "toY", "toOffsetX", "toOffsetY", "dx", "dy", "steps",
            ] {
                if let Some(val) = args.get(key).filter(|v| !v.is_null()) {
                    p.insert(key.into(), val.clone());
                }
            }
            match tracked_send(client, tracker, "page.drag", Value::Object(p), None, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(format_action(
                    &format!(
                        "Dragged ({},{}) -> ({},{})",
                        val_str(res.get("fromX")),
                        val_str(res.get("fromY")),
                        val_str(res.get("toX")),
                        val_str(res.get("toY"))
                    ),
                    &res,
                )),
                Err(err) => fail(err),
            }
        }
        "browser_type" => {
            let Some(text) = args.get("text").and_then(Value::as_str) else {
                return text_err("text is required. [bad_request]");
            };
            let mut p = Map::new();
            p.insert("text".into(), json!(text));
            p.insert("clear".into(), json!(args.get("clear").and_then(Value::as_bool).unwrap_or(true)));
            p.insert("submit".into(), json!(args.get("submit").and_then(Value::as_bool).unwrap_or(false)));
            p.insert("slowly".into(), json!(args.get("slowly").and_then(Value::as_bool).unwrap_or(false)));
            if let Err(err) = add_target(&mut p, args, true) {
                return err;
            }
            add_tab(&mut p, args);
            let target_label = args.get("ref").and_then(Value::as_str).unwrap_or("locator");
            match client.send("page.type", Value::Object(p), None, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(format_action(&format!("Typed into {target_label}"), &res)),
                Err(err) => fail(err),
            }
        }
        "browser_fill_form" => {
            let fields_in = args.get("fields").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut fields_out = Vec::with_capacity(fields_in.len());
            for f in fields_in {
                let mut item = Map::new();
                if let Err(err) = add_target(&mut item, &f, true) {
                    return err;
                }
                item.insert("value".into(), json!(val_str(f.get("value"))));
                fields_out.push(Value::Object(item));
            }
            let mut p = Map::new();
            p.insert("fields".into(), Value::Array(fields_out));
            add_tab(&mut p, args);
            match client.send("page.fill", Value::Object(p), None, Duration::from_secs(90)).await {
                Ok((res, _)) => {
                    let lines: Vec<String> = res
                        .get("fields")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .map(|f| format!("- {}: {}", val_str(f.get("ref")), val_str(f.get("result"))))
                        .collect();
                    text_ok(format!("Filled fields:\n{}", lines.join("\n")))
                }
                Err(err) => fail(err),
            }
        }
        "browser_select_option" => {
            let values = args.get("values").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut p = Map::new();
            p.insert("values".into(), Value::Array(values));
            if let Err(err) = add_target(&mut p, args, true) {
                return err;
            }
            add_tab(&mut p, args);
            let target_label = args.get("ref").and_then(Value::as_str).unwrap_or("locator");
            match client.send("page.select", Value::Object(p), None, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => {
                    let sel: Vec<String> = res.get("selected").and_then(Value::as_array).into_iter().flatten().map(|v| val_str(Some(v))).collect();
                    text_ok(format_action(&format!("Selected {} in {target_label}", sel.join(", ")), &res))
                }
                Err(err) => fail(err),
            }
        }
        "browser_set_checked" => {
            let Some(checked) = args.get("checked").and_then(Value::as_bool) else {
                return text_err("checked must be a boolean. [bad_request]");
            };
            let mut p = Map::new();
            p.insert("checked".into(), json!(checked));
            if let Err(err) = add_target(&mut p, args, true) {
                return err;
            }
            add_tab(&mut p, args);
            let target_label = args.get("ref").and_then(Value::as_str).unwrap_or("locator");
            match client.send("page.check", Value::Object(p), None, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(format_action(
                    &format!("Set {target_label} checked={}; changed={}", val_str(res.get("checked")), val_str(res.get("changed"))),
                    &res,
                )),
                Err(err) => fail(err),
            }
        }
        "browser_press_key" => {
            let Some(key) = args.get("key").and_then(Value::as_str) else {
                return text_err("key is required. [bad_request]");
            };
            let mut p = Map::new();
            p.insert("key".into(), json!(key));
            if let Err(err) = add_target(&mut p, args, false) {
                return err;
            }
            add_tab(&mut p, args);
            match client.send("page.press", Value::Object(p), None, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(format_action(&format!("Pressed {key}"), &res)),
                Err(err) => fail(err),
            }
        }
        "browser_scroll" => {
            let mut p = Map::new();
            add_tab(&mut p, args);
            if let Some(dir) = args.get("direction").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                p.insert("direction".into(), json!(dir));
            }
            if let Some(amt) = args.get("amount").and_then(Value::as_f64) {
                p.insert("amount".into(), json!(amt));
            }
            if let Err(err) = add_target(&mut p, args, false) {
                return err;
            }
            match client.send("page.scroll", Value::Object(p), None, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => {
                    let end = if res.get("atEnd").and_then(Value::as_bool) == Some(true) { " Reached the end." } else { "" };
                    text_ok(format!("Scrolled. Position x={}, y={}.{end}", val_str(res.get("scrollX")), val_str(res.get("scrollY"))))
                }
                Err(err) => fail(err),
            }
        }
        "browser_wait_for" => {
            let seconds = args.get("seconds").and_then(Value::as_f64);
            let timeout_seconds = args.get("timeoutSeconds").and_then(Value::as_f64);
            if let Some(d) = seconds {
                if !d.is_finite() || !(0.0..=60.0).contains(&d) {
                    return text_err("seconds must be between 0 and 60. [bad_request]");
                }
            }
            if let Some(t) = timeout_seconds {
                if !t.is_finite() || t <= 0.0 || t > 600.0 {
                    return text_err("timeoutSeconds must be greater than 0 and at most 600. [bad_request]");
                }
            }
            let mut p = Map::new();
            add_tab(&mut p, args);
            if let Err(err) = add_target(&mut p, args, false) {
                return err;
            }
            for key in ["text", "textGone", "state", "loadState", "url"] {
                if let Some(v) = args.get(key).filter(|v| !v.is_null()) {
                    p.insert(key.into(), v.clone());
                }
            }
            if let Some(d) = seconds {
                p.insert("seconds".into(), json!(d));
            }
            if let Some(t) = timeout_seconds {
                p.insert("timeoutSeconds".into(), json!(t));
            }
            let budget = Duration::from_secs_f64(seconds.unwrap_or(0.0) + timeout_seconds.unwrap_or(10.0) + 15.0);
            match client.send("page.waitFor", Value::Object(p), None, budget).await {
                Ok((res, _)) => {
                    if let Some(found) = res.get("found").and_then(Value::as_str) {
                        text_ok(format!("Text \"{found}\" appeared after {} ms.", val_str(res.get("elapsedMs"))))
                    } else if let Some(gone) = res.get("gone").and_then(Value::as_str) {
                        text_ok(format!("Text \"{gone}\" is gone after {} ms.", val_str(res.get("elapsedMs"))))
                    } else if let Some(state) = res.get("state").and_then(Value::as_str) {
                        text_ok(format!("Element is {state} after {} ms.", val_str(res.get("elapsedMs"))))
                    } else if let Some(load) = res.get("loadState").and_then(Value::as_str) {
                        text_ok(format!("Page reached {load} after {} ms.", val_str(res.get("elapsedMs"))))
                    } else if let Some(url) = res.get("url").and_then(Value::as_str) {
                        text_ok(format!("Page reached {url} after {} ms.", val_str(res.get("elapsedMs"))))
                    } else {
                        text_ok(format!("Waited {} s.", seconds.unwrap_or(0.0)))
                    }
                }
                Err(err) => fail(err),
            }
        }
        "browser_screenshot" => {
            let save_path = args
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let inferred_fmt = save_path
                .filter(|p| p.to_ascii_lowercase().ends_with(".png"))
                .map(|_| "png")
                .unwrap_or("jpeg");
            let fmt = args
                .get("format")
                .and_then(Value::as_str)
                .unwrap_or(inferred_fmt);
            if fmt != "png" && fmt != "jpeg" {
                return text_err("format must be png or jpeg. [bad_request]");
            }
            let full_page = args.get("fullPage").and_then(Value::as_bool).unwrap_or(false);
            let mut p = Map::new();
            p.insert("format".into(), json!(fmt));
            if full_page {
                p.insert("fullPage".into(), json!(true));
            }
            if let Err(err) = add_target(&mut p, args, false) {
                return err;
            }
            if full_page && (p.contains_key("ref") || p.contains_key("locator")) {
                return text_err("Provide fullPage or ref/locator, not both. [bad_request]");
            }
            add_tab(&mut p, args);
            if let Some(q) = args.get("quality").and_then(Value::as_i64) {
                p.insert("quality".into(), json!(q));
            }
            if let Some(w) = args.get("maxWidth").and_then(Value::as_i64) {
                p.insert("maxWidth".into(), json!(w));
            } else if save_path.is_some() {
                p.insert("maxWidth".into(), json!(4096));
            }
            let timeout = if full_page { Duration::from_secs(45) } else { DEFAULT_TIMEOUT };
            match client.send("page.screenshot", Value::Object(p), None, timeout).await {
                Ok((res, _)) => {
                    let data = val_str(res.get("data"));
                    let mime = res.get("mimeType").and_then(Value::as_str).unwrap_or("image/jpeg");
                    if let Some(raw_path) = save_path {
                        let bytes = match bridge_core::decode_base64(&data) {
                            Ok(b) => b,
                            Err(e) => return text_err(format!("{e} [protocol_error]")),
                        };
                        let out = std::path::PathBuf::from(raw_path);
                        if let Some(parent) = out.parent() {
                            if !parent.as_os_str().is_empty() {
                                if let Err(e) = std::fs::create_dir_all(parent) {
                                    return text_err(format!("Could not create output directory {}: {e} [io_error]", parent.display()));
                                }
                            }
                        }
                        if let Err(e) = std::fs::write(&out, &bytes) {
                            return text_err(format!("Could not write screenshot to {}: {e} [io_error]", out.display()));
                        }
                        return text_ok(format!(
                            "Saved screenshot of tab {} ({}x{}, {mime}, {} bytes) to {}.",
                            val_str(res.get("tabId")),
                            val_str(res.get("width")),
                            val_str(res.get("height")),
                            bytes.len(),
                            out.display()
                        ));
                    }
                    json!({
                        "content": [
                            { "type": "image", "data": data, "mimeType": mime },
                            { "type": "text", "text": format!("Screenshot of tab {} ({}x{}, {mime}).", val_str(res.get("tabId")), val_str(res.get("width")), val_str(res.get("height"))) }
                        ]
                    })
                }
                Err(err) => fail(err),
            }
        }
        "browser_webmcp_list" => {
            let mut p = Map::new();
            add_tab(&mut p, args);
            match client.send("page.webmcp.list", Value::Object(p), browser, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(serde_json::to_string_pretty(&res).unwrap_or_else(|_| res.to_string())),
                Err(err) => fail(err),
            }
        }
        "browser_webmcp_call" => {
            let Some(tool_name) = args.get("name").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) else {
                return text_err("name is required. [bad_request]");
            };
            let mut p = Map::new();
            p.insert("name".into(), json!(tool_name));
            if let Some(arguments) = args.get("arguments").filter(|v| v.is_object()) {
                p.insert("arguments".into(), arguments.clone());
            }
            if let Some(submit) = args.get("submit").and_then(Value::as_bool) {
                p.insert("submit".into(), json!(submit));
            }
            if opts.read_only {
                p.insert("readOnly".into(), json!(true));
            }
            add_tab(&mut p, args);
            match client.send("page.webmcp.call", Value::Object(p), browser, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(serde_json::to_string_pretty(&res).unwrap_or_else(|_| res.to_string())),
                Err(err) => fail(err),
            }
        }
        "browser_upload_file" => {
            let Some(files_arr) = args.get("files").and_then(Value::as_array).filter(|a| !a.is_empty()) else {
                return text_err("files must be a non-empty array of local file paths. [bad_request]");
            };
            let mut target_params = Map::new();
            if let Err(err) = add_target(&mut target_params, args, true) {
                return err;
            }
            add_tab(&mut target_params, args);

            const CHUNK_RAW_BYTES: usize = 384 * 1024; // exact multiple of 3 for unpadded Base64 concatenation
            const MAX_UPLOAD_BYTES: u64 = 20 * 1024 * 1024;
            let upload_id = format!("mcp-up-{}", std::process::id());
            let mut total_bytes: u64 = 0;

            let paths: Vec<String> = files_arr
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            if paths.is_empty() {
                return text_err("files must contain string paths. [bad_request]");
            }

            for (file_idx, raw_path) in paths.iter().enumerate() {
                let path = std::path::Path::new(raw_path);
                let meta = match std::fs::metadata(path) {
                    Ok(m) if m.is_file() => m,
                    Ok(_) => return text_err(format!("{raw_path} is not a regular file. [bad_request]")),
                    Err(e) => return text_err(format!("Cannot read {raw_path}: {e} [io_error]")),
                };
                total_bytes = total_bytes.saturating_add(meta.len());
                if total_bytes > MAX_UPLOAD_BYTES {
                    return text_err("Total upload payload exceeds the 20 MiB limit. [body_too_large]");
                }
                let bytes = match std::fs::read(path) {
                    Ok(b) => b,
                    Err(e) => return text_err(format!("Cannot read {raw_path}: {e} [io_error]")),
                };
                let file_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("upload.bin")
                    .to_string();
                let mime = guess_mime(&file_name);
                let chunks: Vec<&[u8]> = if bytes.is_empty() {
                    vec![&[][..]]
                } else {
                    bytes.chunks(CHUNK_RAW_BYTES).collect()
                };

                for (chunk_idx, chunk) in chunks.iter().enumerate() {
                    let is_last = file_idx + 1 == paths.len() && chunk_idx + 1 == chunks.len();
                    let mut p = if is_last { target_params.clone() } else { Map::new() };
                    add_tab(&mut p, args);
                    p.insert("uploadId".into(), json!(upload_id));
                    if file_idx == 0 && chunk_idx == 0 {
                        p.insert("reset".into(), json!(true));
                    }
                    p.insert("fileName".into(), json!(file_name));
                    p.insert("mimeType".into(), json!(mime));
                    p.insert("chunkBase64".into(), json!(bridge_core::encode_base64(chunk)));
                    p.insert("append".into(), json!(chunk_idx > 0));
                    p.insert("commit".into(), json!(is_last));

                    match client.send("page.upload", Value::Object(p), browser, DEFAULT_TIMEOUT).await {
                        Ok((res, _)) if is_last => {
                            let names = res
                                .get("files")
                                .and_then(Value::as_array)
                                .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
                                .unwrap_or_default();
                            return text_ok(format!("Attached file(s) [{names}] on tab {}.", val_str(res.get("tabId"))));
                        }
                        Ok(_) => {}
                        Err(err) => return fail(err),
                    }
                }
            }
            text_err("Upload finished without committing. [internal_error]")
        }
        "browser_handle_dialog" => {
            let mut p = Map::new();
            p.insert("accept".into(), json!(args.get("accept").and_then(Value::as_bool).unwrap_or(true)));
            if let Some(t) = args.get("promptText").and_then(Value::as_str) {
                p.insert("promptText".into(), json!(t));
            }
            if let Some(arm) = args.get("armNext").and_then(Value::as_bool) {
                p.insert("armNext".into(), json!(arm));
            }
            add_tab(&mut p, args);
            match tracked_send(client, tracker, "page.dialog", Value::Object(p), browser, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(serde_json::to_string(&res).unwrap_or_default()),
                Err(err) => fail(err),
            }
        }
        "browser_batch" => {
            let Some(raw_steps) = args.get("steps") else {
                return text_err("steps array is required. [bad_request]");
            };
            let steps: Vec<routines::RoutineStep> = match serde_json::from_value(raw_steps.clone()) {
                Ok(s) => s,
                Err(e) => return text_err(format!("Invalid batch steps schema: {e} [bad_request]")),
            };
            let variables = args
                .get("variables")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let stop_on_error = args.get("stopOnError").and_then(Value::as_bool).unwrap_or(true);
            let save_name = args
                .get("saveAsRoutine")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let save_desc = args.get("description").and_then(Value::as_str).unwrap_or("");
            let tab_id = args.get("tabId").and_then(Value::as_i64);
            let batch_opts = routines::BatchRunOptions {
                steps: &steps,
                variables: &variables,
                tab_id,
                browser,
                enforce_read_only: opts.read_only,
                stop_on_error,
                save_as_routine: save_name.map(|n| (n, save_desc)),
            };
            match routines::execute_batch(client, batch_opts).await {
                Ok(res) => text_ok(serde_json::to_string_pretty(&res).unwrap_or_else(|_| res.to_string())),
                Err(msg) => text_err(msg),
            }
        }
        "browser_routine_list" => {
            if args.get("all").and_then(Value::as_bool) == Some(true) {
                let all = routines::list_all_playbooks();
                return text_ok(serde_json::to_string_pretty(&all).unwrap_or_else(|_| "[]".into()));
            }
            let (resolved_tid, domain) = match resolve_target_domain(args, browser, client, tracker).await {
                Ok(v) => v,
                Err(msg) => return text_err(format!("{msg} [bad_request]")),
            };
            let flush = args.get("flushAutoRoutines").and_then(Value::as_bool).unwrap_or(false);
            let pb: routines::SitePlaybook = match client
                .send(
                    "site.profile",
                    json!({ "domain": domain, "flushAutoRoutines": flush }),
                    browser,
                    Duration::from_secs(3),
                )
                .await
            {
                Ok((val, _)) => serde_json::from_value(val)
                    .unwrap_or_else(|_| routines::resolve_playbook(&domain).unwrap_or_else(|| routines::SitePlaybook::new(domain.clone()))),
                Err(_) => routines::resolve_playbook(&domain).unwrap_or_else(|| routines::SitePlaybook::new(domain.clone())),
            };
            let include_trace = args.get("includeTrace").and_then(Value::as_bool).unwrap_or(true);
            let trace: Vec<_> = if include_trace {
                let guard = tracker.lock().await;
                guard
                    .trace
                    .iter()
                    .filter(|ev| {
                        (resolved_tid.is_some() && ev.tab_id == resolved_tid)
                            || (!ev.domain.is_empty() && routines::domain_candidates(&ev.domain).contains(&pb.domain))
                    })
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            };
            let out = json!({
                "schemaVersion": pb.schema_version,
                "domain": pb.domain,
                "verifiedAt": pb.verified_at,
                "updatedAt": pb.updated_at,
                "speedupSummary": pb.speedup_summary,
                "accessProfile": pb.access_profile,
                "notes": pb.notes,
                "pitfalls": pb.pitfalls,
                "routines": pb.routines,
                "sessionTrace": trace,
            });
            text_ok(serde_json::to_string_pretty(&out).unwrap_or_else(|_| out.to_string()))
        }
        "browser_routine_run" => {
            let Some(routine_name) = args.get("name").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                return text_err("name is required. [bad_request]");
            };
            let (resolved_tid, domain) = match resolve_target_domain(args, browser, client, tracker).await {
                Ok(v) => v,
                Err(msg) => return text_err(format!("{msg} [bad_request]")),
            };
            let Some(pb) = routines::resolve_playbook(&domain) else {
                return text_err(format!("No routines found for domain '{domain}'. [not_found]"));
            };
            let Some(routine) = pb.routines.get(routine_name).cloned() else {
                let available: Vec<&str> = pb.routines.keys().map(String::as_str).collect();
                return text_err(format!(
                    "Routine '{routine_name}' not found for '{}'. Available: {}. [not_found]",
                    pb.domain,
                    available.join(", ")
                ));
            };
            let arguments = args
                .get("arguments")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            match routines::execute_routine(client, &routine, &arguments, resolved_tid, browser, opts.read_only).await {
                Ok(res) => text_ok(serde_json::to_string_pretty(&res).unwrap_or_else(|_| res.to_string())),
                Err(msg) => text_err(msg),
            }
        }
        "browser_routine_save" => {
            let (_, domain) = match resolve_target_domain(args, browser, client, tracker).await {
                Ok(v) => v,
                Err(msg) => return text_err(format!("{msg} [bad_request]")),
            };
            let note = args.get("note").and_then(Value::as_str);
            let delete_routine = args.get("deleteRoutine").and_then(Value::as_str);
            let reset_profile = args.get("resetAccessProfile").and_then(Value::as_bool) == Some(true);
            let parsed_routine = match args.get("routine").filter(|v| !v.is_null()) {
                Some(raw) => match serde_json::from_value::<RoutineDefinition>(raw.clone()) {
                    Ok(r) => Some(r),
                    Err(e) => return text_err(format!("Invalid routine schema: {e} [bad_request]")),
                },
                None => None,
            };
            if note.is_none() && delete_routine.is_none() && parsed_routine.is_none() && !reset_profile {
                return text_err("Provide at least one of 'routine', 'note', 'deleteRoutine', or 'resetAccessProfile'. [bad_request]");
            }
            let _ = client
                .send(
                    "site.save",
                    json!({
                        "domain": domain,
                        "note": note,
                        "deleteRoutine": delete_routine,
                        "resetAccessProfile": reset_profile,
                        "routine": args.get("routine"),
                    }),
                    browser,
                    Duration::from_secs(3),
                )
                .await;
            match routines::upsert_site_memory(&domain, note, parsed_routine, delete_routine, reset_profile) {
                Ok((path, pb)) => text_ok(format!(
                    "Saved Site Memory for '{}' ({} routine(s), {} note(s)) -> {}",
                    pb.domain,
                    pb.routines.len(),
                    pb.notes.len(),
                    path.display()
                )),
                Err(msg) => text_err(format!("{msg} [bad_request]")),
            }
        }
        "browser_allowlist" => {
            let has_mutation = args.get("origins").is_some() || args.get("clear").and_then(Value::as_bool) == Some(true);
            if opts.read_only && has_mutation {
                return text_err("Modifying allowedOrigins is disabled in --read-only MCP mode. [read_only]");
            }
            let mut p = Map::new();
            add_tab(&mut p, args);
            if let Some(o) = args.get("origins") {
                p.insert("origins".into(), o.clone());
            }
            if let Some(c) = args.get("clear").and_then(Value::as_bool) {
                p.insert("clear".into(), json!(c));
            }
            match client.send("session.allowlist", Value::Object(p), browser, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(serde_json::to_string_pretty(&res).unwrap_or_default()),
                Err(err) => fail(err),
            }
        }
        "browser_handoff" => {
            let mut p = Map::new();
            add_tab(&mut p, args);
            if let Some(m) = args.get("message").and_then(Value::as_str) {
                p.insert("message".into(), json!(m));
            }
            if let Some(fg) = args.get("bringToFront").and_then(Value::as_bool) {
                p.insert("bringToFront".into(), json!(fg));
            }
            let secs = args.get("timeoutSeconds").and_then(Value::as_f64).unwrap_or(300.0).clamp(1.0, 600.0);
            p.insert("timeoutMs".into(), json!((secs * 1000.0) as u64));
            let wait_budget = Duration::from_secs_f64(secs + 10.0);
            match tracked_send(client, tracker, "page.handoff", Value::Object(p), browser, wait_budget).await {
                Ok((res, _)) => {
                    let completed = res.get("completed").and_then(Value::as_bool) == Some(true);
                    let act = res.get("action").and_then(Value::as_str).unwrap_or("unknown");
                    if completed {
                        text_ok(format!(
                            "User completed handoff on tab {}: {} — {}",
                            val_str(res.get("tabId")),
                            val_str(res.get("title")),
                            val_str(res.get("url"))
                        ))
                    } else {
                        text_err(format!(
                            "Handoff ended without completion (action={act}) on tab {}. [handoff_{act}]",
                            val_str(res.get("tabId"))
                        ))
                    }
                }
                Err(err) => fail(err),
            }
        }
        "browser_demonstrate" => {
            let mut p = Map::new();
            add_tab(&mut p, args);
            if let Some(inst) = args.get("instruction").and_then(Value::as_str) {
                p.insert("instruction".into(), json!(inst));
            }
            let secs = args.get("timeoutSeconds").and_then(Value::as_f64).unwrap_or(300.0).clamp(1.0, 600.0);
            p.insert("timeoutMs".into(), json!((secs * 1000.0) as u64));
            let wait_budget = Duration::from_secs_f64(secs + 10.0);
            match tracked_send(client, tracker, "page.demonstrate", Value::Object(p), browser, wait_budget).await {
                Ok((mut res, _)) => {
                    let completed = res.get("completed").and_then(Value::as_bool) == Some(true);
                    if completed {
                        if let Some(save_name) = args.get("saveAs").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                            let tab_url = res.get("url").and_then(Value::as_str).unwrap_or("");
                            let raw_steps = res.get("steps").cloned().unwrap_or_else(|| json!([]));
                            if let Ok(steps) = serde_json::from_value::<Vec<routines::RoutineStep>>(raw_steps) {
                                if !steps.is_empty() {
                                    let desc = args
                                        .get("description")
                                        .and_then(Value::as_str)
                                        .filter(|s| !s.is_empty())
                                        .map(str::to_string)
                                        .unwrap_or_else(|| format!("User-demonstrated workflow ({} steps).", steps.len()));
                                    let now_ts = routines::now_iso8601();
                                    let routine_def = RoutineDefinition {
                                        name: save_name.to_string(),
                                        description: desc,
                                        read_only: false,
                                        verified_at: Some(now_ts.clone()),
                                        updated_at: Some(now_ts),
                                        params: std::collections::BTreeMap::new(),
                                        steps,
                                        ..Default::default()
                                    };
                                    let _ = client
                                        .send(
                                            "site.save",
                                            json!({ "domain": tab_url, "routine": routine_def }),
                                            browser,
                                            Duration::from_secs(3),
                                        )
                                        .await;
                                    if let Ok((path, pb)) = routines::upsert_site_memory(tab_url, None, Some(routine_def), None, false) {
                                        if let Some(obj) = res.as_object_mut() {
                                            obj.insert("savedRoutine".into(), json!(save_name));
                                            obj.insert("savedDomain".into(), json!(pb.domain));
                                            obj.insert("savedPath".into(), json!(path.display().to_string()));
                                        }
                                    }
                                }
                            }
                        }
                    }
                    text_ok(serde_json::to_string_pretty(&res).unwrap_or_else(|_| res.to_string()))
                }
                Err(err) => fail(err),
            }
        }
        "browser_network" => {
            let mut p = Map::new();
            add_tab(&mut p, args);
            for k in ["action", "onlyFailures", "urlInclude", "limit", "maxEntries"] {
                if let Some(v) = args.get(k) {
                    p.insert(k.to_string(), v.clone());
                }
            }
            match tracked_send(client, tracker, "page.network", Value::Object(p), browser, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(serde_json::to_string_pretty(&res).unwrap_or_default()),
                Err(err) => fail(err),
            }
        }
        "browser_console" => {
            let mut p = Map::new();
            add_tab(&mut p, args);
            for k in ["action", "level", "limit", "clear"] {
                if let Some(v) = args.get(k) {
                    p.insert(k.to_string(), v.clone());
                }
            }
            match tracked_send(client, tracker, "page.console", Value::Object(p), browser, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(serde_json::to_string_pretty(&res).unwrap_or_default()),
                Err(err) => fail(err),
            }
        }
        "browser_evaluate" if opts.allow_evaluate && !opts.read_only => {
            let Some(expr) = args.get("expression").and_then(Value::as_str) else {
                return text_err("expression is required. [bad_request]");
            };
            let mut p = Map::new();
            p.insert("expression".into(), json!(expr));
            add_tab(&mut p, args);
            match client.send("page.evaluate", Value::Object(p), None, DEFAULT_TIMEOUT).await {
                Ok((res, _)) => text_ok(res.get("result").and_then(Value::as_str).unwrap_or("null")),
                Err(err) => fail(err),
            }
        }
        _ => text_err(format!("Unknown tool: {name}")),
    }
}

fn format_challenge_suffix(res: &Value) -> String {
    let Some(ch) = res.get("challenge") else {
        return String::new();
    };
    let kind = ch.get("kind").and_then(Value::as_str).unwrap_or("challenge");
    let summary = ch.get("summary").and_then(Value::as_str).unwrap_or("");
    if summary.is_empty() {
        String::new()
    } else {
        format!("\n[Bot Challenge Detected ({kind})]: {summary}")
    }
}

fn normalize_element_operation(raw: &str) -> &str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "inspect" | "summary" => "inspect",
        "count" => "count",
        "innertext" | "inner_text" | "text" => "innerText",
        "textcontent" | "text_content" => "textContent",
        "inputvalue" | "input_value" | "value" => "inputValue",
        "getattribute" | "get_attribute" | "attribute" | "attr" => "getAttribute",
        "isvisible" | "is_visible" | "visible" => "isVisible",
        "ishidden" | "is_hidden" | "hidden" => "isHidden",
        "isenabled" | "is_enabled" | "enabled" => "isEnabled",
        "isdisabled" | "is_disabled" | "disabled" => "isDisabled",
        "iseditable" | "is_editable" | "editable" => "isEditable",
        "ischecked" | "is_checked" | "checked" => "isChecked",
        _ => raw,
    }
}

fn guess_mime(file_name: &str) -> &'static str {
    let lower = file_name.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".pdf") {
        "application/pdf"
    } else if lower.ends_with(".json") {
        "application/json"
    } else if lower.ends_with(".csv") {
        "text/csv"
    } else if lower.ends_with(".txt") || lower.ends_with(".md") {
        "text/plain"
    } else {
        "application/octet-stream"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_only_mcp_strips_action_tools_and_blocks_mutating_calls() {
        let client = BridgeClient::new("test-ro", false);
        let ro_opts = McpOptions {
            allow_evaluate: true,
            read_only: true,
        };
        let list = handle_rpc(&json!(1), "tools/list", &json!({}), ro_opts, &client).await;
        let names: Vec<&str> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.get("name").and_then(Value::as_str))
            .collect();

        assert!(names.contains(&"browser_snapshot"));
        assert!(names.contains(&"browser_screenshot"));
        assert!(names.contains(&"browser_webmcp_list"));
        assert!(names.contains(&"browser_batch"));
        assert!(!names.contains(&"browser_click"));
        assert!(!names.contains(&"browser_type"));
        assert!(!names.contains(&"browser_navigate"));
        assert!(!names.contains(&"browser_evaluate"));
        assert!(!names.contains(&"browser_upload_file"));

        let blocked_batch = handle_rpc(
            &json!(99),
            "tools/call",
            &json!({
                "name": "browser_batch",
                "arguments": {
                    "steps": [
                        { "op": "snapshot", "params": {} },
                        { "op": "click", "params": { "ref": "e1" } }
                    ]
                }
            }),
            ro_opts,
            &client,
        )
        .await;
        assert_eq!(blocked_batch["result"]["isError"], json!(true));
        assert!(
            blocked_batch["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or("")
                .contains("[read_only]")
        );

        let blocked = handle_rpc(
            &json!(2),
            "tools/call",
            &json!({ "name": "browser_click", "arguments": { "ref": "e1" } }),
            ro_opts,
            &client,
        )
        .await;
        assert_eq!(blocked["result"]["isError"], json!(true));
        assert!(
            blocked["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or("")
                .contains("[read_only]")
        );

        let blocked_new_tab = handle_rpc(
            &json!(3),
            "tools/call",
            &json!({ "name": "browser_tabs", "arguments": { "action": "new" } }),
            ro_opts,
            &client,
        )
        .await;
        assert_eq!(blocked_new_tab["result"]["isError"], json!(true));

        assert_eq!(normalize_element_operation("value"), "inputValue");
        assert_eq!(normalize_element_operation("text"), "innerText");
        assert_eq!(normalize_element_operation("attr"), "getAttribute");
        assert_eq!(normalize_element_operation("visible"), "isVisible");
    }
}
