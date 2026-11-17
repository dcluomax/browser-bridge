use bridge_core::{DEFAULT_GECKO_ID, NATIVE_HOST_NAME, data_directory};
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const ALL_BROWSERS: &[&str] = &["edge", "chrome", "chromium", "firefox"];

pub struct Registration {
    pub browser: String,
    pub manifest: Option<String>,
    pub exists: bool,
}

pub fn manifest_directory() -> PathBuf {
    data_directory().join("manifests")
}

pub fn chromium_manifest(host_path: &str, extension_ids: &[String]) -> Value {
    let origins: Vec<Value> = extension_ids
        .iter()
        .map(|id| Value::String(format!("chrome-extension://{id}/")))
        .collect();
    json!({
        "name": NATIVE_HOST_NAME,
        "description": "Browser Bridge native host for AI agents",
        "path": host_path,
        "type": "stdio",
        "allowed_origins": origins,
    })
}

pub fn firefox_manifest(host_path: &str, gecko_id: &str) -> Value {
    json!({
        "name": NATIVE_HOST_NAME,
        "description": "Browser Bridge native host for AI agents",
        "path": host_path,
        "type": "stdio",
        "allowed_extensions": [gecko_id],
    })
}

pub fn values(args: &[String], flag: &str) -> Vec<String> {
    let mut list = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == flag {
            if let Some(next) = args.get(i + 1) {
                list.push(next.clone());
                i += 2;
                continue;
            }
        } else if let Some(rest) = arg.strip_prefix(&format!("{flag}=")) {
            list.push(rest.to_string());
        }
        i += 1;
    }
    list
}

fn is_chromium_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'a'..=b'p'))
}

