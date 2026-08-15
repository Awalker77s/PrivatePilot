// Private Pilot keeps Rust to two escape-hatch commands the build pack sanctions:
// dialog-picked paths are not auto-added to the fs scope (allowed here at pick
// time), and plugin-fs exposes no fsync for the temp-file-then-rename write.
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;
use tauri_plugin_fs::FsExt;

#[derive(serde::Serialize)]
struct LocalHttpResponse {
    status: u16,
    body: String,
}

// Ollama rejects the packaged WebView's synthetic Origin header. Keep this
// native escape hatch loopback-only and limited to the four APIs the app uses.
#[tauri::command]
async fn ollama_request(
    path: String,
    method: String,
    body: Option<String>,
    timeout_ms: u64,
) -> Result<LocalHttpResponse, String> {
    const ALLOWED_PATHS: [&str; 4] = ["/api/tags", "/api/show", "/api/ps", "/api/chat"];
    if !ALLOWED_PATHS.contains(&path.as_str()) {
        return Err("Refused: unsupported Ollama endpoint".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.min(305_000)))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:11434{}", path);
    let request = match method.as_str() {
        "GET" => client.get(url),
        "POST" => client.post(url),
        _ => return Err("Refused: unsupported Ollama method".to_string()),
    };
    let request = if let Some(contents) = body {
        request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(contents)
    } else {
        request
    };
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| e.to_string())?;
    Ok(LocalHttpResponse { status, body })
}

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
            ollama_request,
            atomic_write,
            walk_stats,
            copy_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
