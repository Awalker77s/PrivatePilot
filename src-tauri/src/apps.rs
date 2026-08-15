// Windows-local app access — the zero-account rung of the connector ladder.
// Everything here reads what Windows already knows about the apps on this
// machine (what's playing, which windows are open, what a window says) and
// hands it back as plain data. Nothing leaves the computer; nothing here
// clicks or types — automations look, they don't drive.
use serde::Serialize;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use uiautomation::patterns::{UITextPattern, UIValuePattern};
use uiautomation::types::{ControlType, TreeScope};
use uiautomation::{UIAutomation, UIElement};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

// ---------------------------------------------------------------- media ----

#[derive(Serialize)]
pub struct MediaSession {
    pub app: String,
    pub status: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// The user-facing app label Windows gives (e.g. "Spotify"), best-effort.
    pub app_label: String,
}

fn status_word(s: PlaybackStatus) -> &'static str {
    match s {
        PlaybackStatus::Playing => "playing",
        PlaybackStatus::Paused => "paused",
        PlaybackStatus::Stopped => "stopped",
        PlaybackStatus::Changing => "changing",
        PlaybackStatus::Opened => "opened",
        PlaybackStatus::Closed => "closed",
        _ => "unknown",
    }
}

fn app_label(aumid: &str) -> String {
    // "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" → "Spotify";
    // "Chrome" / "MSEdge" / "Spotify.exe" → as-is minus extension.
    let tail = aumid.rsplit('!').next().unwrap_or(aumid);
    let base = tail.split('.').next().unwrap_or(tail);
    if base.is_empty() { aumid.to_string() } else { base.to_string() }
}

/// What every media-capable app on this PC is doing right now — the same
/// data the volume flyout shows. Zero accounts, zero network.
#[tauri::command(async)]
pub fn media_sessions() -> Result<Vec<MediaSession>, String> {
    let mgr = SessionManager::RequestAsync()
        .map_err(|e| format!("MediaSessions:{e}"))?
        .get()
        .map_err(|e| format!("MediaSessions:{e}"))?;
    let sessions = mgr.GetSessions().map_err(|e| format!("MediaSessions:{e}"))?;
    let mut out = Vec::new();
    for s in sessions {
        let aumid = s
            .SourceAppUserModelId()
            .map(|h| h.to_string())
            .unwrap_or_default();
        let status = s
            .GetPlaybackInfo()
            .and_then(|p| p.PlaybackStatus())
            .map(status_word)
            .unwrap_or("unknown");
        let (title, artist, album) = match s.TryGetMediaPropertiesAsync().and_then(|op| op.get()) {
            Ok(p) => (
                p.Title().map(|h| h.to_string()).unwrap_or_default(),
                p.Artist().map(|h| h.to_string()).unwrap_or_default(),
                p.AlbumTitle().map(|h| h.to_string()).unwrap_or_default(),
            ),
            Err(_) => (String::new(), String::new(), String::new()),
        };
        out.push(MediaSession {
            app_label: app_label(&aumid),
            app: aumid,
            status: status.to_string(),
            title,
            artist,
            album,
        });
    }
    Ok(out)
}

/// Transport control for one app's session: play | pause | next | previous.
/// Returns whether the app accepted the command.
#[tauri::command(async)]
pub fn media_control(app: String, action: String) -> Result<bool, String> {
    let mgr = SessionManager::RequestAsync()
        .map_err(|e| format!("MediaControl:{e}"))?
        .get()
        .map_err(|e| format!("MediaControl:{e}"))?;
    let sessions = mgr.GetSessions().map_err(|e| format!("MediaControl:{e}"))?;
    let wanted = app.to_lowercase();
    for s in sessions {
        let aumid = s
            .SourceAppUserModelId()
            .map(|h| h.to_string())
            .unwrap_or_default();
        if !aumid.to_lowercase().contains(&wanted)
            && !app_label(&aumid).to_lowercase().contains(&wanted)
        {
            continue;
        }
        let op = match action.as_str() {
            "play" => s.TryPlayAsync(),
            "pause" => s.TryPauseAsync(),
            "next" => s.TrySkipNextAsync(),
            "previous" => s.TrySkipPreviousAsync(),
            other => return Err(format!("MediaControl:unknown action {other}")),
        }
        .map_err(|e| format!("MediaControl:{e}"))?;
        let ok = op.get().map_err(|e| format!("MediaControl:{e}"))?;
        return Ok(ok);
    }
    Err(format!("MediaControl:NoSession:{app}"))
}

// ------------------------------------------------------------- windows ----

