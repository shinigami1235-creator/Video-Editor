use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use percent_encoding::percent_decode_str;
use tauri::http::{HeaderMap, Request, Response, StatusCode};
use tauri::{UriSchemeContext, UriSchemeResponder, Wry};

/// Open-ended ranges (`bytes=N-`) are capped at this many bytes.
const OPEN_RANGE_CAP: u64 = 8 * 1024 * 1024;

fn content_type_for(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "m4a" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "onnx" | "bin" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

fn empty_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        .body(Vec::new())
        .unwrap()
}

/// Parses `Range: bytes=a-b` or `bytes=a-`, returning `(start, end_inclusive)`
/// clamped to `file_len`, with open-ended ranges capped at `OPEN_RANGE_CAP`.
fn parse_range(range_header: &str, file_len: u64) -> Option<(u64, u64)> {
    let spec = range_header.strip_prefix("bytes=")?;
    let (start_str, end_str) = spec.split_once('-')?;
    let start: u64 = start_str.parse().ok()?;
    if start >= file_len {
        return None;
    }
    let end: u64 = if end_str.is_empty() {
        (start.saturating_add(OPEN_RANGE_CAP - 1)).min(file_len.saturating_sub(1))
    } else {
        end_str
            .parse::<u64>()
            .unwrap_or(file_len.saturating_sub(1))
            .min(file_len.saturating_sub(1))
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn build_response(path: &str, range_header: Option<String>) -> Response<Vec<u8>> {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return empty_response(StatusCode::NOT_FOUND),
    };
    let file_len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return empty_response(StatusCode::NOT_FOUND),
    };
    let content_type = content_type_for(path);

    if let Some(range_header) = range_header {
        match parse_range(&range_header, file_len) {
            Some((start, end)) => {
                let length = end - start + 1;
                if file.seek(SeekFrom::Start(start)).is_err() {
                    return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
                }
                let mut buf = vec![0u8; length as usize];
                if file.read_exact(&mut buf).is_err() {
                    return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
                }
                return Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header("Content-Range", format!("bytes {start}-{end}/{file_len}"))
                    .header("Content-Length", length.to_string())
                    .header("Accept-Ranges", "bytes")
                    .header("Content-Type", content_type)
                    .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
                    .body(buf)
                    .unwrap();
            }
            None => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header("Content-Range", format!("bytes */{file_len}"))
                    .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
                    .body(Vec::new())
                    .unwrap();
            }
        }
    }

    let mut buf = Vec::with_capacity(file_len as usize);
    if file.read_to_end(&mut buf).is_err() {
        return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
    }
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Length", file_len.to_string())
        .header("Accept-Ranges", "bytes")
        .header("Content-Type", content_type)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        .body(buf)
        .unwrap()
}

fn extract_range_header(headers: &HeaderMap) -> Option<String> {
    headers
        .get("range")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

/// Handler for the `media` custom URI scheme. Decodes the percent-encoded
/// path from the request URI, then serves the file (optionally a byte range)
/// off the main thread.
pub fn handler(
    _ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let raw_path = request.uri().path().to_string();
    let stripped = raw_path.strip_prefix('/').unwrap_or(&raw_path).to_string();
    let decoded = percent_decode_str(&stripped)
        .decode_utf8()
        .map(|c| c.into_owned());
    let range_header = extract_range_header(request.headers());

    std::thread::spawn(move || {
        let response = match decoded {
            Ok(path) => build_response(&path, range_header),
            Err(_) => empty_response(StatusCode::BAD_REQUEST),
        };
        responder.respond(response);
    });
}
