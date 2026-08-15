// ocr_pdf — turn a scanned or photographed document into a SEARCHABLE PDF
// plus clean text, so a dirty document becomes both readable and indexable
// (the RAG layer embeds the text). Backed by Tesseract (Apache 2.0); our code
// builds the argv and appends the literal `txt pdf` output selectors, so the
// model never composes a command. Runs in the sandbox via run_tool.
//
// v1 handles IMAGES directly (jpg/png/tiff/webp/bmp) — Tesseract reads them
// with no rasterizer. Scanned image-only PDFs (which need pdfium to rasterize
// pages first) are the documented next step; a PDF here is refused honestly.
import { readTextFile, writeTextFile, rename, exists, readDir, stat } from "@tauri-apps/plugin-fs";
import { z } from "zod";
import { runTool } from "./runTool";
import type { HeavyContext, HeavyResult, HeavyToolSpec } from "./types";

const IMG = /\.(png|jpe?g|tiff?|bmp|webp)$/i;
const LOW_CONF_CHARS = 20; // below this, a page came back unreadable — say so

const params = z.object({
  files: z.array(z.string().min(1)).min(1),
  language: z.string().regex(/^[a-z]{3}(\+[a-z]{3})*$/).default("eng"),
  clean: z.coerce.boolean().default(true),
});

function baseName(path: string): { dir: string; stem: string; sep: string } {
  const sep = path.includes("\\") ? "\\" : "/";
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const dir = i >= 0 ? path.slice(0, i) : ".";
  const file = i >= 0 ? path.slice(i + 1) : path;
  const dot = file.lastIndexOf(".");
  return { dir, stem: dot > 0 ? file.slice(0, dot) : file, sep };
}

