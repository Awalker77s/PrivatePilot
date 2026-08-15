// Render-and-read: open a page in a real (offscreen) browser window, wait
// for it to settle, and hand back the rendered text — or a screenshot for
// the vision model. Mechanism only; the tool policy, fence sentences, and
// reading ladder live in TypeScript.
//
// Hard-won constraints honored here (researched against WebView2 issues):
// - CapturePreview's completion handler NEVER fires on a hidden webview
//   (WebView2Feedback #579) → the window is visible but parked offscreen,
//   with occlusion-based throttling disabled at startup.
// - Page-side timers are throttled when occluded → the settle check is
//   HOST-driven polling, never page timers.
// - ExecuteScript runs host-side on any origin with zero IPC exposure —
//   no remote-domain IPC capability is ever granted.
// - The IStream from CapturePreview is not Send: it is drained inside the
//   completion closure.
#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

static RENDER_BUSY: AtomicBool = AtomicBool::new(false);
const LABEL: &str = "pp-render";
const SETTLE_POLL_MS: u64 = 500;
const SETTLE_CAP_MS: u64 = 15_000;
const JOB_CAP_MS: u64 = 30_000;
const TEXT_CAP: usize = 200_000;

#[derive(Serialize)]
pub struct RenderResult {
    pub text: Option<String>,
    pub png_b64: Option<String>,
    pub settled: bool,
    pub fence_blocks: Vec<String>,
    pub final_url: String,
    pub settle_ms: u64,
}

fn host_allowed(sources: &[String], host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    sources.iter().any(|s| {
        let s = s.to_ascii_lowercase();
        h == s || h.ends_with(&format!(".{s}"))
    })
}

/// Run JS in the render window and get the JSON-encoded result back.
fn exec_script(
    window: &tauri::WebviewWindow,
    js: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows::core::{HSTRING, PCWSTR};

    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    let js_owned = js.to_string();
    window
        .with_webview(move |pw| {
            let controller = pw.controller();
            unsafe {
                let core = match controller.CoreWebView2() {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(Err(format!("CoreWebView2: {e}")));
                        return;
                    }
                };
                let wide = HSTRING::from(js_owned.as_str());
                let tx2 = tx.clone();
                let handler = ExecuteScriptCompletedHandler::create(Box::new(
                    move |hr: windows::core::Result<()>, json: String| {
                        match hr {
                            Ok(()) => {
                                let _ = tx2.send(Ok(json));
                            }
                            Err(e) => {
                                let _ = tx2.send(Err(format!("ExecuteScript: {e}")));
                            }
                        }
                        Ok(())
                    },
                ));
                if let Err(e) = core.ExecuteScript(PCWSTR(wide.as_ptr()), &handler) {
                    let _ = tx.send(Err(format!("ExecuteScript call: {e}")));
                }
            }
        })
        .map_err(|e| format!("with_webview: {e}"))?;

    match rx.recv_timeout(timeout) {
        Ok(Ok(json)) => serde_json::from_str(&json).map_err(|e| format!("parse: {e}")),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("script timeout".into()),
    }
}

fn capture_png(window: &tauri::WebviewWindow, timeout: Duration) -> Result<Vec<u8>, String> {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::core::Interface;
    use windows::Win32::System::Com::{ISequentialStream, STREAM_SEEK_SET};
    use windows::Win32::UI::Shell::SHCreateMemStream;

    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    window
        .with_webview(move |pw| {
            let controller = pw.controller();
            unsafe {
                let core = match controller.CoreWebView2() {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(Err(format!("CoreWebView2: {e}")));
                        return;
                    }
                };
                let stream = match SHCreateMemStream(None) {
                    Some(s) => s,
                    None => {
                        let _ = tx.send(Err("SHCreateMemStream failed".into()));
                        return;
                    }
                };
                let stream_for_handler = stream.clone();
                let tx2 = tx.clone();
                let handler = CapturePreviewCompletedHandler::create(Box::new(
                    move |hr: windows::core::Result<()>| {
                        if let Err(e) = hr {
                            let _ = tx2.send(Err(format!("CapturePreview: {e}")));
                            return Ok(());
                        }
                        // Drain the IStream HERE — it is not Send.
                        let mut bytes: Vec<u8> = Vec::new();
                        let _ = stream_for_handler.Seek(0, STREAM_SEEK_SET, None);
                        let seq: ISequentialStream = stream_for_handler.cast().unwrap();
                        let mut buf = [0u8; 65536];
                        loop {
                            let mut read: u32 = 0;
                            let hr2 = seq.Read(
                                buf.as_mut_ptr() as *mut _,
                                buf.len() as u32,
                                Some(&mut read),
                            );
                            if read == 0 {
                                break;
                            }
                            bytes.extend_from_slice(&buf[..read as usize]);
                            if hr2.is_err() {
                                break;
                            }
                        }
                        let _ = tx2.send(Ok(bytes));
                        Ok(())
                    },
                ));
                if let Err(e) = core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &handler,
                ) {
                    let _ = tx.send(Err(format!("CapturePreview call: {e}")));
                }
            }
        })
        .map_err(|e| format!("with_webview: {e}"))?;

    match rx.recv_timeout(timeout) {
        Ok(r) => r,
        Err(_) => Err("capture timeout".into()),
    }
}

