use crate::client::{BridgeClient, BridgeError};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const DEFAULT_MAX_DOWNLOAD_BYTES: usize = 200 * 1024 * 1024;
pub const HARD_MAX_DOWNLOAD_BYTES: usize = 512 * 1024 * 1024;
const SINGLE_FETCH_CHUNK_CAP: usize = 32 * 1024 * 1024;
const MAX_HLS_SEGMENTS: usize = 1_200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsVariant {
    pub url: String,
    pub bandwidth: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub codecs: Option<String>,
    pub audio_group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsMediaPlaylist {
    pub init_map_url: Option<String>,
    pub segments: Vec<String>,
    pub duration_seconds: f64,
    pub ended: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ParsedM3u8 {
    Master {
        variants: Vec<HlsVariant>,
        audio_tracks: Vec<(String, String, bool)>, // (group_id, resolved_url, is_default)
    },
    Media(HlsMediaPlaylist),
}

/// Resolves a relative, root-relative, or absolute URI against an HTTP(S) base URL without external crates.
pub fn resolve_relative_url(base_url: &str, reference: &str) -> Result<String, String> {
    let ref_trimmed = reference.trim();
    if ref_trimmed.is_empty() {
        return Err("Empty URI in media manifest. [protocol_error]".to_string());
    }
    if ref_trimmed.starts_with("http://") || ref_trimmed.starts_with("https://") {
        return Ok(ref_trimmed.to_string());
    }
    let base_trimmed = base_url.trim();
    let Some((scheme, rest)) = base_trimmed.split_once("://") else {
        return Err(format!("Base URL '{base_url}' is missing scheme. [bad_request]"));
    };
    if ref_trimmed.starts_with("//") {
        return Ok(format!("{scheme}:{ref_trimmed}"));
    }
    let before_qh = rest.split(['?', '#']).next().unwrap_or(rest);
    let (authority, base_path) = match before_qh.split_once('/') {
        Some((a, p)) => (a, format!("/{p}")),
        None => (before_qh, "/".to_string()),
    };
    if authority.is_empty() {
        return Err(format!("Base URL '{base_url}' has empty host. [bad_request]"));
    }
    if ref_trimmed.starts_with('/') {
        return Ok(format!("{scheme}://{authority}{ref_trimmed}"));
    }
    let base_dir = match base_path.rfind('/') {
        Some(idx) => &base_path[..=idx],
        None => "/",
    };
    let (ref_path, ref_tail) = match ref_trimmed.find(['?', '#']) {
        Some(idx) => (&ref_trimmed[..idx], &ref_trimmed[idx..]),
        None => (ref_trimmed, ""),
    };
    let combined = format!("{base_dir}{ref_path}");
    let mut stack: Vec<&str> = Vec::new();
    for seg in combined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    let trailing_slash = ref_path.ends_with('/') && !stack.is_empty();
    let normalized = if stack.is_empty() {
        "/".to_string()
    } else if trailing_slash {
        format!("/{}/", stack.join("/"))
    } else {
        format!("/{}", stack.join("/"))
    };
    Ok(format!("{scheme}://{authority}{normalized}{ref_tail}"))
}

fn parse_tag_attributes(attr_list: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let bytes = attr_list.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i] == b',' || bytes[i].is_ascii_whitespace()) {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let key_start = i;
        while i < bytes.len() && bytes[i] != b'=' && bytes[i] != b',' {
            i += 1;
        }
        let key = attr_list[key_start..i].trim().to_ascii_uppercase();
        if i >= bytes.len() || bytes[i] != b'=' {
            continue;
        }
        i += 1; // skip '='
        let val = if i < bytes.len() && bytes[i] == b'"' {
            i += 1;
            let v_start = i;
            while i < bytes.len() && bytes[i] != b'"' {
                i += 1;
            }
            let s = attr_list[v_start..i].to_string();
            if i < bytes.len() && bytes[i] == b'"' {
                i += 1;
            }
            s
        } else {
            let v_start = i;
            while i < bytes.len() && bytes[i] != b',' {
                i += 1;
            }
            attr_list[v_start..i].trim().to_string()
        };
        if !key.is_empty() {
            out.push((key, val));
        }
    }
    out
}

