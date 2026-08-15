// ocr_pdf — turn a scanned/photographed (image-only) PDF or image into a
// SEARCHABLE PDF plus clean text, so dirty documents become both readable and
// indexable (see the RAG layer). Backed by Tesseract (Apache 2.0) with a
// rasterizer for PDFs. The exact binary pipeline is finalized against the
// research; until the toolkit is present this returns the "get the toolkit"
// sentence rather than failing silently.
import { z } from "zod";
import type { HeavyContext, HeavyResult, HeavyToolSpec } from "./types";

const params = z.object({
  files: z.array(z.string().min(1)).min(1),
  language: z.string().regex(/^[a-z]{3}(\+[a-z]{3})*$/).default("eng"),
  clean: z.coerce.boolean().default(true), // deskew/denoise dirty scans
});

// Filled in once the OCR pipeline lands (rasterize → tesseract → merge).
export let ocrRun: (
  args: Record<string, unknown>,
  ctx: HeavyContext
) => Promise<HeavyResult> = async (_args, ctx) => {
  const tess = await ctx.binary("tesseract.exe");
  if (!tess) {
    return {
      ok: false,
      family: "needs_you",
      text: "The document toolkit (for reading scans) isn't installed yet — Settings → Heavy tasks explains how to add it.",
      logLine: "ocr_pdf: tesseract.exe not found.",
    };
  }
  return {
    ok: false,
    family: "broke",
    text: "The document reader isn't finished wiring up yet.",
    logLine: "ocr_pdf: pipeline not yet implemented.",
  };
};

export function setOcrRun(fn: typeof ocrRun): void {
  ocrRun = fn;
}

export const ocrPdfTool: HeavyToolSpec = {
  id: "ocr_pdf",
  writes: true,
  def: {
    type: "function",
    function: {
      name: "ocr_pdf",
      description:
        "Read a scanned or photographed document (image-only PDF, or a photo) and turn it into a searchable PDF plus clean text. Use for dirty documents that plain reading can't handle.",
      parameters: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" }, description: "the PDFs/images to read" },
          language: { type: "string", description: "3-letter language, e.g. eng" },
          clean: { type: "boolean", description: "straighten and de-noise dirty scans" },
        },
        required: ["files"],
      },
    },
  },
  params,
  run: (args, ctx) => ocrRun(args, ctx),
  menuLine:
    "ocr_pdf{files, language?, clean?} — read scanned/photographed documents into searchable PDFs + clean text.",
};
