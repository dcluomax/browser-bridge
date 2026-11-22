use serde_json::{Value, json};

pub fn method(name: &str) -> Option<&'static str> {
    match name {
        "browser_styles" => Some("page.styles"),
        "browser_layout" => Some("page.layout"),
        "browser_dom_baseline" => Some("page.domBaseline"),
        "browser_patch" => Some("page.patch"),
        "browser_performance" => Some("page.performance"),
        "browser_har" => Some("page.har"),
        "browser_debugger" => Some("page.debugger"),
        "browser_intercept" => Some("page.intercept"),
        _ => None,
    }
}

pub fn read_safe(name: &str, args: &Value) -> bool {
    match name {
        "browser_patch" | "browser_intercept" => {
            args.get("action").and_then(Value::as_str).unwrap_or("list") == "list"
        }
        _ => method(name).is_some(),
    }
}

pub fn definitions(locator: &Value, read_only: bool) -> Vec<Value> {
    let target = json!({
        "type": "object",
        "properties": {
            "ref": { "type": "string" },
            "locator": locator,
        },
        "additionalProperties": false
    });
    let string_map = json!({
        "type": "object",
        "maxProperties": 50,
        "additionalProperties": { "type": ["string", "null"] }
    });
    let patch_actions = if read_only { json!(["list"]) } else { json!(["apply", "list", "rollback", "commit"]) };
    let intercept_actions = if read_only { json!(["list"]) } else { json!(["list", "set", "clear"]) };
    let mut tools = vec![
        json!({
            "name": "browser_styles",
            "description": "Reads bounded computed CSS properties or class/inline/matched-rule context. Reports inaccessible stylesheets and does not claim a cascade winner.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["computed", "context"], "default": "computed" },
                    "properties": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 64, "uniqueItems": true },
                    "pseudo": { "type": "string" },
                    "ref": { "type": "string" },
                    "locator": locator,
                }
            }
        }),
        json!({
            "name": "browser_layout",
            "description": "Reads viewport-relative box model evidence or performs a read-only point hit test. No pointer input is dispatched.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["box", "hitTest"], "default": "box" },
                    "ref": { "type": "string" },
                    "locator": locator,
                    "x": { "type": "number", "minimum": -1000000, "maximum": 1000000 },
                    "y": { "type": "number", "minimum": -1000000, "maximum": 1000000 },
                }
            }
        }),
        json!({
            "name": "browser_dom_baseline",
            "description": "Creates, compares, describes or releases a document-local semantic DOM baseline. Handles belong to this session, expire in five minutes, and cannot survive navigation. Partial comparisons cannot prove unchanged.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["create", "compare", "describe", "release"], "default": "create" },
                    "id": { "type": "string", "maxLength": 100 },
                    "ref": { "type": "string" },
                    "locator": locator,
                    "maxNodes": { "type": "integer", "minimum": 1, "maximum": 2000 },
                    "maxText": { "type": "integer", "minimum": 0, "maximum": 65536 },
                    "maxChanges": { "type": "integer", "minimum": 1, "maximum": 500 },
                }
            }
        }),
        json!({
            "name": "browser_patch",
            "description": "Applies bounded temporary inline-style, safe-attribute or leaf-text patches. Rollback preserves original presence and style priority and refuses app-change conflicts. commit keeps only live DOM changes, not source changes. Read-only mode allows list only.",
            "annotations": { "readOnlyHint": read_only },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": patch_actions, "default": "list" },
                    "id": { "type": "string", "maxLength": 100 },
                    "label": { "type": "string" },
                    "ttlMs": { "type": "integer" },
                    "changes": {
                        "type": "array", "minItems": 1, "maxItems": 50,
                        "items": {
                            "type": "object",
                            "properties": {
                                "target": target,
                                "styles": string_map,
                                "attributes": string_map,
                                "text": { "type": "string" }
                            },
                            "required": ["target"],
                            "additionalProperties": false
                        }
                    },
                }
            }
        }),
        json!({
            "name": "browser_performance",
            "description": "Reads actual browser navigation/resource performance entries. Unavailable cross-origin timing stays null. This is not a Web Vitals measurement or a benchmark.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "includeResources": { "type": "boolean", "default": false },
                    "maxEntries": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
                }
            }
        }),
        json!({
            "name": "browser_har",
            "description": "Exports metadata-only HAR 1.2 from this session's existing browser_network capture. Start capture and reproduce first. Export never starts/stops/clears capture and omits headers, cookies, bodies and URL query credentials.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 200 },
                    "onlyFailures": { "type": "boolean", "default": false }
                }
            }
        }),
        json!({
            "name": "browser_debugger",
            "description": "Reads Chromium Performance.getMetrics counters through the existing debugger permission. Arbitrary CDP/evaluation is not exposed. Firefox reports unsupported; use browser_performance there.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": { "action": { "type": "string", "enum": ["metrics"], "default": "metrics" } }
            }
        }),
        json!({
            "name": "browser_intercept",
            "description": "Explicitly sets, lists or clears Chromium request block/static mock rules for one authorized tab. Rules expire in five minutes and are removed on navigation/revocation/disconnect. No credentials are exposed. Firefox reports unsupported for mutations. Read-only mode allows list only.",
            "annotations": { "readOnlyHint": read_only },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": intercept_actions, "default": "list" },
                    "rules": {
                        "type": "array", "minItems": 1, "maxItems": 16,
                        "items": {
                            "type": "object",
                            "properties": {
                                "urlPattern": { "type": "string", "maxLength": 2048 },
                                "action": { "type": "string", "enum": ["block", "fulfill"] },
                                "status": { "type": "integer", "minimum": 200, "maximum": 599 },
                                "body": { "type": "string", "maxLength": 65536 },
                                "contentType": { "type": "string", "maxLength": 128 }
                            },
                            "required": ["urlPattern", "action"],
                            "additionalProperties": false
                        }
                    }
                }
            }
        }),
    ];
    for tool in &mut tools {
        let properties = tool["inputSchema"]["properties"].as_object_mut().expect("tool properties");
        properties.insert("tabId".into(), json!({ "type": "integer" }));
        properties.insert("frameId".into(), json!({
            "type": "integer", "minimum": 0,
            "description": "Document frame id; defaults to main frame 0. Reuse the frameId returned with a baseline/patch handle."
        }));
    }
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_tools_have_no_mutating_patch_or_intercept_actions() {
        let tools = definitions(&json!({ "type": "object" }), true);
        for name in ["browser_patch", "browser_intercept"] {
            let tool = tools.iter().find(|tool| tool["name"] == name).unwrap();
            assert_eq!(tool["inputSchema"]["properties"]["action"]["enum"], json!(["list"]));
            assert!(!read_safe(name, &json!({ "action": "apply" })));
            assert!(read_safe(name, &json!({ "action": "list" })));
        }
        assert_eq!(method("browser_dom_baseline"), Some("page.domBaseline"));
        assert!(read_safe("browser_performance", &json!({})));
    }
}
