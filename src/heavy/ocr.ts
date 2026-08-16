// ocr_pdf — turn a scanned or photographed document into a SEARCHABLE PDF
// plus clean text, so a dirty document becomes both readable and indexable
// (the RAG layer embeds the text). Backed by Tesseract (Apache 2.0); our code
// builds the argv and appends the literal `txt pdf` output selectors, so the
// model never composes a command. Runs in the sandbox via run_tool.
//
// Images (jpg/png/tiff/webp/bmp) go to Tesseract directly. PDFs branch: one
// that already has a text layer is indexed as-is (no OCR — native text beats
// OCR); an image-only scan is rasterized to 300-DPI page PNGs by pdfium
// (rasterize_pdf, Rust) and Tesseract reads the page list into ONE multi-page
// searchable PDF.
import { readTextFile, writeTextFile, rename, exists, readDir, stat } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { runTool, findBinary } from "./runTool";
import { readAnyFile } from "../runner/readFile";
import type { HeavyContext, HeavyResult, HeavyToolSpec } from "./types";

const IMG = /\.(png|jpe?g|tiff?|bmp|webp)$/i;
const PDF = /\.pdf$/i;
const READABLE = /\.(txt|md|markdown|csv|tsv|json|ya?ml|log|html?|docx|xlsx|xlsm|rtf)$/i;
const LOW_CONF_CHARS = 20; // below this, a page came back unreadable — say so
const DIGITAL_PDF_CHARS = 100; // per-doc chars above which a PDF already has text

const params = z.object({
  files: z.array(z.string().min(1)).min(1),
  language: z.string().regex(/^[a-z]{3}(\+[a-z]{3})*$/).default("eng"),
  clean: z.coerce.boolean().default(true),
});