pub fn parse_m3u8_playlist(text: &str, base_url: &str) -> Result<ParsedM3u8, String> {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if !trimmed.starts_with("#EXTM3U") {
        return Err("Payload is not a valid #EXTM3U playlist. [protocol_error]".to_string());
    }

    let mut variants: Vec<HlsVariant> = Vec::new();
    let mut audio_tracks: Vec<(String, String, bool)> = Vec::new();
    let mut pending_stream_inf: Option<(u64, Option<(u32, u32)>, Option<String>, Option<String>)> = None;

    let mut init_map_url: Option<String> = None;
    let mut segments: Vec<String> = Vec::new();
    let mut saw_extinf = false;
    let mut pending_segment = false;
    let mut total_duration = 0.0f64;
    let mut ended = false;

    for raw_line in trimmed.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-KEY:") {
            let attrs = parse_tag_attributes(rest);
            let method = attrs
                .iter()
                .find(|(k, _)| k == "METHOD")
                .map(|(_, v)| v.to_ascii_uppercase())
                .unwrap_or_default();
            if !method.is_empty() && method != "NONE" {
                return Err(format!(
                    "HLS stream is encrypted (#EXT-X-KEY METHOD={method}) and cannot be downloaded. [drm_protected]"
                ));
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-SESSION-KEY:") {
            let attrs = parse_tag_attributes(rest);
            let method = attrs
                .iter()
                .find(|(k, _)| k == "METHOD")
                .map(|(_, v)| v.to_ascii_uppercase())
                .unwrap_or_default();
            if !method.is_empty() && method != "NONE" {
                return Err(format!(
                    "HLS stream is DRM-protected (#EXT-X-SESSION-KEY METHOD={method}). [drm_protected]"
                ));
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA:") {
            let attrs = parse_tag_attributes(rest);
            let kind = attrs
                .iter()
                .find(|(k, _)| k == "TYPE")
                .map(|(_, v)| v.to_ascii_uppercase())
                .unwrap_or_default();
            if kind == "AUDIO" {
                let group = attrs
                    .iter()
                    .find(|(k, _)| k == "GROUP-ID")
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default();
                let uri = attrs.iter().find(|(k, _)| k == "URI").map(|(_, v)| v.as_str());
                let is_def = attrs
                    .iter()
                    .find(|(k, _)| k == "DEFAULT")
                    .is_some_and(|(_, v)| v.eq_ignore_ascii_case("YES"));
                if let Some(u) = uri.filter(|s| !s.is_empty()) {
                    if let Ok(resolved) = resolve_relative_url(base_url, u) {
                        audio_tracks.push((group, resolved, is_def));
                    }
                }
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let attrs = parse_tag_attributes(rest);
            let avg_bw = attrs
                .iter()
                .find(|(k, _)| k == "AVERAGE-BANDWIDTH")
                .and_then(|(_, v)| v.parse::<u64>().ok());
            let max_bw = attrs
                .iter()
                .find(|(k, _)| k == "BANDWIDTH")
                .and_then(|(_, v)| v.parse::<u64>().ok());
            let bw = max_bw.or(avg_bw).unwrap_or(0);
            let res = attrs
                .iter()
                .find(|(k, _)| k == "RESOLUTION")
                .and_then(|(_, v)| {
                    let (w, h) = v.split_once('x').or_else(|| v.split_once('X'))?;
                    Some((w.trim().parse::<u32>().ok()?, h.trim().parse::<u32>().ok()?))
                });
            let codecs = attrs
                .iter()
                .find(|(k, _)| k == "CODECS")
                .map(|(_, v)| v.clone());
            let audio_grp = attrs
                .iter()
                .find(|(k, _)| k == "AUDIO")
                .map(|(_, v)| v.clone());
            pending_stream_inf = Some((bw, res, codecs, audio_grp));
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
            let attrs = parse_tag_attributes(rest);
            if let Some((_, u)) = attrs.iter().find(|(k, _)| k == "URI") {
                init_map_url = Some(resolve_relative_url(base_url, u)?);
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            saw_extinf = true;
            pending_segment = true;
            let dur_str = rest.split(',').next().unwrap_or("").trim();
            if let Ok(d) = dur_str.parse::<f64>() {
                if d.is_finite() && d > 0.0 {
                    total_duration += d;
                }
            }
            continue;
        }
        if line == "#EXT-X-ENDLIST" {
            ended = true;
            continue;
        }
        if line.starts_with('#') {
            continue;
        }

        // URI line
        if let Some((bw, res, codecs, audio_group)) = pending_stream_inf.take() {
            let resolved = resolve_relative_url(base_url, line)?;
            variants.push(HlsVariant {
                url: resolved,
                bandwidth: bw,
                width: res.map(|(w, _)| w),
                height: res.map(|(_, h)| h),
                codecs,
                audio_group,
            });
        } else if pending_segment || saw_extinf {
            pending_segment = false;
            if segments.len() >= MAX_HLS_SEGMENTS {
                return Err(format!(
                    "HLS media playlist exceeds maximum segment limit ({MAX_HLS_SEGMENTS}). [body_too_large]"
                ));
            }
            segments.push(resolve_relative_url(base_url, line)?);
        }
    }

    if !variants.is_empty() {
        return Ok(ParsedM3u8::Master {
            variants,
            audio_tracks,
        });
    }
    if segments.is_empty() {
        return Err("HLS playlist contained neither variants nor media segments. [protocol_error]".to_string());
    }
    Ok(ParsedM3u8::Media(HlsMediaPlaylist {
        init_map_url,
        segments,
        duration_seconds: (total_duration * 100.0).round() / 100.0,
        ended,
    }))
}

pub fn select_hls_variant<'a>(variants: &'a [HlsVariant], prefer_quality: &str) -> Option<&'a HlsVariant> {
    if variants.is_empty() {
        return None;
    }
    let key_of = |v: &HlsVariant| -> (u64, u64) {
        let pixels = u64::from(v.width.unwrap_or(0)).saturating_mul(u64::from(v.height.unwrap_or(0)));
        (pixels, v.bandwidth)
    };
    if prefer_quality.eq_ignore_ascii_case("lowest") {
        variants.iter().min_by_key(|v| key_of(v))
    } else {
        variants.iter().max_by_key(|v| key_of(v))
    }
}

