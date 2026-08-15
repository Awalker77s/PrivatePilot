// Private Pilot keeps Rust to two escape-hatch commands the build pack sanctions:
// dialog-picked paths are not auto-added to the fs scope (allowed here at pick
// time), and plugin-fs exposes no fsync for the temp-file-then-rename write.
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri_plugin_fs::FsExt;

#[tauri::command]
fn allow_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.fs_scope()
        .allow_directory(PathBuf::from(&path), true)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn allow_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.fs_scope()
        .allow_file(PathBuf::from(&path))
        .map_err(|e| e.to_string())
}

/// One attempt at an atomic write: temp file in the same directory, fsync,
/// rename over the target. Retry policy (Defender/indexer lock backoff) lives
/// in TypeScript where its failure state is designed UI.
#[tauri::command]
fn atomic_write(path: String, contents: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = target
        .parent()
        .ok_or_else(|| "NoParent:target path has no parent directory".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("{:?}:{}", e.kind(), e))?;
    let stem = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("store");
    let tmp = dir.join(format!(".{}.tmp-{}", stem, std::process::id()));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("{:?}:{}", e.kind(), e))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("{:?}:{}", e.kind(), e))?;
        f.sync_all().map_err(|e| format!("{:?}:{}", e.kind(), e))?;
    }
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{:?}:{}", e.kind(), e)
    })
}

/// Pre-flight walk: sum bytes + count files under a root, bailing early once
/// past the caps. Policy (what the numbers mean) lives in TypeScript.
#[tauri::command]
fn walk_stats(path: String, max_files: u64, max_bytes: u64) -> Result<serde_json::Value, String> {
    fn walk(
        dir: &std::path::Path,
        bytes: &mut u64,
        files: &mut u64,
        max_f: u64,
        max_b: u64,
    ) -> bool {
        if let Ok(rd) = fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_symlink() {
                    continue;
                }
                if p.is_dir() {
                    if walk(&p, bytes, files, max_f, max_b) {
                        return true;
                    }
                } else if let Ok(md) = e.metadata() {
                    *bytes += md.len();
                    *files += 1;
                    if *files > max_f || *bytes > max_b {
                        return true;
                    }
                }
            }
        }
        false
    }
    let root = PathBuf::from(&path);
    let mut bytes: u64 = 0;
    let mut files: u64 = 0;
    let capped = if root.is_file() {
        bytes = fs::metadata(&root).map(|m| m.len()).unwrap_or(0);
        files = 1;
        false
    } else {
        walk(&root, &mut bytes, &mut files, max_files, max_bytes)
    };
    Ok(serde_json::json!({ "bytes": bytes, "files": files, "capped": capped }))
}

/// Sandbox copy: real bytes, never hard links — a write through a hard link
/// edits the user's real file instantly.
#[tauri::command]
fn copy_dir(src: String, dst: String) -> Result<u64, String> {
    fn copy_rec(src: &std::path::Path, dst: &std::path::Path, n: &mut u64) -> Result<(), String> {
        fs::create_dir_all(dst).map_err(|e| format!("{:?}:{}", e.kind(), e))?;
        let rd = fs::read_dir(src).map_err(|e| format!("{:?}:{}", e.kind(), e))?;
        for e in rd.flatten() {
            let p = e.path();
            if p.is_symlink() {
                continue;
            }
            let target = dst.join(e.file_name());
            if p.is_dir() {
                copy_rec(&p, &target, n)?;
            } else {
                fs::copy(&p, &target).map_err(|e| format!("{:?}:{}", e.kind(), e))?;
                *n += 1;
            }
        }
        Ok(())
    }
    let mut n: u64 = 0;
    let s = PathBuf::from(&src);
    let d = PathBuf::from(&dst);
    if s.is_file() {
        if let Some(parent) = d.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{:?}:{}", e.kind(), e))?;
        }
        fs::copy(&s, &d).map_err(|e| format!("{:?}:{}", e.kind(), e))?;
        n = 1;
    } else {
        copy_rec(&s, &d, &mut n)?;
    }
    Ok(n)
}

/// Watch-me transcription: spawn the bundled whisper-cli on a WAV the
/// frontend wrote into app data, return the JSON transcript. Mechanism only —
/// model choice, audio conversion, and deletion policy live in TypeScript.
#[tauri::command]
fn transcribe_wav(
    app: tauri::AppHandle,
    wav_path: String,
    model_path: String,
) -> Result<String, String> {
    use tauri::Manager;
    #[cfg(debug_assertions)]
    let exe = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/whisper-cli.exe");
    #[cfg(not(debug_assertions))]
    let exe = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("binaries/whisper-cli.exe");
    if !exe.exists() {
        return Err(format!("NoSidecar:whisper-cli not found at {}", exe.display()));
    }
    let out_base = wav_path.trim_end_matches(".wav").to_string();
    let mut cmd = std::process::Command::new(&exe);
    cmd.args([
        "-m", &model_path, "-f", &wav_path, "-oj", "-of", &out_base, "-np", "-t", "4",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console flash
    }
    let output = cmd.output().map_err(|e| format!("Spawn:{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "WhisperFailed:{}:{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let json_path = format!("{out_base}.json");
    let json = fs::read_to_string(&json_path).map_err(|e| format!("{:?}:{}", e.kind(), e))?;
    let _ = fs::remove_file(&json_path);
    Ok(json)
}

/// High-accuracy transcription via NVIDIA Parakeet on the same whisper.cpp
/// runtime. parakeet-cli has no JSON output — the transcript arrives as
/// plain stdout text.
#[tauri::command]
fn transcribe_wav_parakeet(
    app: tauri::AppHandle,
    wav_path: String,
    model_path: String,
) -> Result<String, String> {
    use tauri::Manager;
    #[cfg(debug_assertions)]
    let exe = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/parakeet-cli.exe");
    #[cfg(not(debug_assertions))]
    let exe = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("binaries/parakeet-cli.exe");
    if !exe.exists() {
        return Err(format!("NoSidecar:parakeet-cli not found at {}", exe.display()));
    }
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(["-m", &model_path, "-f", &wav_path, "-t", "4", "-np"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let output = cmd.output().map_err(|e| format!("Spawn:{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ParakeetFailed:{}:{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            allow_folder,
            allow_file,
            atomic_write,
            walk_stats,
            copy_dir,
            transcribe_wav,
            transcribe_wav_parakeet
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