// If a PDF already carries a real text layer, return that text (skip OCR —
// native text beats OCR and OCR-ing it is wasted minutes). Returns null when
// it's image-only (a scan) and must be OCR'd.
async function pdfTextIfDigital(sandboxPath: string): Promise<string | null> {
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const { extractText, getDocumentProxy } = await import("unpdf");
    const bytes = await readFile(sandboxPath);
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    // Per-PAGE, not per-document: a 10-page scan with one digital cover sheet
    // must NOT be declared "digital" on the cover's text alone (that skipped
    // OCR for every scanned page). Require MOST pages to carry real text.
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    const withText = pages.filter(
      (p) => (p ?? "").replace(/\s+/g, "").length >= DIGITAL_PDF_CHARS
    ).length;
    // A truly digital PDF has text on (nearly) every page. A scan with a stray
    // text page does not clear this bar, so it goes to OCR.
    if (pages.length > 0 && withText >= Math.ceil(pages.length * 0.8)) {
      return pages.join("\n").trim();
    }
    return null;
  } catch {
    // Unreadable as a text PDF → treat as scanned.
    return null;
  }
}

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

  // Expand any folders in `files` to the images AND PDFs they contain — the
  // model often names the folder, not each scan.
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
      // Everything the app can READ belongs in a knowledge base, not just
      // the things that need OCR — a folder of notes and spreadsheets was
      // filed as an empty base before this.
      for (const e of await readDir(sb)) {
        if (e.isFile && (IMG.test(e.name) || PDF.test(e.name) || READABLE.test(e.name)))
          targets.push(`${display}${sep}${e.name}`);
      }
    } else {
      targets.push(display);
    }
  }
  if (targets.length === 0) {
    return {
      ok: false,
      family: "on_purpose",
      text: "No documents were found to read in those folders.",
      logLine: "ocr_pdf: no images/PDFs in the given files/folders.",
    };
  }

  const done: string[] = [];
  const lowConf: string[] = [];
  const allText: string[] = [];
  let pdfs = 0;
  let digitalCount = 0; // PDFs that already had text — no OCR ran on these
  const pdfiumDll = await findBinary("pdfium.dll");
  // Two inputs with the same stem but different extensions (invoice.pdf +
  // invoice.jpg) would both write invoice.txt and clobber each other. Track
  // used output stems and disambiguate with the source extension.
  const usedStems = new Set<string>();
  // One unreadable document must not sink a whole folder. A corrupt or
  // truncated PDF among fifty good ones used to abort the run and file
  // nothing — the batch now steps over it and says so at the end.
  const skipped: string[] = [];

  for (const display of targets) {
    if (!IMG.test(display) && !PDF.test(display)) {
      // A folder holds notes and spreadsheets as well as scans. These need
      // no OCR — they already ARE text — but they were being dropped, so
      // "file this folder into a knowledge base" quietly indexed only the
      // pictures and then answered "I couldn't find that in your documents"
      // about a note sitting right there. Read them straight in.
      const plain = ctx.toSandbox(display);
      if (!plain) {
        skipped.push(`${display} is outside this automation's folders`);
        continue;
      }
      try {
        const read = await readAnyFile(plain);
        const words = read.text.trim();
        if (!words) {
          skipped.push(`${display} had no readable text`);
          continue;
        }
        const label = display.split("/").pop() ?? display;
        allText.push(`=== ${label} ===
${words}`);
        // Write the text out beside the original, the same way OCR does:
        // filing into a knowledge base indexes the .txt files a run KEEPS,
        // so a document with no .txt was read and then silently dropped.
        const { dir: tdir, stem: tstem, sep: tsep } = baseName(plain);
        if (!/\.txt$/i.test(plain)) {
          await writeTextFile(`${tdir}${tsep}${tstem}.txt`, words);
        }
        digitalCount++;
        done.push(label);
        ctx.runNote(`Read ${label} — already text, no scan needed.`);
      } catch (error) {
        skipped.push(`${display} — ${String(error).slice(0, 70)}`);
      }
      continue;
    }
    const src = ctx.toSandbox(display);
    if (!src) {
      return { ok: false, family: "on_purpose", text: `Refused — ${display} is outside this automation's folders.`, logLine: `ocr_pdf: ${display} outside fence.` };
    }
    if (!(await exists(src))) {
      skipped.push(`${display} isn't there to read`);
      continue;
    }
    const { dir, stem: rawStem, sep } = baseName(src);
    // Disambiguate a colliding stem with the source extension (invoice-pdf,
    // invoice-jpg) so each document's outputs are distinct.
    const srcExt = (display.split(".").pop() ?? "").toLowerCase();
    let stem = rawStem;
    if (usedStems.has(stem.toLowerCase())) stem = `${rawStem}-${srcExt}`;
    let bump = 2;
    while (usedStems.has(stem.toLowerCase())) stem = `${rawStem}-${srcExt}-${bump++}`;
    usedStems.add(stem.toLowerCase());
    const outBase = `${dir}${sep}${stem}.ocr`; // tesseract writes outBase.txt + outBase.pdf

    // The images Tesseract will read: the file itself, or the rasterized pages
    // of a scanned PDF. A PDF that already has a text layer skips OCR.
    let pageImages: string[] = [src];
    if (PDF.test(display)) {
      const digital = await pdfTextIfDigital(src);
      if (digital !== null) {
        // Already searchable — index its own text, no OCR, no new PDF.
        allText.push(`=== ${stem} ===\n${digital}`);
        await writeTextFile(`${dir}${sep}${stem}.txt`, digital);
        await writeTextFile(
          `${dir}${sep}${stem}.ocr.json`,
          JSON.stringify({ source: display, method: "digital", chars: digital.replace(/\s+/g, "").length, readable: true }, null, 2)
        );
        done.push(stem);
        digitalCount++;
        ctx.runNote(`${stem} already has text — indexed directly.`);
        continue;
      }
      if (!pdfiumDll) {
        return {
          ok: false,
          family: "needs_you",
          text: "Reading a scanned PDF needs the PDF toolkit (pdfium) — Settings → Heavy tasks explains how to add it.",
          logLine: "ocr_pdf: pdfium.dll not found for a scanned PDF.",
        };
      }
      ctx.runNote(`Rendering the pages of ${stem}…`);
      try {
        pageImages = (await invoke("rasterize_pdf", {
          dllPath: pdfiumDll,
          pdfPath: src,
          dpi: 300,
          outDir: `${dir}${sep}${stem}-pages`,
        })) as string[];
      } catch (e) {
        skipped.push(`${stem} — ${String(e).slice(0, 80)}`);
        ctx.runNote(`Skipped ${stem} — its pages wouldn't render.`);
        continue;
      }
    }
    ctx.runNote(`Reading ${stem}…`);

    // Tesseract accepts an image-list file → one multi-page searchable PDF.
    let imageArg = pageImages[0];
    if (pageImages.length > 1) {
      const listPath = `${dir}${sep}${stem}.pagelist.txt`;
      await writeTextFile(listPath, pageImages.join("\n"));
      imageArg = listPath;
    }
    const report = await runTool({
      exe,
      // -l/--oem/--psm/--dpi precede the literal output selectors (txt pdf).
      argv: [
        imageArg,
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
      timeout_ms: 60_000 * Math.max(1, pageImages.length),
      max_output_bytes: 1_000_000,
      env: [["TESSDATA_PREFIX", tessdata]],
    });
    if (report.timed_out) {
      skipped.push(`${stem} took too long to read`);
      continue;
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
  // Say which documents were stepped over and why — a silent skip is the
  // one outcome worse than stopping.
  const skipNote = skipped.length
    ? ` Skipped ${skipped.length}: ${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? "…" : ""}.`
    : "";
  const ocrCount = readable - digitalCount;
  // Say what actually happened — OCR only where a scan was read, and "already
  // had text" for the digital PDFs (no 300-DPI pass, no searchable copy made).
  let text: string;
  if (ocrCount > 0 && digitalCount > 0) {
    text = `Read ${readable} of ${done.length} documents — ${ocrCount} scanned with OCR at 300 DPI (searchable copies made), ${digitalCount} already had text (indexed as-is).${lowNote}${skipNote} Everything's in a copy — you keep the results.`;
  } else if (ocrCount > 0) {
    text = `Read ${ocrCount} of ${done.length} document${done.length === 1 ? "" : "s"} with OCR at 300 DPI and made a searchable copy of each (in a copy — you keep the results).${lowNote}${skipNote}`;
  } else {
    text = `${digitalCount} document${digitalCount === 1 ? "" : "s"} already had text — indexed as-is, no OCR needed (in a copy — you keep the results).${lowNote}${skipNote}`;
  }
  return {
    ok: readable > 0,
    family: readable > 0 ? "ok" : "on_purpose",
    text:
      readable > 0
        ? text
        : done.length === 0 && skipped.length > 0
          ? `Couldn't read any of these documents. ${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? "…" : ""}.`
          : `None of the ${done.length} images had readable text after OCR — they may be too blurry or low-resolution.`,
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
        "Read a scanned or photographed document (an image — jpg, png, tiff — or a scanned PDF) and turn it into a searchable PDF plus clean text. A PDF that already has text is used as-is. Use for dirty documents that plain reading can't handle.",
      parameters: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" }, description: "the scanned images or PDFs to read (or a folder of them)" },
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
