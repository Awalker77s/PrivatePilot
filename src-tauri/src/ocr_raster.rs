// Rasterize a scanned (image-only) PDF's pages to PNGs so Tesseract can OCR
// them (Tesseract can't read PDFs directly). pdfium (BSD/Apache, the Chromium
// PDF engine) renders each page at the requested DPI; the pages land in the
// run's sandbox as page-N.png. Pure pixel decode — no exec, no network.
use pdfium_render::prelude::*;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

// pdfium can only be bound to the DLL ONCE per process, and it isn't
// thread-safe — so bind it a single time and serialize every render through a
// Mutex. The first call that reaches it wins the bind; later calls reuse it.
static PDFIUM: OnceLock<Mutex<Result<Pdfium, String>>> = OnceLock::new();

fn with_pdfium<T>(
    dll_path: &str,
    f: impl FnOnce(&Pdfium) -> Result<T, String>,
) -> Result<T, String> {
    let cell = PDFIUM.get_or_init(|| {
        Mutex::new(
            Pdfium::bind_to_library(dll_path)
                .map(Pdfium::new)
                .map_err(|e| format!("Raster:Bind:{e}")),
        )
    });
    let guard = cell.lock().map_err(|_| "Raster:Lock".to_string())?;
    match &*guard {
        Ok(pdfium) => f(pdfium),
        Err(e) => Err(e.clone()),
    }
}

/// Render every page of `pdf_path` at `dpi` into `out_dir` as page-1.png …
/// Returns the written PNG paths. `dll_path` is the bundled/fetched pdfium.dll.
#[tauri::command(async)]
pub fn rasterize_pdf(
    dll_path: String,
    pdf_path: String,
    dpi: u32,
    out_dir: String,
) -> Result<Vec<String>, String> {
    with_pdfium(&dll_path, |pdfium| render_all(pdfium, &pdf_path, dpi, &out_dir))
}

fn render_all(pdfium: &Pdfium, pdf_path: &str, dpi: u32, out_dir: &str) -> Result<Vec<String>, String> {
    let doc = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| format!("Raster:Load:{e}"))?;

    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Raster:Mkdir:{e}"))?;
    let scale = dpi as f32 / 72.0;
    let mut out = Vec::new();

    for (i, page) in doc.pages().iter().enumerate() {
        let w = (page.width().value * scale).round().max(1.0) as i32;
        let h = (page.height().value * scale).round().max(1.0) as i32;
        // Cap to keep a giant page from exhausting memory (~ 200 MP).
        if (w as i64) * (h as i64) > 200_000_000 {
            return Err(format!("Raster:TooBig:page {}", i + 1));
        }
        let cfg = PdfRenderConfig::new()
            .set_target_width(w)
            .set_target_height(h)
            .render_form_data(false);
        let bitmap = page
            .render_with_config(&cfg)
            .map_err(|e| format!("Raster:Render:{e}"))?;
        let rgba = bitmap.as_rgba_bytes();
        let path = format!("{}/page-{}.png", out_dir.trim_end_matches(['/', '\\']), i + 1);
        write_png(&path, bitmap.width() as u32, bitmap.height() as u32, &rgba)
            .map_err(|e| format!("Raster:Png:{e}"))?;
        out.push(path);
    }
    if out.is_empty() {
        return Err("Raster:NoPages".to_string());
    }
    Ok(out)
}

fn write_png(path: &str, w: u32, h: u32, rgba: &[u8]) -> Result<(), String> {
    let file = std::fs::File::create(Path::new(path)).map_err(|e| e.to_string())?;
    let buf = std::io::BufWriter::new(file);
    let mut enc = png::Encoder::new(buf, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    Ok(())
}
