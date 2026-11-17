use base64::Engine;
use serde_json::{Map, Value, json};
use std::io::Read;
use std::time::Duration;

#[derive(Debug)]
pub struct HttpError {
    pub code: &'static str,
    pub message: String,
}

impl HttpError {
    fn bad(msg: impl Into<String>) -> Self {
        Self { code: "bad_request", message: msg.into() }
    }
    fn too_large(max: usize) -> Self {
        Self {
            code: "body_too_large",
            message: format!("Response exceeds the {max}-byte limit."),
        }
    }
}

pub fn max_bytes(params: &Value) -> Result<usize, HttpError> {
    match params.get("maxBytes") {
        None | Some(Value::Null) => Ok(20 * 1024 * 1024),
        Some(v) => {
            let n = v.as_i64().ok_or_else(|| HttpError::bad("maxBytes must be an integer."))?;
            if !(1..=32 * 1024 * 1024).contains(&n) {
                return Err(HttpError::bad("maxBytes must be between 1 and 33554432."));
            }
            Ok(n as usize)
        }
    }
}

pub fn fetch_sync(params: &Value, timeout: Duration) -> Result<Value, HttpError> {
    let url = params
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| HttpError::bad("Requests require an absolute HTTP(S) URL without embedded credentials."))?;
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(HttpError::bad("Requests require an absolute HTTP(S) URL without embedded credentials."));
    }
    let after_scheme = url.split_once("://").map(|x| x.1).unwrap_or("");
    let authority = after_scheme.split('/').next().unwrap_or("");
    if authority.contains('@') {
        return Err(HttpError::bad("Requests require an absolute HTTP(S) URL without embedded credentials."));
    }

    let max = max_bytes(params)?;
    let method = params
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .to_ascii_uppercase();

    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .build()
        .new_agent();

    let mut headers_to_send = Vec::<(String, String)>::new();
    if let Some(h) = params.get("headers") {
        if !h.is_null() {
            let obj = h.as_object().ok_or_else(|| HttpError::bad("headers must be an object of strings."))?;
            for (k, v) in obj {
                let s = v.as_str().ok_or_else(|| HttpError::bad("Header values must be strings."))?;
                headers_to_send.push((k.clone(), s.to_string()));
            }
        }
    }

    let body_str = params.get("body").and_then(Value::as_str);
    let response = match method.as_str() {
        "GET" => {
            let mut req = agent.get(url);
            for (k, v) in &headers_to_send {
                req = req.header(k.as_str(), v.as_str());
            }
            req.call()
        }
        "HEAD" => {
            let mut req = agent.head(url);
            for (k, v) in &headers_to_send {
                req = req.header(k.as_str(), v.as_str());
            }
            req.call()
        }
        "DELETE" => {
            let mut req = agent.delete(url);
            for (k, v) in &headers_to_send {
                req = req.header(k.as_str(), v.as_str());
            }
            req.call()
        }
        "POST" => {
            let mut req = agent.post(url);
            for (k, v) in &headers_to_send {
                req = req.header(k.as_str(), v.as_str());
            }
            req.send(body_str.unwrap_or(""))
        }
        "PUT" => {
            let mut req = agent.put(url);
            for (k, v) in &headers_to_send {
                req = req.header(k.as_str(), v.as_str());
            }
            req.send(body_str.unwrap_or(""))
        }
        "PATCH" => {
            let mut req = agent.patch(url);
            for (k, v) in &headers_to_send {
                req = req.header(k.as_str(), v.as_str());
            }
            req.send(body_str.unwrap_or(""))
        }
        _ => return Err(HttpError::bad(format!("Unsupported HTTP method {method}."))),
    }
    .map_err(|err| HttpError {
        code: "request_failed",
        message: err.to_string(),
    })?;

    let status = response.status().as_u16();
    let final_url = response
        .headers()
        .get("content-location")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| url.to_string());

    if let Some(len_str) = response.headers().get("content-length").and_then(|v| v.to_str().ok()) {
        if let Ok(len) = len_str.parse::<usize>() {
            if len > max {
                return Err(HttpError::too_large(max));
            }
        }
    }

    let mut resp_headers = Map::new();
    for (name, val) in response.headers() {
        let lower_name = name.as_str().to_ascii_lowercase();
        if lower_name == "set-cookie" {
            continue;
        }
        if let Ok(text) = val.to_str() {
            resp_headers.insert(lower_name, Value::String(text.to_string()));
        }
    }

    let mut data = Vec::new();
    let mut reader = response.into_body().into_reader().take((max + 1) as u64);
    reader.read_to_end(&mut data).map_err(|err| HttpError {
        code: "request_failed",
        message: err.to_string(),
    })?;
    if data.len() > max {
        return Err(HttpError::too_large(max));
    }

    let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(json!({
        "status": status,
        "url": final_url,
        "headers": Value::Object(resp_headers),
        "data": encoded,
        "byteLength": data.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_max_bytes_bounds() {
        assert_eq!(max_bytes(&json!({})).unwrap(), 20 * 1024 * 1024);
        assert_eq!(max_bytes(&json!({"maxBytes": 20 * 1024 * 1024})).unwrap(), 20 * 1024 * 1024);
        assert!(max_bytes(&json!({"maxBytes": 0})).is_err());
        assert!(max_bytes(&json!({"maxBytes": 33_554_433})).is_err());
    }
}
