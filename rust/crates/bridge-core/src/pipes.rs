#[cfg(unix)]
use std::path::PathBuf;

pub const PREFIX: &str = "browser-bridge";
pub const BROWSERS: &[&str] = &["edge", "chrome", "chromium", "firefox", "unknown"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeEndpoint {
    pub pipe_name: String,
    pub browser: String,
    pub instance_id: String,
}

pub fn sanitize(value: &str) -> String {
    let clean: String = value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    if clean.is_empty() {
        "user".to_string()
    } else {
        clean
    }
}

pub fn normalize_browser(browser: Option<&str>) -> &'static str {
    let value = browser.unwrap_or("").trim().to_ascii_lowercase();
    BROWSERS.iter().copied().find(|&b| b == value).unwrap_or("unknown")
}

pub fn is_valid_instance(instance_id: &str) -> bool {
    instance_id.len() == 12 && instance_id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn build(user_key: &str, browser: &str, instance_id: &str) -> Result<String, String> {
    if !is_valid_instance(instance_id) {
        return Err("Instance id must be 12 lowercase hex characters.".to_string());
    }
    Ok(format!("{PREFIX}.{}.{}.{}", sanitize(user_key), normalize_browser(Some(browser)), instance_id))
}

pub fn parse(pipe_name: &str, user_key: &str) -> Option<BridgeEndpoint> {
    let mut parts = pipe_name.split('.');
    let p0 = parts.next()?;
    let p1 = parts.next()?;
    let p2 = parts.next()?;
    let p3 = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if p0 != PREFIX || p1 != sanitize(user_key) {
        return None;
    }
    if !BROWSERS.contains(&p2) || !is_valid_instance(p3) {
        return None;
    }
    Some(BridgeEndpoint {
        pipe_name: pipe_name.to_string(),
        browser: p2.to_string(),
        instance_id: p3.to_string(),
    })
}

pub fn current_user_key() -> String {
    #[cfg(windows)]
    {
        if let Some(sid) = windows_current_sid() {
            return sid;
        }
        if let Ok(user) = std::env::var("USERNAME") {
            return sanitize(&user);
        }
    }
    #[cfg(unix)]
    {
        if let Ok(user) = std::env::var("USER") {
            return sanitize(&user);
        }
    }
    "user".to_string()
}

pub fn enumerate(user_key: &str) -> Vec<BridgeEndpoint> {
    let mut results = Vec::new();
    for name in list_pipe_names() {
        if let Some(endpoint) = parse(&name, user_key) {
            if !results.iter().any(|r: &BridgeEndpoint| r.pipe_name == endpoint.pipe_name) {
                results.push(endpoint);
            }
        }
    }
    results
}

#[cfg(unix)]
pub fn unix_socket_dir() -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_RUNTIME_DIR") {
        let p = PathBuf::from(xdg);
        if p.is_dir() {
            return p.join("browser-bridge");
        }
    }
    let uid = unsafe { libc::geteuid() };
    std::env::temp_dir().join(format!("bb-{uid}"))
}

#[cfg(unix)]
pub fn unix_socket_path(pipe_name: &str) -> PathBuf {
    unix_socket_dir().join(pipe_name)
}

#[cfg(windows)]
pub fn windows_pipe_path(pipe_name: &str) -> String {
    format!(r"\\.\pipe\{pipe_name}")
}

fn list_pipe_names() -> Vec<String> {
    #[cfg(windows)]
    {
        let Ok(entries) = std::fs::read_dir(r"\\.\pipe\") else {
            return Vec::new();
        };
        entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|name| name.starts_with(PREFIX))
            .collect()
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let dir = unix_socket_dir();
        let Ok(meta) = std::fs::symlink_metadata(&dir) else {
            return Vec::new();
        };
        if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || (meta.mode() & 0o077) != 0 {
            return Vec::new();
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|name| name.starts_with(PREFIX))
            .collect()
    }
}

#[cfg(windows)]
fn windows_current_sid() -> Option<String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut len: u32 = 0;
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut len);
        if len == 0 {
            CloseHandle(token);
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len);
        CloseHandle(token);
        if ok == 0 {
            return None;
        }
        let user = &*(buf.as_ptr().cast::<TOKEN_USER>());
        let mut sid_ptr = null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid_ptr) == 0 || sid_ptr.is_null() {
            return None;
        }
        let mut wide_len = 0usize;
        while *sid_ptr.add(wide_len) != 0 {
            wide_len += 1;
        }
        let slice = std::slice::from_raw_parts(sid_ptr, wide_len);
        let sid = String::from_utf16_lossy(slice);
        LocalFree(sid_ptr.cast());
        Some(sid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_and_parses_names() {
        let name = build("S-1-5-21-1", "edge", "0123456789ab").unwrap();
        assert_eq!(name, "browser-bridge.S-1-5-21-1.edge.0123456789ab");
        assert_eq!(
            parse(&name, "S-1-5-21-1"),
            Some(BridgeEndpoint {
                pipe_name: name,
                browser: "edge".to_string(),
                instance_id: "0123456789ab".to_string(),
            })
        );
    }

    #[test]
    fn rejects_foreign_or_malformed_names() {
        for bad in [
            "browser-bridge.other-user.edge.0123456789ab",
            "browser-bridge.S-1-5-21-1.safari.0123456789ab",
            "browser-bridge.S-1-5-21-1.edge.XYZ",
            "something-else",
        ] {
            assert_eq!(parse(bad, "S-1-5-21-1"), None);
        }
        assert!(build("user", "edge", "../../evil").is_err());
        assert_eq!(sanitize("user.name"), "user-name");
    }
}