// The recursive text walker: innerText plus shadow roots and same-origin
// iframes, which plain body.innerText misses.
const TEXT_WALKER: &str = r#"
(() => {
  const out = [];
  const walk = (root) => {
    if (!root) return;
    if (root.body) out.push(root.body.innerText || "");
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of all) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.tagName === "IFRAME") {
        try { if (el.contentDocument) walk(el.contentDocument); } catch (e) {}
      }
    }
  };
  walk(document);
  return out.join("\n").slice(0, 200000);
})()
"#;

#[tauri::command]
pub async fn render_page(
    app: tauri::AppHandle,
    url: String,
    sources: Vec<String>,
    mode: String, // "text" | "screenshot"
    extra_wait_ms: Option<u64>,
) -> Result<RenderResult, String> {
    if RENDER_BUSY.swap(true, Ordering::SeqCst) {
        return Err("Busy:another page is being read right now".into());
    }
    let result = render_inner(&app, &url, &sources, &mode, extra_wait_ms.unwrap_or(0)).await;
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
    RENDER_BUSY.store(false, Ordering::SeqCst);
    result
}

async fn render_inner(
    app: &tauri::AppHandle,
    url: &str,
    sources: &[String],
    mode: &str,
    extra_wait_ms: u64,
) -> Result<RenderResult, String> {
    let parsed = tauri::Url::parse(url).map_err(|e| format!("BadUrl:{e}"))?;
    let host = parsed.host_str().unwrap_or("").to_string();
    if !host_allowed(sources, &host) {
        return Err(format!("Fence:{host}"));
    }

    // Leftover window from a crashed job — clear it.
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }

    let fence_blocks: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let fence_for_nav = fence_blocks.clone();
    let sources_owned: Vec<String> = sources.to_vec();
    let (loaded_tx, loaded_rx) = mpsc::channel::<()>();
    let loaded_tx = Mutex::new(Some(loaded_tx));

    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(parsed))
        // Visible but parked far offscreen: CapturePreview never completes on
        // hidden webviews, and this one code path serves text AND pixels.
        .visible(true)
        .position(-32000.0, -32000.0)
        .inner_size(1280.0, 900.0)
        .skip_taskbar(true)
        .focused(false)
        // Every visit is a stranger's visit — never the user's cookies.
        .incognito(true)
        .on_navigation(move |nav_url| {
            let h = nav_url.host_str().unwrap_or("").to_ascii_lowercase();
            let ok = h.is_empty()
                || sources_owned.iter().any(|s| {
                    let s = s.to_ascii_lowercase();
                    h == s || h.ends_with(&format!(".{s}"))
                });
            if !ok {
                fence_for_nav.lock().unwrap().push(h);
            }
            ok
        })
        .on_page_load(move |_w, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if let Some(tx) = loaded_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        })
        .build()
        .map_err(|e| format!("Window:{e}"))?;

    let started = Instant::now();

    // Wait for the load event (or give the settle loop a chance anyway).
    let _ = tauri::async_runtime::spawn_blocking({
        move || loaded_rx.recv_timeout(Duration::from_millis(SETTLE_CAP_MS))
    })
    .await;

    // Host-driven settle: innerText length stable across two polls.
    let mut prev_len: i64 = -1;
    let mut settled = false;
    let settle_deadline = Instant::now() + Duration::from_millis(SETTLE_CAP_MS + extra_wait_ms);
    while Instant::now() < settle_deadline {
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(SETTLE_POLL_MS)))
            .await
            .ok();
        let len = exec_script(
            &window,
            "document.body ? document.body.innerText.length : 0",
            Duration::from_secs(5),
        )
        .ok()
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
        if len > 0 && len == prev_len {
            settled = true;
            break;
        }
        prev_len = len;
        if started.elapsed() > Duration::from_millis(JOB_CAP_MS) {
            break;
        }
    }
    if extra_wait_ms > 0 {
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(Duration::from_millis(extra_wait_ms))
        })
        .await
        .ok();
    }

    let final_url = window.url().map(|u| u.to_string()).unwrap_or_default();

    let mut text: Option<String> = None;
    let mut png_b64: Option<String> = None;

    if mode == "screenshot" {
        // Viewport-only capture: size the window to the content first.
        let h = exec_script(
            &window,
            "Math.min(document.documentElement.scrollHeight, 4000)",
            Duration::from_secs(5),
        )
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(900.0);
        let _ = window.set_size(tauri::LogicalSize::new(1280.0, h.max(600.0)));
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(400)))
            .await
            .ok();
        let png = capture_png(&window, Duration::from_secs(15))?;
        png_b64 = Some(base64::engine::general_purpose::STANDARD.encode(png));
    } else {
        let value = exec_script(&window, TEXT_WALKER, Duration::from_secs(10))?;
        let mut s = value.as_str().unwrap_or("").to_string();
        s.truncate(TEXT_CAP);
        text = Some(s);
    }

    let blocks = fence_blocks.lock().unwrap().clone();
    Ok(RenderResult {
        text,
        png_b64,
        settled,
        fence_blocks: blocks,
        final_url,
        settle_ms: started.elapsed().as_millis() as u64,
    })
}