#[cfg(not(windows))]
fn unix_manifest_path(browser: &str) -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    #[cfg(target_os = "macos")]
    {
        let base = home.join("Library/Application Support");
        let sub = match browser {
            "edge" => "Microsoft Edge/NativeMessagingHosts",
            "chrome" => "Google/Chrome/NativeMessagingHosts",
            "chromium" => "Chromium/NativeMessagingHosts",
            "firefox" => "Mozilla/NativeMessagingHosts",
            _ => unreachable!(),
        };
        base.join(sub).join(format!("{NATIVE_HOST_NAME}.json"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        let dir = match browser {
            "edge" => config.join("microsoft-edge/NativeMessagingHosts"),
            "chrome" => config.join("google-chrome/NativeMessagingHosts"),
            "chromium" => config.join("chromium/NativeMessagingHosts"),
            "firefox" => home.join(".mozilla/native-messaging-hosts"),
            _ => unreachable!(),
        };
        dir.join(format!("{NATIVE_HOST_NAME}.json"))
    }
}

#[cfg(windows)]
fn registry_key(browser: &str) -> Option<String> {
    let sub = match browser {
        "edge" => "Microsoft\\Edge",
        "chrome" => "Google\\Chrome",
        "chromium" => "Chromium",
        "firefox" => "Mozilla",
        _ => return None,
    };
    Some(format!("Software\\{sub}\\NativeMessagingHosts\\{NATIVE_HOST_NAME}"))
}

pub fn registrations() -> Vec<Registration> {
    let mut results = Vec::new();
    for &browser in ALL_BROWSERS {
        #[cfg(windows)]
        {
            use winreg::enums::HKEY_CURRENT_USER;
            use winreg::RegKey;
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            let path = registry_key(browser)
                .and_then(|key| hkcu.open_subkey(key).ok())
                .and_then(|sub| sub.get_value::<String, _>("").ok());
            let exists = path.as_ref().is_some_and(|p| Path::new(p).is_file());
            results.push(Registration { browser: browser.to_string(), manifest: path, exists });
        }
        #[cfg(not(windows))]
        {
            let target = unix_manifest_path(browser);
            let exists = target.is_file();
            results.push(Registration {
                browser: browser.to_string(),
                manifest: exists.then(|| target.display().to_string()),
                exists,
            });
        }
    }
    results
}

pub fn install(args: &[String], output: &mut dyn Write) -> i32 {
    let chromium_ids: Vec<String> = values(args, "--chromium-id")
        .into_iter()
        .filter(|id| is_chromium_id(id))
        .collect();
    let gecko_id = values(args, "--gecko-id")
        .into_iter()
        .next()
        .unwrap_or_else(|| DEFAULT_GECKO_ID.to_string());
    let host_path = values(args, "--host-path").into_iter().next().unwrap_or_else(|| {
        std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "BrowserBridge".to_string())
    });
    let mut browsers: Vec<String> = values(args, "--browsers")
        .into_iter()
        .flat_map(|v| v.split(',').map(|s| s.trim().to_ascii_lowercase()).collect::<Vec<_>>())
        .filter(|s| !s.is_empty())
        .collect();
    if browsers.is_empty() {
        browsers = ALL_BROWSERS.iter().map(|s| (*s).to_string()).collect();
    }

    if chromium_ids.is_empty() && browsers.iter().any(|b| b != "firefox") {
        let _ = writeln!(output, "error: pass --chromium-id <32-char extension id> (see extension/bridge.config.json).");
        return 2;
    }

    let dir = manifest_directory();
    if let Err(err) = std::fs::create_dir_all(&dir) {
        let _ = writeln!(output, "error creating {}: {err}", dir.display());
        return 1;
    }
    let chromium_path = dir.join("chromium.json");
    let firefox_path = dir.join("firefox.json");
    let chromium_text = serde_json::to_string_pretty(&chromium_manifest(&host_path, &chromium_ids)).unwrap();
    let firefox_text = serde_json::to_string_pretty(&firefox_manifest(&host_path, &gecko_id)).unwrap();
    if let Err(err) = std::fs::write(&chromium_path, chromium_text).and_then(|_| std::fs::write(&firefox_path, firefox_text)) {
        let _ = writeln!(output, "error writing manifests: {err}");
        return 1;
    }
    let guide_path = bridge_core::ensure_agent_guide(Some(&host_path));
    let seeded_count = bridge_core::routines::seed_builtin_playbooks_to_disk();
    let _ = writeln!(output, "host:      {host_path}");
    let _ = writeln!(output, "manifests: {}", dir.display());
    let _ = writeln!(output, "guide:     {}", guide_path.display());
    let _ = writeln!(
        output,
        "routines:  {} ({seeded_count} timestamped JSON playbook(s) synced)",
        bridge_core::routines::routines_directory().display()
    );

    for browser in &browsers {
        if !ALL_BROWSERS.contains(&browser.as_str()) {
            let _ = writeln!(output, "error: unsupported browser '{browser}'");
            return 2;
        }
        let manifest = if browser == "firefox" { &firefox_path } else { &chromium_path };
        #[cfg(windows)]
        {
            use winreg::enums::HKEY_CURRENT_USER;
            use winreg::RegKey;
            let key_path = registry_key(browser).unwrap();
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            match hkcu.create_subkey(&key_path).and_then(|(sub, _)| sub.set_value("", &manifest.display().to_string())) {
                Ok(_) => {
                    let _ = writeln!(output, "registered {:<8} HKCU\\{}", browser, key_path);
                }
                Err(err) => {
                    let _ = writeln!(output, "error registering {browser}: {err}");
                    return 1;
                }
            }
        }
        #[cfg(not(windows))]
        {
            let target = unix_manifest_path(browser);
            if let Some(parent) = target.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match std::fs::copy(manifest, &target) {
                Ok(_) => {
                    let _ = writeln!(output, "registered {:<8} {}", browser, target.display());
                }
                Err(err) => {
                    let _ = writeln!(output, "error registering {browser}: {err}");
                    return 1;
                }
            }
        }
    }
    0
}

pub fn uninstall(output: &mut dyn Write) -> i32 {
    for &browser in ALL_BROWSERS {
        #[cfg(windows)]
        {
            use winreg::enums::HKEY_CURRENT_USER;
            use winreg::RegKey;
            if let Some(key) = registry_key(browser) {
                let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(key);
            }
        }
        #[cfg(not(windows))]
        {
            let _ = std::fs::remove_file(unix_manifest_path(browser));
        }
    }
    let _ = std::fs::remove_dir_all(manifest_directory());
    let _ = writeln!(output, "Uninstalled native messaging registrations.");
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_chromium_and_firefox_manifests() {
        let cm = chromium_manifest(r"C:\bb\BrowserBridge.exe", &["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()]);
        assert_eq!(cm["name"], "io.github.dcluomax.browser_bridge");
        assert_eq!(cm["allowed_origins"][0], "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/");
        let fm = firefox_manifest("/opt/bb/BrowserBridge", "browser-bridge@dcluomax.github.io");
        assert_eq!(fm["allowed_extensions"][0], "browser-bridge@dcluomax.github.io");
        assert!(fm.get("allowed_origins").is_none());
    }

    #[test]
    fn parses_repeated_and_inline_arguments() {
        let args: Vec<String> = ["--chromium-id", "a", "--chromium-id=b", "--browsers", "edge,firefox"]
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(values(&args, "--chromium-id"), vec!["a", "b"]);
        assert_eq!(values(&args, "--browsers"), vec!["edge,firefox"]);
    }
}
