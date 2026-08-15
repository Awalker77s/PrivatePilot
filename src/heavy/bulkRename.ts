// bulk_rename — rename many files at once. Pure TypeScript: it renames files
// INSIDE the sandbox copy, so the diff card previews every old→new name and
// nothing touches real files until Keep. No binary, no shell, no network.
import { readDir, rename, exists } from "@tauri-apps/plugin-fs";
import { z } from "zod";
import type { HeavyContext, HeavyResult, HeavyToolSpec } from "./types";

const params = z.object({
  folder: z.string().min(1),
  find: z.string().default(""),
  replace_with: z.string().default("{name}{ext}"),
  use_regex: z.coerce.boolean().default(false),
  only_extension: z
    .string()
    .regex(/^[a-z0-9]{1,8}$/i)
    .optional()
    .nullable(),
});

function sep(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

async function run(
  args: Record<string, unknown>,
  ctx: HeavyContext
): Promise<HeavyResult> {
  const a = params.parse(args);
  const folderSb = ctx.toSandbox(a.folder);
  if (!folderSb) {
    return {
      ok: false,
      family: "on_purpose",
      text: `Refused — ${a.folder} is outside this automation's folders.`,
      logLine: `Refused bulk_rename — ${a.folder} is outside the fence.`,
    };
  }
  if (!(await exists(folderSb))) {
    return {
      ok: false,
      family: "broke",
      text: `${a.folder} isn't there to rename in.`,
      logLine: `bulk_rename: ${a.folder} missing in the sandbox.`,
    };
  }

  // Match files. A literal `find` is the default; use_regex opts into a
  // size-capped regex (a runaway pattern can't hang the UI).
  let matcher: (name: string) => boolean;
  let regex: RegExp | null = null;
  if (a.use_regex) {
    if (a.find.length > 200) {
      return { ok: false, family: "on_purpose", text: "That search pattern is too long.", logLine: "bulk_rename: pattern too long." };
    }
    try {
      regex = new RegExp(a.find, "i");
    } catch {
      return { ok: false, family: "on_purpose", text: `"${a.find}" isn't a valid search pattern.`, logLine: "bulk_rename: bad regex." };
    }
    matcher = (name) => regex!.test(name);
  } else {
    const needle = a.find.toLowerCase();
    matcher = (name) => needle === "" || name.toLowerCase().includes(needle);
  }

  const entries = (await readDir(folderSb)).filter((e) => e.isFile);
  const ext = a.only_extension?.toLowerCase();
  const targets = entries.filter((e) => {
    if (!matcher(e.name)) return false;
    if (ext && !e.name.toLowerCase().endsWith(`.${ext}`)) return false;
    return true;
  });
  if (targets.length === 0) {
    const t = `Renamed nothing — no file matched${a.find ? ` "${a.find}"` : ""}${ext ? ` .${ext}` : ""}.`;
    return { ok: true, family: "ok", text: t, corpusText: t, logLine: t };
  }

  const s = sep(folderSb);
  const pad = String(targets.length).length;
  const renames: string[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const e of targets.sort((x, y) => x.name.localeCompare(y.name))) {
    n++;
    const dot = e.name.lastIndexOf(".");
    const base = dot > 0 ? e.name.slice(0, dot) : e.name;
    const dotExt = dot > 0 ? e.name.slice(dot) : "";
    let out = a.replace_with
      .replace(/\{n\}/g, String(n).padStart(pad, "0"))
      .replace(/\{name\}/g, base)
      .replace(/\{ext\}/g, dotExt);
    if (regex) out = e.name.replace(regex, a.replace_with.replace(/\{n\}/g, String(n).padStart(pad, "0")));
    // Never let a rename escape the folder or collide.
    out = out.replace(/[\\/:*?"<>|]/g, "_").trim();
    if (!out || /^(con|nul|prn|aux|com[1-9]|lpt[1-9])$/i.test(out.split(".")[0])) out = `file-${n}${dotExt}`;
    if (seen.has(out.toLowerCase()) || out === e.name) {
      if (out === e.name) continue; // no-op rename, skip silently
      out = `${base}-${n}${dotExt}`;
    }
    seen.add(out.toLowerCase());
    try {
      await rename(`${folderSb}${s}${e.name}`, `${folderSb}${s}${out}`);
      renames.push(`${e.name} → ${out}`);
    } catch (err) {
      return {
        ok: false,
        family: "broke",
        text: `Couldn't rename ${e.name} — ${String(err).slice(0, 60)}. Stopped; earlier renames are in the copy for you to keep or discard.`,
        logLine: `bulk_rename broke on ${e.name}.`,
      };
    }
    ctx.runNote(`Renamed ${renames.length} of ${targets.length}…`);
  }

  const preview = renames.slice(0, 8).join(", ") + (renames.length > 8 ? `, +${renames.length - 8} more` : "");
  return {
    ok: true,
    family: "ok",
    text: `Renamed ${renames.length} file${renames.length === 1 ? "" : "s"} in ${a.folder} (in a copy — you keep the results): ${preview}`,
    corpusText: renames.join("\n"),
    logLine: `bulk_rename: ${renames.length} file${renames.length === 1 ? "" : "s"} renamed in the sandbox copy — nothing real changed until Keep.`,
    producedNote: `${renames.length} renamed`,
  };
}

export const bulkRenameTool: HeavyToolSpec = {
  id: "bulk_rename",
  writes: true,
  def: {
    type: "function",
    function: {
      name: "bulk_rename",
      description:
        "Rename many files at once in one of the automation's folders. Every rename is previewed in a copy before it's kept. Use {n} for a number, {name} for the original name, {ext} for the extension.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "a folder in the automation's files" },
          find: { type: "string", description: "text the filename must contain (or a pattern if use_regex)" },
          replace_with: { type: "string", description: "new name, e.g. 'Sicily-{n}{ext}' or 'invoice-{name}{ext}'" },
          use_regex: { type: "boolean" },
          only_extension: { type: "string", description: "limit to one extension, e.g. 'jpg'" },
        },
        required: ["folder", "replace_with"],
      },
    },
  },
  params,
  run,
  menuLine:
    "bulk_rename{folder, find, replace_with, use_regex?, only_extension?} — rename many files at once; every rename previewed before Keep.",
};
