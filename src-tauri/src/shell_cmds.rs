#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // explorer.exe does not understand Rust's quoting of the whole argument,
        // so pass /select,"path" exactly as it expects.
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{path}\""))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("failed to reveal '{path}': {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("failed to reveal '{path}': {e}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("failed to reveal '{path}': {e}"))?;
        return Ok(());
    }
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("explorer")
            .raw_arg(format!("\"{path}\""))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("failed to open '{path}': {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("failed to open '{path}': {e}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("failed to open '{path}': {e}"))?;
        return Ok(());
    }
}
