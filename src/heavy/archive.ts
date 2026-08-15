// zip_folder / unzip — pack or unpack archives with 7za (7-Zip, LGPL, bundled
// ~2 MB). Our code builds the argv; 7za runs in the sandbox. Extraction is
// checked for path traversal (zip-slip) by keeping the output inside the
// sandbox and letting run_tool's containment check refuse anything that
// escapes.
import { z } from "zod";
import { runTool } from "./runTool";
import type { HeavyContext, HeavyResult, HeavyToolSpec } from "./types";

const BIN = "7za.exe";

function missingBinary(verb: string): HeavyResult {
  return {
    ok: false,
    family: "needs_you",
    text: "The archive toolkit (7-Zip) isn't installed yet — Settings → Heavy tasks explains how to add it.",
    logLine: `Can't ${verb} — 7za.exe not found.`,
  };
}

// ---- zip_folder ----
const zipParams = z.object({
  folder: z.string().min(1),
  format: z.enum(["zip", "7z"]).default("zip"),
  into: z.string().min(1), // display path of the archive to create
});

async function runZip(args: Record<string, unknown>, ctx: HeavyContext): Promise<HeavyResult> {
  const a = zipParams.parse(args);
  const exe = await ctx.binary(BIN);
  if (!exe) return missingBinary("zip");
  const srcSb = ctx.toSandbox(a.folder);
  const outSb = ctx.toSandbox(a.into);
  if (!srcSb || !outSb) {
    return { ok: false, family: "on_purpose", text: `Refused — a path is outside this automation's folders.`, logLine: "zip_folder: path outside fence." };
  }
  ctx.runNote(`Zipping ${a.folder}…`);
  const report = await runTool({
    exe,
    // a = archive; the source folder as the last operand. -mx=5 = balanced.
    argv: ["a", `-t${a.format}`, "-mx=5", "-bd", outSb, srcSb],
    cwd: ctx.sandbox.base,
    allowed_roots: ctx.sandbox.roots.map((r) => r.sandboxPath),
    timeout_ms: 5 * 60 * 1000,
    max_output_bytes: 200_000,
  });
  if (report.timed_out) {
    return { ok: false, family: "broke", text: `Zipping ${a.folder} took too long and was stopped. Nothing was kept.`, logLine: "zip_folder timed out." };
  }
  if (report.exit_code !== 0) {
    return { ok: false, family: "broke", text: `Couldn't create the archive — ${(report.stderr || report.stdout).split("\n").slice(-2).join(" ").slice(0, 120)}`, logLine: `7za a exited ${report.exit_code}.` };
  }
  const line = `Packed ${a.folder} into ${a.into} (${a.format}) — in a copy; you keep it or discard it.`;
  return { ok: true, family: "ok", text: line, corpusText: line, logLine: `zip_folder: created ${a.into} in the sandbox. Nothing left this computer.`, producedNote: a.into };
}

export const zipFolderTool: HeavyToolSpec = {
  id: "zip_folder",
  writes: true,
  def: {
    type: "function",
    function: {
      name: "zip_folder",
      description: "Pack a folder into a zip or 7z archive inside the automation's folders.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string" },
          format: { type: "string", enum: ["zip", "7z"] },
          into: { type: "string", description: "archive file to create, e.g. ~/Documents/invoices.zip" },
        },
        required: ["folder", "into"],
      },
    },
  },
  params: zipParams,
  run: runZip,
  menuLine: "zip_folder{folder, format: zip|7z, into} — pack a folder into an archive.",
};

// ---- unzip ----
const unzipParams = z.object({
  file: z.string().min(1),
  into: z.string().min(1),
});

async function runUnzip(args: Record<string, unknown>, ctx: HeavyContext): Promise<HeavyResult> {
  const a = unzipParams.parse(args);
  const exe = await ctx.binary(BIN);
  if (!exe) return missingBinary("unzip");
  const fileSb = ctx.toSandbox(a.file);
  const intoSb = ctx.toSandbox(a.into);
  if (!fileSb || !intoSb) {
    return { ok: false, family: "on_purpose", text: `Refused — a path is outside this automation's folders.`, logLine: "unzip: path outside fence." };
  }
  ctx.runNote(`Unpacking ${a.file}…`);
  const report = await runTool({
    exe,
    // x = extract with paths; -o = output dir; -y = assume yes. run_tool's
    // containment check refuses any entry that would escape the sandbox.
    argv: ["x", fileSb, `-o${intoSb}`, "-y", "-bd"],
    cwd: ctx.sandbox.base,
    allowed_roots: ctx.sandbox.roots.map((r) => r.sandboxPath),
    timeout_ms: 5 * 60 * 1000,
    max_output_bytes: 200_000,
  });
  if (report.timed_out) {
    return { ok: false, family: "broke", text: `Unpacking ${a.file} took too long and was stopped.`, logLine: "unzip timed out." };
  }
  if (report.exit_code !== 0) {
    return { ok: false, family: "broke", text: `Couldn't unpack the archive — ${(report.stderr || report.stdout).split("\n").slice(-2).join(" ").slice(0, 120)}`, logLine: `7za x exited ${report.exit_code}.` };
  }
  const line = `Unpacked ${a.file} into ${a.into} — in a copy; you keep it or discard it.`;
  return { ok: true, family: "ok", text: line, corpusText: line, logLine: `unzip: extracted ${a.file} in the sandbox.`, producedNote: a.into };
}

export const unzipTool: HeavyToolSpec = {
  id: "unzip",
  writes: true,
  def: {
    type: "function",
    function: {
      name: "unzip",
      description: "Unpack a zip or 7z archive into a folder inside the automation's folders.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string" },
          into: { type: "string", description: "folder to extract into" },
        },
        required: ["file", "into"],
      },
    },
  },
  params: unzipParams,
  run: runUnzip,
  menuLine: "unzip{file, into} — unpack an archive into a folder.",
};
