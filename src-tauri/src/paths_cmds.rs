use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    app_data: String,
    cache: String,
    documents: String,
    videos: String,
    music: String,
    pictures: String,
    temp: String,
    home: String,
    resource: String,
    platform: String,
    arch: String,
    sep: String,
}

fn dir_or_empty<F>(f: F) -> String
where
    F: FnOnce() -> tauri::Result<std::path::PathBuf>,
{
    f().map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn app_paths(app: AppHandle) -> Result<AppPaths, String> {
    let path = app.path();

    let platform = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    }
    .to_string();

    Ok(AppPaths {
        app_data: dir_or_empty(|| path.app_data_dir()),
        cache: dir_or_empty(|| path.app_cache_dir()),
        documents: dir_or_empty(|| path.document_dir()),
        videos: dir_or_empty(|| path.video_dir()),
        music: dir_or_empty(|| path.audio_dir()),
        pictures: dir_or_empty(|| path.picture_dir()),
        temp: dir_or_empty(|| path.temp_dir()),
        home: dir_or_empty(|| path.home_dir()),
        resource: dir_or_empty(|| path.resource_dir()),
        platform,
        arch: std::env::consts::ARCH.to_string(),
        sep: std::path::MAIN_SEPARATOR.to_string(),
    })
}
