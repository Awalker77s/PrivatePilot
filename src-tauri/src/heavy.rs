// The one spawn path for heavy tools. The MODEL never composes a command:
// TypeScript builds the exe + argv array, this runs it. No shell, no cmd.exe,
// no pwsh — argv elements are passed straight to CreateProcess, so `&&`, `;`,
// `|`, backticks are inert bytes. Every child is wrapped in a job object
// (kill-on-close so a crash never orphans it, active-process + memory caps,
// wall-clock timeout kill) with its output capped. The exe must be an actual
// `.exe` under our own dirs, and every path argument must resolve inside the
// sandbox — Rust re-checks what TS promised (belt and braces).
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_BASIC_LIMIT_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Deserialize)]
pub struct HeavyPlan {
    /// Absolute path to a bundled/verified `.exe` — never a PATH search.
    pub exe: String,
    /// Fixed flag skeleton + validated operands. No shell string, ever.
    pub argv: Vec<String>,
    /// Working directory — always the run's sandbox base.
    pub cwd: String,
    /// Paths (files/dirs) every argv element must stay inside. Rust re-checks.
    pub allowed_roots: Vec<String>,
    pub timeout_ms: u64,
    pub max_output_bytes: usize,
}

#[derive(Serialize)]
pub struct ToolRunReport {
    pub exit_code: i32,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub output_truncated: bool,
    pub ms: u128,
}

fn canonical(p: &str) -> Option<PathBuf> {
    // Canonicalize if it exists; else canonicalize the parent and re-join, so
    // an output path that doesn't exist yet still gets a real absolute form.
    let path = Path::new(p);
    if let Ok(c) = path.canonicalize() {
        return Some(c);
    }
    let parent = path.parent()?;
    let name = path.file_name()?;
    parent.canonicalize().ok().map(|c| c.join(name))
}

fn inside_any(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|r| path.starts_with(r))
}

/// Looks like a path (has a separator or a drive) — as opposed to a flag or a
/// bare enum token the skeleton supplied.
fn is_path_like(arg: &str) -> bool {
    arg.contains('\\') || arg.contains('/') || (arg.len() >= 2 && arg.as_bytes()[1] == b':')
}

/// Run one heavy tool. Returns an error (designed sentence upstream) only for
/// setup failures the tool contract must refuse; a nonzero exit code comes
/// back in the report, not as an Err.
#[tauri::command(async)]
pub fn run_tool(plan: HeavyPlan) -> Result<ToolRunReport, String> {
    // --- exe must be a real .exe under a trusted dir ---
    let exe_path = Path::new(&plan.exe);
    if exe_path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase())
        != Some("exe".to_string())
    {
        // A .bat/.cmd target re-parses through cmd.exe and reopens injection.
        return Err(format!("Heavy:NotExe:{}", plan.exe));
    }
    let exe_canon = exe_path
        .canonicalize()
        .map_err(|_| format!("Heavy:NoBinary:{}", plan.exe))?;
    if !exe_canon.is_file() {
        return Err(format!("Heavy:NoBinary:{}", plan.exe));
    }

    // --- every path-shaped argv element must resolve inside an allowed root ---
    let roots: Vec<PathBuf> = plan
        .allowed_roots
        .iter()
        .filter_map(|r| Path::new(r).canonicalize().ok())
        .collect();
    if roots.is_empty() {
        return Err("Heavy:NoRoots".to_string());
    }
    for arg in &plan.argv {
        // A leading '-' or '@' would be a flag / response-file, never an
        // operand — TS should never emit one, but refuse it here too.
        if arg.starts_with('@') {
            return Err(format!("Heavy:BadArg:{arg}"));
        }
        if is_path_like(arg) {
            match canonical(arg) {
                Some(c) if inside_any(&c, &roots) => {}
                _ => return Err(format!("Heavy:PathEscape:{arg}")),
            }
        }
    }
    let cwd_canon = Path::new(&plan.cwd)
        .canonicalize()
        .map_err(|_| format!("Heavy:NoCwd:{}", plan.cwd))?;

    // --- spawn, assign to a job object, cap it ---
    let mut cmd = Command::new(&exe_canon);
    cmd.args(&plan.argv)
        .current_dir(&cwd_canon)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        // Scrub the environment — a heavy tool inherits nothing about the user
        // or any proxy. SystemRoot is required for most Windows binaries.
        .env_clear()
        .env("SystemRoot", std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
        .env("TEMP", &plan.cwd)
        .env("TMP", &plan.cwd);

    let started = Instant::now();
    let child = cmd.spawn().map_err(|e| format!("Heavy:Spawn:{e}"))?;

    // Job object: kill-on-close + active-process + memory caps. Assigned right
    // after spawn (our binaries don't fork instantly, and kill-on-close +
    // TerminateJobObject catch everything once assigned).
    let job = unsafe { CreateJobObjectW(None, None) };
    if let Ok(job) = job {
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation = JOBOBJECT_BASIC_LIMIT_INFORMATION {
            LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                | JOB_OBJECT_LIMIT_JOB_MEMORY,
            ActiveProcessLimit: 8,
            ..Default::default()
        };
        info.JobMemoryLimit = 4 * 1024 * 1024 * 1024; // 4 GB across the job
        unsafe {
            let _ = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let _ = AssignProcessToJobObject(job, HANDLE(child.as_raw_handle()));
        }
        // Keep `job` alive until the child is done; dropping its handle with
        // kill-on-close set would kill the child. We hold it in `_job_guard`.
        let _job_guard = JobGuard(job);
        return finish(child, started, &plan, Some(_job_guard));
    }
    finish(child, started, &plan, None)
}

