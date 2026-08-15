// Secrets that must never reach the model or the webview: sealed with
// Windows DPAPI (per-user, per-machine — the same boundary Credential
// Manager uses, no visible entry, no size cap) into secrets.json in app
// data. TypeScript can SET, CLEAR, and ask HAS; only Rust ever reads a value
// back, and only to use it (an IMAP login) — it is never returned over IPC.
use base64::Engine;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
};

static LOCK: Mutex<()> = Mutex::new(());

fn secrets_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Secrets:NoAppData:{e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Secrets:Mkdir:{e}"))?;
    Ok(dir.join("secrets.json"))
}

fn read_all(path: &PathBuf) -> HashMap<String, String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str::<Map<String, Value>>(&text)
        .map(|m| {
            m.into_iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn write_all(path: &PathBuf, all: &HashMap<String, String>) -> Result<(), String> {
    let map: Map<String, Value> = all
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    let text = serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
    // Same temp-then-rename shape as the stores.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("Secrets:Write:{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Secrets:Rename:{e}"))?;
    Ok(())
}

fn seal(plain: &str) -> Result<String, String> {
    let mut bytes = plain.as_bytes().to_vec();
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_mut_ptr() };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
        .map_err(|e| format!("Secrets:Seal:{e}"))?;
        let sealed = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        Ok(base64::engine::general_purpose::STANDARD.encode(sealed))
    }
}

fn unseal(b64: &str) -> Result<String, String> {
    let mut sealed = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("Secrets:Decode:{e}"))?;
    let input = CRYPT_INTEGER_BLOB { cbData: sealed.len() as u32, pbData: sealed.as_mut_ptr() };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            .map_err(|e| format!("Secrets:Unseal:{e}"))?;
        let plain = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        String::from_utf8(plain).map_err(|e| format!("Secrets:Utf8:{e}"))
    }
}

/// Rust-internal: read a secret to USE it. Never exposed as a command.
pub fn get(app: &tauri::AppHandle, name: &str) -> Result<Option<String>, String> {
    let _g = LOCK.lock().map_err(|_| "Secrets:Lock".to_string())?;
    let path = secrets_path(app)?;
    let all = read_all(&path);
    match all.get(name) {
        Some(b64) => Ok(Some(unseal(b64)?)),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn secret_set(app: tauri::AppHandle, name: String, value: String) -> Result<(), String> {
    let _g = LOCK.lock().map_err(|_| "Secrets:Lock".to_string())?;
    let path = secrets_path(&app)?;
    let mut all = read_all(&path);
    all.insert(name, seal(&value)?);
    write_all(&path, &all)
}

#[tauri::command]
pub fn secret_clear(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let _g = LOCK.lock().map_err(|_| "Secrets:Lock".to_string())?;
    let path = secrets_path(&app)?;
    let mut all = read_all(&path);
    all.remove(&name);
    write_all(&path, &all)
}

#[tauri::command]
pub fn secret_has(app: tauri::AppHandle, name: String) -> Result<bool, String> {
    let _g = LOCK.lock().map_err(|_| "Secrets:Lock".to_string())?;
    let path = secrets_path(&app)?;
    Ok(read_all(&path).contains_key(&name))
}
