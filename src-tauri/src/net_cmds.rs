use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const USER_AGENT: &str = "video-editor/0.2.0";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressPayload {
    job_id: String,
    received: u64,
    total: u64,
}

/// Cancel flags for running downloads, keyed by job id.
fn cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn download_cancel(job_id: String) -> Result<(), String> {
    if let Some(flag) = cancel_flags().lock().unwrap().get(&job_id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub async fn download(job_id: String, url: String, dest: String, app: AppHandle) -> Result<(), String> {
    let flag = Arc::new(AtomicBool::new(false));
    cancel_flags().lock().unwrap().insert(job_id.clone(), flag.clone());
    let result = download_inner(&job_id, &url, &dest, &app, &flag).await;
    cancel_flags().lock().unwrap().remove(&job_id);
    if result.is_err() {
        let _ = std::fs::remove_file(format!("{dest}.part"));
    }
    result
}

async fn download_inner(job_id: &str, url: &str, dest: &str, app: &AppHandle, cancel: &AtomicBool) -> Result<(), String> {
    let job_id = job_id.to_string();
    let url = url.to_string();
    let dest = dest.to_string();
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("failed to download '{url}': {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "failed to download '{url}': server responded with status {}",
            response.status()
        ));
    }

    let total = response
        .content_length()
        .unwrap_or(0);

    let dest_path = Path::new(&dest);
    if let Some(parent) = dest_path.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("failed to create parent directory for '{dest}': {e}"))?;
        }
    }

    let part_path_string = format!("{dest}.part");
    let part_path = Path::new(&part_path_string);
    let mut file = std::fs::File::create(part_path)
        .map_err(|e| format!("failed to create '{part_path_string}': {e}"))?;

    let mut received: u64 = 0;
    let mut last_emit = Instant::now();
    let mut stream = response.bytes_stream();

    let _ = app.emit(
        "download-progress",
        DownloadProgressPayload {
            job_id: job_id.clone(),
            received: 0,
            total,
        },
    );

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err("Cancelled".to_string());
        }
        let chunk = chunk.map_err(|e| format!("failed while downloading '{url}': {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("failed to write '{part_path_string}': {e}"))?;
        received += chunk.len() as u64;

        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            let _ = app.emit(
                "download-progress",
                DownloadProgressPayload {
                    job_id: job_id.clone(),
                    received,
                    total,
                },
            );
            last_emit = Instant::now();
        }
    }

    drop(file);

    let _ = app.emit(
        "download-progress",
        DownloadProgressPayload {
            job_id: job_id.clone(),
            received,
            total,
        },
    );

    tokio::fs::rename(&part_path_string, &dest)
        .await
        .map_err(|e| format!("failed to finalize '{dest}': {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn unzip(zip_path: String, dest_dir: String) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || unzip_blocking(&zip_path, &dest_dir))
        .await
        .map_err(|e| format!("unzip task failed: {e}"))?
}

fn unzip_blocking(zip_path: &str, dest_dir: &str) -> Result<u64, String> {
    let file =
        std::fs::File::open(zip_path).map_err(|e| format!("failed to open '{zip_path}': {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("failed to read zip archive '{zip_path}': {e}"))?;

    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("failed to create '{dest_dir}': {e}"))?;

    let mut count: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("failed to read entry {i} in '{zip_path}': {e}"))?;
        let enclosed = match entry.enclosed_name() {
            Some(name) => name,
            None => continue, // guard against path traversal / unsafe paths
        };
        let out_path = Path::new(dest_dir).join(enclosed);

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("failed to create '{}': {e}", out_path.display()))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create '{}': {e}", parent.display()))?;
        }

        let mut out_file = std::fs::File::create(&out_path)
            .map_err(|e| format!("failed to create '{}': {e}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out_file)
            .map_err(|e| format!("failed to extract '{}': {e}", out_path.display()))?;
        // programs unpacked on a Mac need their run permission back
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = entry.unix_mode().unwrap_or(0o644) | 0o755;
            let _ = std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(mode & 0o777));
        }
        count += 1;
    }

    Ok(count)
}

#[derive(Serialize)]
pub struct HttpResponsePayload {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

#[tauri::command]
pub async fn http_request(
    method: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<HttpResponsePayload, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;

    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("invalid HTTP method '{method}': {e}"))?;

    let mut request = client.request(method, &url);
    if let Some(headers) = headers {
        for (key, value) in headers {
            request = request.header(key, value);
        }
    }
    if let Some(body) = body {
        request = request.body(body);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("request to '{url}' failed: {e}"))?;

    let status = response.status().as_u16();
    let mut resp_headers = HashMap::new();
    for (name, value) in response.headers().iter() {
        if let Ok(v) = value.to_str() {
            resp_headers.insert(name.to_string(), v.to_string());
        }
    }
    let body_text = response
        .text()
        .await
        .map_err(|e| format!("failed to read response body from '{url}': {e}"))?;

    Ok(HttpResponsePayload {
        status,
        headers: resp_headers,
        body: body_text,
    })
}
