use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

pub struct ProcJob {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

pub type JobMap = Arc<Mutex<HashMap<String, ProcJob>>>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcOutputPayload {
    job_id: String,
    stream: &'static str,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcExitPayload {
    job_id: String,
    code: Option<i32>,
}

/// Reads a stream, splitting on '\r' or '\n', dropping empty lines, and
/// emitting `proc-output` for each one. Decodes lossily as UTF-8.
fn stream_lines<R: Read>(mut reader: R, app: AppHandle, job_id: String, stream: &'static str) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                for &b in &chunk[..n] {
                    if b == b'\n' || b == b'\r' {
                        if !buf.is_empty() {
                            let line = String::from_utf8_lossy(&buf).into_owned();
                            let _ = app.emit(
                                "proc-output",
                                ProcOutputPayload {
                                    job_id: job_id.clone(),
                                    stream,
                                    line,
                                },
                            );
                            buf.clear();
                        }
                    } else {
                        buf.push(b);
                    }
                }
            }
            Err(_) => break,
        }
    }
    if !buf.is_empty() {
        let line = String::from_utf8_lossy(&buf).into_owned();
        let _ = app.emit(
            "proc-output",
            ProcOutputPayload {
                job_id,
                stream,
                line,
            },
        );
    }
}

#[tauri::command]
pub async fn proc_spawn(
    job_id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    app: AppHandle,
    jobs: State<'_, JobMap>,
) -> Result<u32, String> {
    let mut cmd = Command::new(&program);
    cmd.args(&args);
    if let Some(dir) = &cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn '{program}': {e}"))?;
    let pid = child.id();

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("failed to capture stdout for '{program}'"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("failed to capture stderr for '{program}'"))?;
    let stdin = child.stdin.take();

    let child_arc = Arc::new(Mutex::new(child));
    let stdin_arc = Arc::new(Mutex::new(stdin));

    jobs.lock().unwrap().insert(
        job_id.clone(),
        ProcJob {
            child: child_arc.clone(),
            stdin: stdin_arc,
        },
    );

    let out_app = app.clone();
    let out_job_id = job_id.clone();
    let out_thread =
        std::thread::spawn(move || stream_lines(stdout, out_app, out_job_id, "stdout"));

    let err_app = app.clone();
    let err_job_id = job_id.clone();
    let err_thread =
        std::thread::spawn(move || stream_lines(stderr, err_app, err_job_id, "stderr"));

    let jobs_map: JobMap = jobs.inner().clone();
    let exit_app = app.clone();
    let exit_job_id = job_id.clone();
    std::thread::spawn(move || {
        let _ = out_thread.join();
        let _ = err_thread.join();
        let code = match child_arc.lock().unwrap().wait() {
            Ok(status) => status.code(),
            Err(_) => None,
        };
        jobs_map.lock().unwrap().remove(&exit_job_id);
        let _ = exit_app.emit(
            "proc-exit",
            ProcExitPayload {
                job_id: exit_job_id,
                code,
            },
        );
    });

    Ok(pid)
}

#[tauri::command]
pub async fn proc_write(request: tauri::ipc::Request<'_>, jobs: State<'_, JobMap>) -> Result<(), String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("proc_write requires a raw binary body".to_string())
        }
    };

    let job_id_header = request
        .headers()
        .get("x-job")
        .ok_or_else(|| "missing required header 'x-job'".to_string())?;
    let job_id_raw = job_id_header
        .to_str()
        .map_err(|e| format!("header 'x-job' is not valid text: {e}"))?;
    let job_id = percent_decode_str(job_id_raw)
        .decode_utf8()
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| job_id_raw.to_string());

    // take this job's stdin handle and release the job map before the
    // (possibly blocking) write, so other commands never wait on it
    let stdin_arc = {
        let jobs_guard = jobs.lock().unwrap();
        let job = jobs_guard
            .get(&job_id)
            .ok_or_else(|| format!("no such job '{job_id}'"))?;
        job.stdin.clone()
    };
    let mut stdin_guard = stdin_arc.lock().unwrap();
    match stdin_guard.as_mut() {
        Some(stdin) => stdin
            .write_all(&bytes)
            .map_err(|e| format!("failed to write to job '{job_id}' stdin: {e}")),
        None => Err(format!("job '{job_id}' stdin is closed")),
    }
}

#[tauri::command]
pub async fn proc_close_stdin(job_id: String, jobs: State<'_, JobMap>) -> Result<(), String> {
    let stdin_arc = {
        let jobs_guard = jobs.lock().unwrap();
        jobs_guard.get(&job_id).map(|job| job.stdin.clone())
    };
    if let Some(stdin_arc) = stdin_arc {
        let mut stdin_guard = stdin_arc.lock().unwrap();
        *stdin_guard = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn proc_kill(job_id: String, jobs: State<'_, JobMap>) -> Result<(), String> {
    let child_arc = {
        let jobs_guard = jobs.lock().unwrap();
        jobs_guard.get(&job_id).map(|job| job.child.clone())
    };
    if let Some(child_arc) = child_arc {
        let mut child_guard = child_arc.lock().unwrap();
        let _ = child_guard.kill();
    }
    Ok(())
}

/// Kills every still-running child process. Called when the app is exiting.
pub fn kill_all(jobs: &JobMap) {
    let jobs_guard = jobs.lock().unwrap();
    for job in jobs_guard.values() {
        let mut child_guard = job.child.lock().unwrap();
        let _ = child_guard.kill();
    }
}
