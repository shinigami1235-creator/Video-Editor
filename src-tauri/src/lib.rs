mod fs_cmds;
mod media;
mod net_cmds;
mod paths_cmds;
mod proc_cmds;
mod shell_cmds;

use proc_cmds::JobMap;

pub fn run() {
    let jobs: JobMap = JobMap::default();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(jobs)
        .register_asynchronous_uri_scheme_protocol("media", media::handler)
        .invoke_handler(tauri::generate_handler![
            paths_cmds::app_paths,
            fs_cmds::fs_exists,
            fs_cmds::fs_stat,
            fs_cmds::fs_mkdir,
            fs_cmds::fs_list,
            fs_cmds::fs_read_text,
            fs_cmds::fs_write_text,
            fs_cmds::fs_read_bytes,
            fs_cmds::fs_write_bytes,
            fs_cmds::fs_remove,
            fs_cmds::fs_rename,
            fs_cmds::fs_copy,
            proc_cmds::proc_spawn,
            proc_cmds::proc_write,
            proc_cmds::proc_close_stdin,
            proc_cmds::proc_kill,
            net_cmds::download,
            net_cmds::download_cancel,
            net_cmds::unzip,
            net_cmds::http_request,
            shell_cmds::reveal_path,
            shell_cmds::open_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            use tauri::Manager;
            let jobs = app_handle.state::<JobMap>();
            proc_cmds::kill_all(&jobs);
        }
    });
}
