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
            atomic_write
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