pub fn is_valid_mp4_header(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && (&bytes[4..8] == b"ftyp" || &bytes[4..8] == b"styp" || &bytes[4..8] == b"moof")
}

fn infer_extension(url: &str, content_type: &str, default_ext: &str) -> &'static str {
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("video/webm") {
        return "webm";
    }
    if ct.contains("video/quicktime") {
        return "mov";
    }
    if ct.contains("video/mp2t") {
        return "ts";
    }
    if ct.contains("video/mp4") {
        return "mp4";
    }
    if ct.contains("audio/mp4") || ct.contains("audio/x-m4a") {
        return "m4a";
    }
    if ct.contains("audio/mpeg") {
        return "mp3";
    }
    if ct.contains("audio/ogg") {
        return "ogg";
    }
    if ct.contains("application/pdf") {
        return "pdf";
    }
    if ct.contains("image/png") {
        return "png";
    }
    if ct.contains("image/jpeg") {
        return "jpg";
    }
    let path_part = url.split(['?', '#']).next().unwrap_or(url).to_ascii_lowercase();
    for ext in ["mp4", "webm", "mov", "m4v", "mkv", "ts", "m4a", "mp3", "aac", "ogg", "opus", "pdf", "zip", "png", "jpg"] {
        if path_part.ends_with(&format!(".{ext}")) {
            return ext;
        }
    }
    match default_ext {
        "ts" => "ts",
        "webm" => "webm",
        "m4a" => "m4a",
        "mp3" => "mp3",
        _ => "mp4",
    }
}

fn sanitize_stem(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 32 {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches([' ', '.', '_'])
        .chars()
        .take(72)
        .collect();
    if cleaned.is_empty() {
        "media".to_string()
    } else {
        cleaned
    }
}

fn resolve_output_file_path(
    requested_path: Option<&str>,
    fallback_stem: &str,
    ext: &str,
) -> Result<PathBuf, String> {
    if let Some(raw) = requested_path.map(str::trim).filter(|s| !s.is_empty()) {
        let candidate = PathBuf::from(raw);
        let treat_as_dir = candidate.is_dir() || raw.ends_with('/') || raw.ends_with('\\');
        if !treat_as_dir {
            if let Some(parent) = candidate.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Could not create directory {}: {e} [io_error]", parent.display()))?;
                }
            }
            return Ok(candidate);
        }
        std::fs::create_dir_all(&candidate)
            .map_err(|e| format!("Could not create directory {}: {e} [io_error]", candidate.display()))?;
        return Ok(unique_media_path(&candidate, fallback_stem, ext));
    }

    let dir = crate::default_downloads_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not access Downloads directory {}: {e} [io_error]", dir.display()))?;
    Ok(unique_media_path(&dir, fallback_stem, ext))
}