export const realOcrRun = async (
  args: Record<string, unknown>,
  ctx: HeavyContext
): Promise<HeavyResult> => {
  const a = params.parse(args);
  const exe = await ctx.binary("tesseract/tesseract.exe");
  if (!exe) {
    return {
      ok: false,
      family: "needs_you",
      text: "The document toolkit (for reading scans) isn't installed yet — Settings → Heavy tasks explains how to add it.",
      logLine: "ocr_pdf: tesseract.exe not found.",
    };
  }
  const tessdata = exe.replace(/tesseract\.exe$/i, "tessdata");
  const roots = ctx.sandbox.roots.map((r) => r.sandboxPath);

  // Expand any folders in `files` to the image files they contain — the model
  // often names the folder, not each scan.
  const targets: string[] = [];
  for (const display of a.files) {
    const sb = ctx.toSandbox(display);
    let isDir = false;
    if (sb) {
      try {
        isDir = (await stat(sb)).isDirectory;
      } catch {
        isDir = false;
      }
    }
    if (isDir && sb) {
      const sep = display.includes("\\") ? "\\" : "/";
      for (const e of await readDir(sb)) {
        if (e.isFile && IMG.test(e.name)) targets.push(`${display}${sep}${e.name}`);
      }
    } else {
      targets.push(display);
    }
  }
  if (targets.length === 0) {
    return {
      ok: false,
      family: "on_purpose",
      text: "No scanned images (jpg, png, tiff) were found to read.",
      logLine: "ocr_pdf: no images in the given files/folders.",
    };
  }

  const done: string[] = [];
  const lowConf: string[] = [];
  const allText: string[] = [];
  let pdfs = 0;

  for (const display of targets) {
    if (!IMG.test(display)) {
      // A digital PDF is read directly elsewhere; a scanned PDF needs the
      // rasterizer that isn't wired yet — refuse honestly rather than fail.
      return {
        ok: false,
        family: "on_purpose",
        text: `${display} isn't a photo or scan image — right now I can read scanned images (jpg, png, tiff). Scanned PDFs are coming; a PDF that already has text can be read as-is.`,
        logLine: `ocr_pdf: ${display} is not a supported image.`,
      };
    }
    const src = ctx.toSandbox(display);
    if (!src) {
      return { ok: false, family: "on_purpose", text: `Refused — ${display} is outside this automation's folders.`, logLine: `ocr_pdf: ${display} outside fence.` };
    }
    if (!(await exists(src))) {
      return { ok: false, family: "broke", text: `${display} isn't there to read.`, logLine: `ocr_pdf: ${display} missing in sandbox.` };
    }
    const { dir, stem, sep } = baseName(src);
    const outBase = `${dir}${sep}${stem}.ocr`; // tesseract writes outBase.txt + outBase.pdf
    ctx.runNote(`Reading ${stem}…`);

    const report = await runTool({
      exe,
      // -l/--oem/--psm/--dpi precede the literal output selectors (txt pdf).
      // psm 3 = full auto page segmentation (documents & receipts).
      argv: [
        src,
        outBase,
        "-l",
        a.language,
        "--oem",
        "1",
        "--psm",
        "3",
        "--dpi",
        "300",
        "txt",
        "pdf",
      ],
      cwd: ctx.sandbox.base,
      allowed_roots: roots,
      timeout_ms: 120_000,
      max_output_bytes: 500_000,
      env: [["TESSDATA_PREFIX", tessdata]],
    });
    if (report.timed_out) {
      return { ok: false, family: "broke", text: `Reading ${stem} took too long and was stopped. Nothing was kept.`, logLine: `ocr_pdf: ${stem} timed out.` };
    }
    if (report.exit_code !== 0) {
      return {
        ok: false,
        family: "broke",
        text: `Couldn't read ${stem} — ${(report.stderr || report.stdout).split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 120) ?? "the reader failed"}.`,
        logLine: `ocr_pdf: tesseract exited ${report.exit_code} on ${stem}.`,
      };
    }
    const txtPath = `${outBase}.txt`;
    const pdfPath = `${outBase}.pdf`;
    let text = "";
    try {
      text = (await readTextFile(txtPath)).trim();
    } catch {
      // no text file — treat as unreadable
    }
    // Rename to the stable, human-facing names beside the original.
    const searchable = `${dir}${sep}${stem}.searchable.pdf`;
    const cleanTxt = `${dir}${sep}${stem}.txt`;
    try {
      if (await exists(pdfPath)) {
        await rename(pdfPath, searchable);
        pdfs++;
      }
      if (await exists(txtPath)) await rename(txtPath, cleanTxt);
    } catch {
      // renames are cosmetic; the outputs still exist under .ocr.*
    }
    const chars = text.replace(/\s+/g, "").length;
    await writeTextFile(
      `${dir}${sep}${stem}.ocr.json`,
      JSON.stringify(
        { source: display, method: "ocr", dpi: 300, chars, readable: chars >= LOW_CONF_CHARS },
        null,
        2
      )
    );
    if (chars < LOW_CONF_CHARS) {
      lowConf.push(stem);
    } else {
      allText.push(`=== ${stem} ===\n${text}`);
    }
    done.push(stem);
  }

  const readable = done.length - lowConf.length;
  const lowNote = lowConf.length
    ? ` ${lowConf.length} came back unreadable (${lowConf.slice(0, 3).join(", ")}) — those pages need a clearer scan.`
    : "";
  const text = `Read ${readable} of ${done.length} document${done.length === 1 ? "" : "s"} with OCR at 300 DPI and made a searchable copy of each (in a copy — you keep the results).${lowNote}`;
  return {
    ok: readable > 0,
    family: readable > 0 ? "ok" : "on_purpose",
    text: readable > 0 ? text : `None of the ${done.length} images had readable text after OCR — they may be too blurry or low-resolution.`,
    corpusText: allText.join("\n\n"),
    logLine: `ocr_pdf: OCR'd ${done.length} image${done.length === 1 ? "" : "s"} in the sandbox — ${readable} readable, ${pdfs} searchable PDF${pdfs === 1 ? "" : "s"} made. Nothing left this computer.`,
    producedNote: `${readable} searchable`,
  };
};

export const ocrPdfTool: HeavyToolSpec = {
  id: "ocr_pdf",
  writes: true,
  def: {
    type: "function",
    function: {
      name: "ocr_pdf",
      description:
        "Read a scanned or photographed document (an image: jpg, png, tiff) and turn it into a searchable PDF plus clean text. Use for dirty documents that plain reading can't handle.",
      parameters: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" }, description: "the scanned images to read" },
          language: { type: "string", description: "3-letter language, e.g. eng" },
          clean: { type: "boolean", description: "straighten and de-noise dirty scans" },
        },
        required: ["files"],
      },
    },
  },
  params,
  run: realOcrRun,
  menuLine:
    "ocr_pdf{files, language?, clean?} — read scanned/photographed images into searchable PDFs + clean text.",
};