#[derive(Serialize, Clone)]
pub struct AppWindow {
    pub title: String,
    pub process: String, // "Discord.exe"
    pub pid: u32,
}

#[derive(Serialize)]
pub struct WindowText {
    pub title: String,
    pub process: String,
    pub elements_total: usize,
    pub elements_shown: usize,
    pub text: String,
    pub walk_ms: u128,
    pub retries: u32,
}

const NODE_BUDGET: usize = 1500;
const TEXT_CAP: usize = 6000;
const SKELETAL: usize = 30;
const UIA_TIMEOUT: Duration = Duration::from_secs(20);

// Never look inside these — password managers and ourselves.
const DENY_PROCESSES: &[&str] = &[
    "1password.exe",
    "bitwarden.exe",
    "keepass.exe",
    "keepassxc.exe",
    "lastpass.exe",
    "dashlane.exe",
    "private-pilot.exe",
];

fn process_name(pid: u32) -> String {
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            h,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(h);
        if ok.is_err() {
            return String::new();
        }
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        full.rsplit(['\\', '/']).next().unwrap_or("").to_string()
    }
}

fn denied(process: &str) -> bool {
    let p = process.to_lowercase();
    DENY_PROCESSES.iter().any(|d| p == *d)
}

// UIA on its own MTA thread with a hard timeout — never on the webview's
// thread, never allowed to hang a run.
fn on_uia_thread<T: Send + 'static>(
    f: impl FnOnce(&UIAutomation) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let res = UIAutomation::new()
            .map_err(|e| format!("UIA:{e}"))
            .and_then(|uia| f(&uia));
        let _ = tx.send(res);
    });
    match rx.recv_timeout(UIA_TIMEOUT) {
        Ok(r) => r,
        Err(_) => Err("UIA:Timeout".to_string()),
    }
}

fn top_windows(uia: &UIAutomation) -> Result<Vec<(UIElement, AppWindow)>, String> {
    let root = uia.get_root_element().map_err(|e| format!("UIA:{e}"))?;
    let cond = uia.create_true_condition().map_err(|e| format!("UIA:{e}"))?;
    let kids = root
        .find_all(TreeScope::Children, &cond)
        .map_err(|e| format!("UIA:{e}"))?;
    let me = std::process::id();
    let mut out = Vec::new();
    for el in kids {
        let title = el.get_name().unwrap_or_default();
        if title.trim().is_empty() {
            continue;
        }
        let pid = el.get_process_id().unwrap_or(0);
        if pid == me {
            continue;
        }
        let process = process_name(pid);
        if denied(&process) {
            continue;
        }
        // The shell's own pseudo-windows aren't apps a person means.
        if process.eq_ignore_ascii_case("explorer.exe")
            && matches!(title.as_str(), "Taskbar" | "Program Manager" | "Start")
        {
            continue;
        }
        if el.is_offscreen().unwrap_or(false) && title.len() < 2 {
            continue;
        }
        out.push((el, AppWindow { title, process, pid }));
    }
    Ok(out)
}

/// The titled top-level windows on this desktop — what "list_apps" shows.
#[tauri::command(async)]
pub fn list_windows() -> Result<Vec<AppWindow>, String> {
    on_uia_thread(|uia| Ok(top_windows(uia)?.into_iter().map(|(_, w)| w).collect()))
}

fn short_type(ct: ControlType) -> &'static str {
    match ct {
        ControlType::Text => "Text",
        ControlType::Button => "Button",
        ControlType::Edit => "Edit",
        ControlType::Document => "Document",
        ControlType::Hyperlink => "Link",
        ControlType::ListItem => "Item",
        ControlType::List => "List",
        ControlType::TreeItem => "TreeItem",
        ControlType::Tree => "Tree",
        ControlType::TabItem => "Tab",
        ControlType::MenuItem => "MenuItem",
        ControlType::CheckBox => "CheckBox",
        ControlType::RadioButton => "Radio",
        ControlType::ComboBox => "Combo",
        ControlType::Group => "Group",
        ControlType::Image => "Image",
        ControlType::Header | ControlType::HeaderItem => "Header",
        ControlType::DataItem => "Row",
        ControlType::Table | ControlType::DataGrid => "Table",
        ControlType::Window => "Window",
        ControlType::Pane => "Pane",
        ControlType::StatusBar => "Status",
        ControlType::ToolBar => "Toolbar",
        ControlType::Slider => "Slider",
        ControlType::ProgressBar => "Progress",
        _ => "",
    }
}