fn unique_media_path(dir: &Path, stem_raw: &str, ext: &str) -> PathBuf {
    let stem = sanitize_stem(stem_raw);
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    for idx in 2..=9999 {
        let cand = dir.join(format!("{stem} ({idx}).{ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    dir.join(format!("{stem}-{}.{ext}", std::process::id()))
}

fn try_remux_with_ffmpeg(video_path: &Path, audio_path: &Path, output_path: &Path) -> bool {
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(["-y", "-loglevel", "error", "-i"])
        .arg(video_path)
        .arg("-i")
        .arg(audio_path)
        .args(["-c", "copy", "-movflags", "+faststart"])
        .arg(output_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.status().is_ok_and(|st| st.success() && output_path.is_file())
}

pub struct DownloadOptions<'a> {
    pub url: Option<&'a str>,
    pub output_path: Option<&'a str>,
    pub tab_id: Option<i64>,
    pub frame_id: Option<i64>,
    pub browser: Option<&'a str>,
    pub prefer_quality: &'a str,
    pub max_bytes: usize,
}

#[derive(Debug, Clone)]
struct FetchedPayload {
    final_url: String,
    content_type: String,
    bytes: Vec<u8>,
}

async fn fetch_via_caller<F, Fut>(
    caller: &mut F,
    tab_id: Option<i64>,
    frame_id: Option<i64>,
    url: &str,
    max_bytes: usize,
) -> Result<FetchedPayload, String>
where
    F: FnMut(String, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, BridgeError>>,
{
    let per_req_max = max_bytes.clamp(1024, SINGLE_FETCH_CHUNK_CAP);
    let mut p = Map::new();
    if let Some(tid) = tab_id {
        p.insert("tabId".into(), json!(tid));
    }
    if let Some(fid) = frame_id.filter(|f| *f > 0) {
        p.insert("frameId".into(), json!(fid));
    }
    p.insert("url".into(), json!(url));
    p.insert("method".into(), json!("GET"));
    p.insert("credentials".into(), json!("auto"));
    p.insert("maxBytes".into(), json!(per_req_max));
    p.insert("timeoutMs".into(), json!(45_000));
    p.insert("_noLearn".into(), json!(true));

    let res = caller("page.fetch".to_string(), Value::Object(p))
        .await
        .map_err(|e| e.to_string())?;
    let status = res
        .get("status")
        .and_then(Value::as_u64)
        .and_then(|n| u16::try_from(n).ok())
        .unwrap_or(0);
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status} fetching {url}. [request_failed]"));
    }
    let b64 = res
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing base64 data in page.fetch response. [protocol_error]".to_string())?;
    let bytes = crate::decode_base64(b64)?;
    let content_type = res
        .get("headers")
        .and_then(Value::as_object)
        .and_then(|h| {
            h.iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
                .and_then(|(_, v)| v.as_str())
        })
        .unwrap_or("")
        .to_string();
    let final_url = res
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or(url)
        .to_string();
    Ok(FetchedPayload {
        final_url,
        content_type,
        bytes,
    })
}

async fn download_hls_media_stream_to_file<F, Fut>(
    caller: &mut F,
    tab_id: Option<i64>,
    frame_id: Option<i64>,
    playlist: &HlsMediaPlaylist,
    dest_file: &Path,
    remaining_budget: &mut usize,
) -> Result<(usize, usize), String>
where
    F: FnMut(String, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, BridgeError>>,
{
    let tmp_path = dest_file.with_extension(format!("part.{}", std::process::id()));
    let mut out_file = std::fs::File::create(&tmp_path)
        .map_err(|e| format!("Could not create {}: {e} [io_error]", tmp_path.display()))?;

    let mut total_written = 0usize;
    let mut segments_count = 0usize;

    let write_chunk = |file: &mut std::fs::File, data: &[u8], budget: &mut usize, acc: &mut usize| -> Result<(), String> {
        if data.len() > *budget {
            return Err("Downloaded stream exceeds maxBytes limit. [body_too_large]".to_string());
        }
        *budget -= data.len();
        *acc += data.len();
        file.write_all(data)
            .map_err(|e| format!("Disk write error: {e} [io_error]"))
    };

    let result: Result<(), String> = async {
        if let Some(ref init_url) = playlist.init_map_url {
            let init_resp = fetch_via_caller(caller, tab_id, frame_id, init_url, *remaining_budget).await?;
            write_chunk(&mut out_file, &init_resp.bytes, remaining_budget, &mut total_written)?;
        }
        for seg_url in &playlist.segments {
            let seg_resp = fetch_via_caller(caller, tab_id, frame_id, seg_url, *remaining_budget).await?;
            write_chunk(&mut out_file, &seg_resp.bytes, remaining_budget, &mut total_written)?;
            segments_count += 1;
        }
        out_file
            .flush()
            .map_err(|e| format!("Disk flush error: {e} [io_error]"))?;
        Ok(())
    }
    .await;

    drop(out_file);
    if let Err(err) = result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(err);
    }

    if std::fs::rename(&tmp_path, dest_file).is_err() {
        #[cfg(windows)]
        {
            let _ = std::fs::remove_file(dest_file);
        }
        if let Err(e) = std::fs::rename(&tmp_path, dest_file) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("Could not finalize output file {}: {e} [io_error]", dest_file.display()));
        }
    }
    Ok((total_written, segments_count))
}