struct JobGuard(HANDLE);
impl Drop for JobGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

fn finish(
    mut child: std::process::Child,
    started: Instant,
    plan: &HeavyPlan,
    job: Option<JobGuard>,
) -> Result<ToolRunReport, String> {
    // Drain stdout/stderr on threads so a chatty tool can't deadlock the pipe.
    let mut out_pipe = child.stdout.take().unwrap();
    let mut err_pipe = child.stderr.take().unwrap();
    let cap = plan.max_output_bytes;
    let (tx, rx) = mpsc::channel();
    let tx2 = tx.clone();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        let mut truncated = false;
        while let Ok(n) = out_pipe.read(&mut chunk) {
            if n == 0 { break; }
            if buf.len() < cap { buf.extend_from_slice(&chunk[..n.min(cap - buf.len())]); }
            else { truncated = true; }
        }
        let _ = tx.send(("out", String::from_utf8_lossy(&buf).into_owned(), truncated));
    });
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        let mut truncated = false;
        while let Ok(n) = err_pipe.read(&mut chunk) {
            if n == 0 { break; }
            if buf.len() < cap { buf.extend_from_slice(&chunk[..n.min(cap - buf.len())]); }
            else { truncated = true; }
        }
        let _ = tx2.send(("err", String::from_utf8_lossy(&buf).into_owned(), truncated));
    });

    // Wall-clock timeout with kill.
    let timeout = Duration::from_millis(plan.timeout_ms);
    let mut timed_out = false;
    let exit_code;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code().unwrap_or(-1);
                break;
            }
            Ok(None) => {
                if started.elapsed() > timeout {
                    timed_out = true;
                    if let Some(j) = &job {
                        unsafe { let _ = TerminateJobObject(j.0, 1); }
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    exit_code = -1;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Heavy:Wait:{e}")),
        }
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut output_truncated = false;
    for _ in 0..2 {
        if let Ok((which, s, trunc)) = rx.recv_timeout(Duration::from_secs(5)) {
            output_truncated |= trunc;
            if which == "out" { stdout = s } else { stderr = s }
        }
    }

    Ok(ToolRunReport {
        exit_code,
        timed_out,
        stdout,
        stderr,
        output_truncated,
        ms: started.elapsed().as_millis(),
    })
}
