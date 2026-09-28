use serde::Serialize;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use tauri::http::HeaderMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    size: u64,
    mtime_ms: f64,
    is_dir: bool,
    is_file: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    name: String,
    is_dir: bool,
    size: u64,
    mtime_ms: f64,
}

fn mtime_ms_of(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn decode_header(headers: &HeaderMap, name: &str) -> Result<String, String> {
    let value = headers
        .get(name)
        .ok_or_else(|| format!("missing required header '{name}'"))?;
    let raw = value
        .to_str()
        .map_err(|e| format!("header '{name}' is not valid text: {e}"))?;
    percent_decode_str(raw)
        .decode_utf8()
        .map(|c| c.into_owned())
        .map_err(|e| format!("header '{name}' is not valid percent-encoded UTF-8: {e}"))
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, String> {
    headers
        .get(name)
        .ok_or_else(|| format!("missing required header '{name}'"))?
        .to_str()
        .map_err(|e| format!("header '{name}' is not valid text: {e}"))
}

#[tauri::command]
pub fn fs_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn fs_stat(path: String) -> Result<Option<FsStat>, String> {
    match std::fs::metadata(&path) {
        Ok(meta) => Ok(Some(FsStat {
            size: meta.len(),
            mtime_ms: mtime_ms_of(&meta),
            is_dir: meta.is_dir(),
            is_file: meta.is_file(),
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to stat '{path}': {e}")),
    }
}

#[tauri::command]
pub fn fs_mkdir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("failed to create directory '{path}': {e}"))
}

#[tauri::command]
pub async fn fs_list(path: String) -> Result<Vec<FsEntry>, String> {
    let read_dir =
        std::fs::read_dir(&path).map_err(|e| format!("failed to list directory '{path}': {e}"))?;
    let mut entries = Vec::new();
    for item in read_dir {
        let item = item.map_err(|e| format!("failed to read entry in '{path}': {e}"))?;
        let meta = item
            .metadata()
            .map_err(|e| format!("failed to stat entry '{}': {e}", item.path().display()))?;
        entries.push(FsEntry {
            name: item.file_name().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            mtime_ms: mtime_ms_of(&meta),
        });
    }
    Ok(entries)
}

#[tauri::command]
pub async fn fs_read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("failed to read '{path}': {e}"))
}

#[tauri::command]
pub async fn fs_write_text(path: String, contents: String) -> Result<(), String> {
    let target = Path::new(&path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create parent directory for '{path}': {e}"))?;
        }
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = target.with_file_name(format!(
        "{}.tmp-{}-{}",
        target
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string()),
        std::process::id(),
        nonce
    ));

    std::fs::write(&tmp_path, contents.as_bytes())
        .map_err(|e| format!("failed to write temp file for '{path}': {e}"))?;

    if let Err(_first_err) = std::fs::rename(&tmp_path, target) {
        // On some platforms rename over an existing file can fail; remove the
        // target first and retry so the write still lands atomically-ish.
        let _ = std::fs::remove_file(target);
        std::fs::rename(&tmp_path, target).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!("failed to write '{path}': {e}")
        })?;
    }

    Ok(())
}

#[tauri::command]
pub async fn fs_read_bytes(
    path: String,
    offset: i64,
    length: i64,
) -> Result<tauri::ipc::Response, String> {
    let mut file =
        std::fs::File::open(&path).map_err(|e| format!("failed to open '{path}': {e}"))?;
    if offset > 0 {
        file.seek(SeekFrom::Start(offset as u64))
            .map_err(|e| format!("failed to seek '{path}': {e}"))?;
    }

    let bytes = if length < 0 {
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| format!("failed to read '{path}': {e}"))?;
        buf
    } else {
        let mut buf = vec![0u8; length as usize];
        let mut read_total = 0usize;
        while read_total < buf.len() {
            let n = file
                .read(&mut buf[read_total..])
                .map_err(|e| format!("failed to read '{path}': {e}"))?;
            if n == 0 {
                buf.truncate(read_total);
                break;
            }
            read_total += n;
        }
        buf
    };

    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn fs_write_bytes(request: tauri::ipc::Request<'_>) -> Result<u64, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("fs_write_bytes requires a raw binary body".to_string())
        }
    };

    let headers = request.headers();
    let path = decode_header(headers, "x-path")?;
    let offset: i64 = header_str(headers, "x-offset")?
        .parse()
        .map_err(|e| format!("invalid x-offset header: {e}"))?;
    let truncate = header_str(headers, "x-truncate").unwrap_or("0") == "1";

    let target = Path::new(&path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create parent directory for '{path}': {e}"))?;
        }
    }

    let mut open_opts = std::fs::OpenOptions::new();
    open_opts.write(true).create(true);
    if truncate {
        open_opts.truncate(true);
    }
    let mut file = open_opts
        .open(&path)
        .map_err(|e| format!("failed to open '{path}' for writing: {e}"))?;

    if offset < 0 {
        file.seek(SeekFrom::End(0))
            .map_err(|e| format!("failed to seek '{path}': {e}"))?;
    } else {
        file.seek(SeekFrom::Start(offset as u64))
            .map_err(|e| format!("failed to seek '{path}': {e}"))?;
    }

    file.write_all(&bytes)
        .map_err(|e| format!("failed to write '{path}': {e}"))?;

    Ok(bytes.len() as u64)
}

#[tauri::command]
pub async fn fs_remove(path: String) -> Result<(), String> {
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("failed to stat '{path}': {e}")),
    };
    if meta.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| format!("failed to remove '{path}': {e}"))
    } else {
        std::fs::remove_file(&path).map_err(|e| format!("failed to remove '{path}': {e}"))
    }
}

#[tauri::command]
pub async fn fs_rename(from: String, to: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&to).parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    std::fs::rename(&from, &to).map_err(|e| format!("failed to rename '{from}' to '{to}': {e}"))
}

#[tauri::command]
pub async fn fs_copy(from: String, to: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&to).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create parent directory for '{to}': {e}"))?;
        }
    }
    std::fs::copy(&from, &to)
        .map(|_| ())
        .map_err(|e| format!("failed to copy '{from}' to '{to}': {e}"))
}