pub async fn download_media(client: &BridgeClient, opts: DownloadOptions<'_>) -> Result<Value, String> {
    let browser = opts.browser;
    download_media_with_caller(opts, |method, params| async move {
        let timeout = if method == "page.media" {
            Duration::from_secs(15)
        } else {
            Duration::from_secs(60)
        };
        client.send(&method, params, browser, timeout).await.map(|(r, _)| r)
    })
    .await
}

pub(crate) async fn download_media_with_caller<F, Fut>(
    opts: DownloadOptions<'_>,
    mut caller: F,
) -> Result<Value, String>
where
    F: FnMut(String, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, BridgeError>>,
{
    let started = Instant::now();
    let max_bytes = opts.max_bytes.clamp(64 * 1024, HARD_MAX_DOWNLOAD_BYTES);
    let mut active_tab = opts.tab_id;
    let mut page_title = String::new();
    let mut candidate_urls: Vec<(String, Option<i64>, Option<u32>, Option<u32>)> = Vec::new();

    if let Some(explicit_url) = opts.url.map(str::trim).filter(|s| !s.is_empty()) {
        candidate_urls.push((explicit_url.to_string(), opts.frame_id, None, None));
        if active_tab.is_none() {
            if let Ok(info) = caller("page.info".to_string(), json!({})).await {
                active_tab = info.get("tabId").and_then(Value::as_i64);
                page_title = info
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
            }
        }
    } else {
        let mut mp = Map::new();
        if let Some(tid) = active_tab {
            mp.insert("tabId".into(), json!(tid));
        }
        mp.insert("scrollIntoView".into(), json!(true));
        let report = caller("page.media".to_string(), Value::Object(mp))
            .await
            .map_err(|e| e.to_string())?;
        if active_tab.is_none() {
            active_tab = report.get("tabId").and_then(Value::as_i64);
        }
        page_title = report
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let drm_detected = report
            .get("drmDetected")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut raw_cands = report
            .get("candidates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if opts.prefer_quality.eq_ignore_ascii_case("lowest") && raw_cands.len() > 1 {
            // Keep HTTP streams ahead of blob:, but prefer smaller resolution within same kind
            raw_cands.reverse();
        }
        for c in &raw_cands {
            let kind = c.get("kind").and_then(Value::as_str).unwrap_or("");
            if kind == "dash" {
                continue; // Prefer progressive or HLS; DASH unsupported without external MPD parser
            }
            if let Some(u) = c.get("url").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                let fid = c.get("frameId").and_then(Value::as_i64);
                let w = c.get("width").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
                let h = c.get("height").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
                candidate_urls.push((u.to_string(), fid, w, h));
            }
        }
        if candidate_urls.is_empty() {
            if drm_detected {
                return Err(
                    "Media on this page uses encrypted EME/DRM (MediaKeys) and cannot be downloaded. [drm_protected]"
                        .to_string(),
                );
            }
            return Err(
                "No downloadable video or audio stream was found on this tab. Ensure the media post/player is visible and loaded. [not_found]"
                    .to_string(),
            );
        }
    }

    let mut last_err = String::new();

    for (cand_url, cand_frame, cand_w, cand_h) in candidate_urls {
        let mut budget = max_bytes;
        let first = match fetch_via_caller(&mut caller, active_tab, cand_frame, &cand_url, budget).await {
            Ok(f) => f,
            Err(e) => {
                if e.contains("[drm_protected]") {
                    return Err(e);
                }
                last_err = e;
                continue;
            }
        };

        let looks_m3u8 = first.content_type.to_ascii_lowercase().contains("mpegurl")
            || first.final_url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase().ends_with(".m3u8")
            || first.bytes.starts_with(b"#EXTM3U");

        if !looks_m3u8 {
            if first.bytes.len() > budget {
                return Err("Downloaded payload exceeds maxBytes limit. [body_too_large]".to_string());
            }
            let ext = infer_extension(&first.final_url, &first.content_type, "mp4");
            let fallback_stem = if !page_title.trim().is_empty() {
                page_title.clone()
            } else {
                first
                    .final_url
                    .split(['?', '#'])
                    .next()
                    .and_then(|p| p.rsplit('/').find(|s| !s.is_empty()))
                    .and_then(|s| s.split('.').next())
                    .unwrap_or("video")
                    .to_string()
            };
            let out_path = resolve_output_file_path(opts.output_path, &fallback_stem, ext)?;
            let tmp = out_path.with_extension(format!("part.{}", std::process::id()));
            std::fs::write(&tmp, &first.bytes)
                .map_err(|e| format!("Could not write {}: {e} [io_error]", tmp.display()))?;
            if std::fs::rename(&tmp, &out_path).is_err() {
                #[cfg(windows)]
                {
                    let _ = std::fs::remove_file(&out_path);
                }
                std::fs::rename(&tmp, &out_path).map_err(|e| {
                    let _ = std::fs::remove_file(&tmp);
                    format!("Could not finalize {}: {e} [io_error]", out_path.display())
                })?;
            }
            let valid_mp4 = ext == "mp4" && is_valid_mp4_header(&first.bytes);
            return Ok(json!({
                "tabId": active_tab,
                "path": out_path.display().to_string(),
                "bytes": first.bytes.len(),
                "delivery": "progressive",
                "container": ext,
                "mimeType": if first.content_type.is_empty() { format!("video/{ext}") } else { first.content_type },
                "sourceUrl": first.final_url,
                "width": cand_w,
                "height": cand_h,
                "validMp4Header": if ext == "mp4" { Value::Bool(valid_mp4) } else { Value::Null },
                "elapsedMs": started.elapsed().as_millis() as u64,
            }));
        }

        // HLS .m3u8 workflow (Master -> Variant -> fMP4 EXT-X-MAP + segments / TS segments)
        let manifest_text = String::from_utf8_lossy(&first.bytes).to_string();
        let parsed = match parse_m3u8_playlist(&manifest_text, &first.final_url) {
            Ok(p) => p,
            Err(e) => {
                if e.contains("[drm_protected]") {
                    return Err(e);
                }
                last_err = e;
                continue;
            }
        };

        let (media_pl, chosen_variant, companion_audio_pl_url) = match parsed {
            ParsedM3u8::Media(pl) => (pl, None, None),
            ParsedM3u8::Master {
                variants,
                audio_tracks,
            } => {
                let Some(chosen) = select_hls_variant(&variants, opts.prefer_quality).cloned() else {
                    last_err = "Master HLS playlist had no selectable variants. [protocol_error]".to_string();
                    continue;
                };
                let audio_url = chosen.audio_group.as_ref().and_then(|grp| {
                    audio_tracks
                        .iter()
                        .filter(|(g, _, _)| g == grp)
                        .max_by_key(|(_, _, is_def)| u8::from(*is_def))
                        .map(|(_, u, _)| u.clone())
                });
                let v_payload = match fetch_via_caller(&mut caller, active_tab, cand_frame, &chosen.url, budget).await {
                    Ok(vp) => vp,
                    Err(e) => {
                        last_err = e;
                        continue;
                    }
                };
                let v_text = String::from_utf8_lossy(&v_payload.bytes).to_string();
                match parse_m3u8_playlist(&v_text, &v_payload.final_url) {
                    Ok(ParsedM3u8::Media(mpl)) => (mpl, Some(chosen), audio_url),
                    Ok(ParsedM3u8::Master { .. }) => {
                        last_err = "Nested master HLS playlists are not supported. [protocol_error]".to_string();
                        continue;
                    }
                    Err(e) => {
                        if e.contains("[drm_protected]") {
                            return Err(e);
                        }
                        last_err = e;
                        continue;
                    }
                }
            }
        };

        let is_fmp4 = media_pl.init_map_url.is_some()
            || media_pl
                .segments
                .first()
                .is_some_and(|s| s.split(['?', '#']).next().unwrap_or("").ends_with(".m4s"));
        let ext = if is_fmp4 { "mp4" } else { "ts" };
        let fallback_stem = if !page_title.trim().is_empty() {
            page_title.clone()
        } else {
            "stream_video".to_string()
        };
        let out_path = resolve_output_file_path(opts.output_path, &fallback_stem, ext)?;

        let (mut video_bytes, video_segments) = match download_hls_media_stream_to_file(
            &mut caller,
            active_tab,
            cand_frame,
            &media_pl,
            &out_path,
            &mut budget,
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                last_err = e;
                continue;
            }
        };

        let mut separate_audio_saved: Option<String> = None;
        let mut muxed_with_ffmpeg = false;

        if let Some(audio_m3u8_url) = companion_audio_pl_url {
            if let Ok(a_payload) = fetch_via_caller(&mut caller, active_tab, cand_frame, &audio_m3u8_url, budget).await {
                let a_txt = String::from_utf8_lossy(&a_payload.bytes).to_string();
                if let Ok(ParsedM3u8::Media(a_pl)) = parse_m3u8_playlist(&a_txt, &a_payload.final_url) {
                    let audio_file = out_path.with_extension("audio.m4a");
                    if download_hls_media_stream_to_file(
                        &mut caller,
                        active_tab,
                        cand_frame,
                        &a_pl,
                        &audio_file,
                        &mut budget,
                    )
                    .await
                    .is_ok()
                    {
                        let muxed_tmp = out_path.with_extension(format!("muxed.{}.{ext}", std::process::id()));
                        if try_remux_with_ffmpeg(&out_path, &audio_file, &muxed_tmp) {
                            let _ = std::fs::remove_file(&audio_file);
                            #[cfg(windows)]
                            {
                                let _ = std::fs::remove_file(&out_path);
                            }
                            if std::fs::rename(&muxed_tmp, &out_path).is_ok() {
                                muxed_with_ffmpeg = true;
                                if let Ok(meta) = std::fs::metadata(&out_path) {
                                    video_bytes = meta.len() as usize;
                                }
                            } else {
                                let _ = std::fs::remove_file(&muxed_tmp);
                            }
                        } else {
                            separate_audio_saved = Some(audio_file.display().to_string());
                        }
                    }
                }
            }
        }

        let header_check = std::fs::File::open(&out_path)
            .ok()
            .and_then(|mut f| {
                use std::io::Read;
                let mut buf = [0u8; 16];
                let n = f.read(&mut buf).ok()?;
                Some(is_valid_mp4_header(&buf[..n]))
            })
            .unwrap_or(false);

        return Ok(json!({
            "tabId": active_tab,
            "path": out_path.display().to_string(),
            "bytes": video_bytes,
            "delivery": if is_fmp4 { "hls_fmp4" } else { "hls_ts" },
            "container": ext,
            "mimeType": if is_fmp4 { "video/mp4" } else { "video/mp2t" },
            "sourceUrl": first.final_url,
            "variantUrl": chosen_variant.as_ref().map(|v| v.url.clone()),
            "width": chosen_variant.as_ref().and_then(|v| v.width).or(cand_w),
            "height": chosen_variant.as_ref().and_then(|v| v.height).or(cand_h),
            "bandwidth": chosen_variant.as_ref().map(|v| v.bandwidth),
            "durationSeconds": media_pl.duration_seconds,
            "segmentsDownloaded": video_segments,
            "muxedAudio": muxed_with_ffmpeg,
            "companionAudioPath": separate_audio_saved,
            "validMp4Header": if ext == "mp4" { Value::Bool(header_check) } else { Value::Null },
            "elapsedMs": started.elapsed().as_millis() as u64,
        }));
    }

    Err(if last_err.is_empty() {
        "Could not download media stream. [request_failed]".to_string()
    } else {
        last_err
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_and_root_relative_hls_urls_and_selects_best_variant() {
        let base = "https://video.twimg.com/amplify_video/2123679739806388224/pl/qreVjD___cDEoT7y.m3u8?tag=16&variant_version=1";
        let master = "\
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=268793,BANDWIDTH=310755,RESOLUTION=320x492,CODECS=\"avc1.4D4015\"
/amplify_video/2123679739806388224/pl/avc1/320x492/OIqdWfI1vFrY6IYJ.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=485586,BANDWIDTH=561907,RESOLUTION=468x720,CODECS=\"avc1.4D401E\"
/amplify_video/2123679739806388224/pl/avc1/468x720/H2A2DISuPF7ijaug.m3u8
";
        let parsed = parse_m3u8_playlist(master, base).expect("valid master m3u8");
        let ParsedM3u8::Master { variants, .. } = parsed else {
            panic!("expected master playlist");
        };
        assert_eq!(variants.len(), 2);
        let best = select_hls_variant(&variants, "best").unwrap();
        assert_eq!(best.width, Some(468));
        assert_eq!(best.height, Some(720));
        assert_eq!(
            best.url,
            "https://video.twimg.com/amplify_video/2123679739806388224/pl/avc1/468x720/H2A2DISuPF7ijaug.m3u8"
        );
        let low = select_hls_variant(&variants, "lowest").unwrap();
        assert_eq!(low.width, Some(320));
    }

    #[test]
    fn parses_fmp4_init_map_and_rejects_encrypted_hls_streams() {
        let variant_base = "https://video.twimg.com/amplify_video/2123679739806388224/pl/avc1/468x720/H2A2DISuPF7ijaug.m3u8";
        let media = "\
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MAP:URI=\"/amplify_video/2123679739806388224/vid/avc1/0/0/468x720/hRDVFlV-CcbMk7tt.mp4\"
#EXTINF:3.000,
/amplify_video/2123679739806388224/vid/avc1/0/3000/468x720/seg1.m4s
#EXTINF:3.033,
../468x720/seg2.m4s
#EXT-X-ENDLIST
";
        let ParsedM3u8::Media(pl) = parse_m3u8_playlist(media, variant_base).expect("valid media m3u8") else {
            panic!("expected media playlist");
        };
        assert_eq!(
            pl.init_map_url.as_deref(),
            Some("https://video.twimg.com/amplify_video/2123679739806388224/vid/avc1/0/0/468x720/hRDVFlV-CcbMk7tt.mp4")
        );
        assert_eq!(pl.segments.len(), 2);
        assert_eq!(pl.duration_seconds, 6.03);
        assert!(pl.ended);

        let drm_m3u8 = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://123\"\n#EXTINF:4.0,\nseg.ts\n";
        let err = parse_m3u8_playlist(drm_m3u8, variant_base).unwrap_err();
        assert!(err.contains("[drm_protected]"), "{err}");
    }

    #[tokio::test]
    async fn download_media_assembles_hls_fmp4_init_and_segments_atomically() {
        let tmp_dir = std::env::temp_dir().join(format!("bb-media-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();
        let out_file = tmp_dir.join("assembled.mp4");

        let init_bytes = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2";
        let seg1_bytes = b"\x00\x00\x00\x08moof1111";
        let seg2_bytes = b"\x00\x00\x00\x08moof2222";

        let res = download_media_with_caller(
            DownloadOptions {
                url: None,
                output_path: Some(out_file.to_str().unwrap()),
                tab_id: Some(9),
                frame_id: None,
                browser: None,
                prefer_quality: "best",
                max_bytes: DEFAULT_MAX_DOWNLOAD_BYTES,
            },
            |method, params| {
                let m = method;
                let u = params.get("url").and_then(Value::as_str).unwrap_or("").to_string();
                async move {
                    if m == "page.media" {
                        return Ok(json!({
                            "tabId": 9,
                            "title": "X Post",
                            "drmDetected": false,
                            "candidates": [
                                { "url": "https://video.twimg.com/amplify_video/1/pl/master.m3u8", "kind": "hls_master", "frameId": 0, "score": 3000 }
                            ]
                        }));
                    }
                    assert_eq!(m, "page.fetch");
                    let (ct, payload): (&str, &[u8]) = if u.ends_with("master.m3u8") {
                        (
                            "application/vnd.apple.mpegurl",
                            b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=468x720\n/amplify_video/1/pl/avc1/468x720/v.m3u8\n",
                        )
                    } else if u.ends_with("v.m3u8") {
                        (
                            "application/vnd.apple.mpegurl",
                            b"#EXTM3U\n#EXT-X-MAP:URI=\"/amplify_video/1/vid/avc1/0/0/init.mp4\"\n#EXTINF:3.0,\n/amplify_video/1/vid/avc1/0/3000/s1.m4s\n#EXTINF:3.0,\n/amplify_video/1/vid/avc1/3000/6000/s2.m4s\n#EXT-X-ENDLIST\n",
                        )
                    } else if u.ends_with("init.mp4") {
                        ("video/mp4", init_bytes)
                    } else if u.ends_with("s1.m4s") {
                        ("video/iso.segment", seg1_bytes)
                    } else {
                        ("video/iso.segment", seg2_bytes)
                    };
                    Ok(json!({
                        "status": 200,
                        "url": u,
                        "headers": { "content-type": ct },
                        "data": crate::encode_base64(payload),
                        "byteLength": payload.len()
                    }))
                }
            },
        )
        .await
        .expect("HLS fMP4 download should succeed");

        assert_eq!(res["delivery"], json!("hls_fmp4"));
        assert_eq!(res["width"], json!(468));
        assert_eq!(res["height"], json!(720));
        assert_eq!(res["segmentsDownloaded"], json!(2));
        assert_eq!(res["validMp4Header"], json!(true));
        let disk_bytes = std::fs::read(&out_file).unwrap();
        let mut expected = Vec::new();
        expected.extend_from_slice(init_bytes);
        expected.extend_from_slice(seg1_bytes);
        expected.extend_from_slice(seg2_bytes);
        assert_eq!(disk_bytes, expected);
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}
