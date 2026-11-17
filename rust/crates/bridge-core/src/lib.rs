pub mod client;
pub mod http;
pub mod native_messaging;
pub mod pipes;
pub mod routines;

pub const NATIVE_HOST_NAME: &str = "io.github.dcluomax.browser_bridge";
pub const DEFAULT_GECKO_ID: &str = "browser-bridge@dcluomax.github.io";
pub const PROTOCOL_VERSION: i64 = 1;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const AGENT_GUIDE_TEMPLATE: &str = include_str!("../../../../docs/AGENT.md");

pub fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input.trim())
        .map_err(|e| format!("Invalid base64 image payload: {e}"))
}

pub fn encode_base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn data_directory() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            return std::path::PathBuf::from(local).join("BrowserBridge");
        }
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        return std::path::PathBuf::from(home).join(".browser-bridge");
    }
    std::env::temp_dir().join("browser-bridge")
}

pub fn agent_guide_path() -> std::path::PathBuf {
    data_directory().join("AGENT.md")
}

pub fn default_host_executable() -> std::path::PathBuf {
    let name = if cfg!(windows) { "BrowserBridge.exe" } else { "BrowserBridge" };
    data_directory().join("app").join(name)
}

fn resolve_host_executable(explicit: Option<&str>) -> String {
    if let Some(h) = explicit.filter(|s| !s.trim().is_empty()) {
        return h.to_string();
    }
    if let Ok(cur) = std::env::current_exe() {
        let is_host = cur
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|stem| stem.eq_ignore_ascii_case("BrowserBridge"));
        if is_host {
            return cur.display().to_string();
        }
    }
    default_host_executable().display().to_string()
}

pub fn render_agent_guide(host_exe: Option<&str>) -> String {
    let exe_str = resolve_host_executable(host_exe);
    AGENT_GUIDE_TEMPLATE.replace("{{HOST_EXE}}", &exe_str)
}

pub fn ensure_agent_guide(host_exe: Option<&str>) -> std::path::PathBuf {
    let path = agent_guide_path();
    let rendered = render_agent_guide(host_exe);
    let unchanged = std::fs::read_to_string(&path).ok().as_deref() == Some(rendered.as_str());
    if !unchanged {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, rendered);
    }
    path
}

pub fn default_downloads_dir() -> std::path::PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|h| std::path::PathBuf::from(h).join("Downloads"))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

pub fn unique_screenshot_path(dir: &std::path::Path, title: &str, mode: &str) -> std::path::PathBuf {
    let sanitized: String = title
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 32 {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .trim_end_matches([' ', '.'])
        .chars()
        .take(80)
        .collect();
    let stem = if sanitized.is_empty() { "screenshot" } else { &sanitized };
    let first = dir.join(format!("{stem} - {mode}.png"));
    if !first.exists() {
        return first;
    }
    for idx in 2..=9999 {
        let candidate = dir.join(format!("{stem} - {mode} ({idx}).png"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem} - {mode}-{}.png", std::process::id()))
}

pub fn save_screenshot_to_downloads(title: &str, full_page: bool, base64_data: &str) -> Result<std::path::PathBuf, String> {
    let bytes = decode_base64(base64_data)?;
    let downloads = default_downloads_dir();
    std::fs::create_dir_all(&downloads)
        .map_err(|e| format!("Could not access Downloads directory {}: {e}", downloads.display()))?;
    let mode = if full_page { "fullpage" } else { "viewport" };
    let out_path = unique_screenshot_path(&downloads, title, mode);
    std::fs::write(&out_path, &bytes)
        .map_err(|e| format!("Could not write screenshot {}: {e}", out_path.display()))?;
    Ok(out_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_guide_never_substitutes_non_host_binary() {
        // Inside `cargo test`, current_exe() is `bridge_core-<hash>.exe` (not BrowserBridge.exe),
        // mimicking an external caller invoking ensure_agent_guide(None).
        let rendered = render_agent_guide(None);
        assert!(rendered.contains("BrowserBridge"), "rendered guide was:\n{rendered}");
        assert!(!rendered.contains("bridge_core"));
    }
}