fn element_line(el: &UIElement) -> Option<String> {
    let ct = el.get_control_type().ok()?;
    let ty = short_type(ct);
    if ty.is_empty() {
        return None;
    }
    let name = el.get_name().unwrap_or_default();
    let name = name.trim();
    // Edits/documents carry their real payload in a pattern, not the name.
    let mut value = String::new();
    if matches!(ct, ControlType::Edit | ControlType::Document) {
        if let Ok(v) = el.get_pattern::<UIValuePattern>() {
            value = v.get_value().unwrap_or_default();
        }
        if value.trim().is_empty() {
            if let Ok(t) = el.get_pattern::<UITextPattern>() {
                if let Ok(r) = t.get_document_range() {
                    value = r.get_text(2000).unwrap_or_default();
                }
            }
        }
    }
    let value = value.trim();
    if name.is_empty() && value.is_empty() {
        return None;
    }
    // Structural containers with a name are worth a line; anonymous ones aren't.
    if matches!(ct, ControlType::Pane | ControlType::Group | ControlType::Window)
        && name.is_empty()
    {
        return None;
    }
    let mut line = format!("{ty}: {name}");
    if !value.is_empty() {
        let v: String = value.chars().take(2000).collect();
        line.push_str(&format!(" [{}]", v.replace('\n', " ⏎ ")));
    }
    Some(line)
}

fn walk_text(uia: &UIAutomation, root: &UIElement) -> Result<(usize, usize, String), String> {
    let cond = uia.create_true_condition().map_err(|e| format!("UIA:{e}"))?;
    let all = root
        .find_all(TreeScope::Descendants, &cond)
        .map_err(|e| format!("UIA:{e}"))?;
    let total = all.len();
    let mut lines: Vec<String> = Vec::new();
    let mut last = String::new();
    let mut shown = 0usize;
    let mut chars = 0usize;
    for el in all.iter().take(NODE_BUDGET) {
        if let Some(line) = element_line(el) {
            if line == last {
                continue; // adjacent duplicates (icon + label) collapse
            }
            // Web-tech apps repeat a row's label as child Text nodes ("22
            // mentions, D1 Gooners" → "22" → "D1 Gooners"); those fragments
            // only invite off-by-one reads. Keep the row, drop the echoes.
            if let Some(frag) = line.strip_prefix("Text: ") {
                let f = frag.trim();
                if !f.is_empty() && lines.iter().rev().take(4).any(|prev| !prev.starts_with("Text: ") && prev.contains(f)) {
                    continue;
                }
            }
            chars += line.len() + 1;
            if chars > TEXT_CAP {
                break;
            }
            last = line.clone();
            lines.push(line);
            shown += 1;
        }
    }
    Ok((total, shown, lines.join("\n")))
}

/// What one open app window shows, as text — the read_page of apps. Finds
/// the window by title or process name; `focus` narrows to the first region
/// whose name contains it. Chromium-style apps build their tree lazily, so
/// a skeletal first read is retried for ~3 s before we call it skeletal.
#[tauri::command(async)]
pub fn read_window(app: String, focus: Option<String>) -> Result<WindowText, String> {
    on_uia_thread(move |uia| {
        let wanted = app.to_lowercase();
        let wins = top_windows(uia)?;
        let (el, meta) = wins
            .into_iter()
            .find(|(_, w)| {
                w.title.to_lowercase().contains(&wanted)
                    || w.process.to_lowercase().contains(&wanted)
                    || w.process
                        .to_lowercase()
                        .trim_end_matches(".exe")
                        .contains(&wanted)
            })
            .ok_or_else(|| format!("UIA:NoWindow:{app}"))?;

        // Narrow to a named region if asked.
        let mut root = el;
        if let Some(f) = focus.as_ref().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()) {
            let cond = uia.create_true_condition().map_err(|e| format!("UIA:{e}"))?;
            if let Ok(all) = root.find_all(TreeScope::Descendants, &cond) {
                if let Some(hit) = all.into_iter().find(|e| {
                    e.get_name()
                        .map(|n| n.to_lowercase().contains(&f))
                        .unwrap_or(false)
                }) {
                    root = hit;
                }
            }
        }

        let started = Instant::now();
        let mut retries = 0u32;
        let mut result = walk_text(uia, &root)?;
        while result.0 < SKELETAL && retries < 3 {
            std::thread::sleep(Duration::from_millis(900));
            retries += 1;
            result = walk_text(uia, &root)?;
        }
        Ok(WindowText {
            title: meta.title,
            process: meta.process,
            elements_total: result.0,
            elements_shown: result.1,
            text: result.2,
            walk_ms: started.elapsed().as_millis(),
            retries,
        })
    })
}
