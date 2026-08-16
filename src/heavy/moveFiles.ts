// move_files - move matching files between two approved folders. Every move
// happens inside the sandbox copy and becomes an added/deleted diff. Existing
// destination files are never overwritten; a numbered suffix is added.
import { exists, mkdir, readDir, rename } from "@tauri-apps/plugin-fs";
import { z } from "zod";
import type { HeavyContext, HeavyResult, HeavyToolSpec } from "./types";

const params = z.object({
  source_folder: z.string().min(1),
  destination_folder: z.string().min(1),
  find: z.string().max(200).default(""),
  only_extension: z
    .string()
    .regex(/^[a-z0-9]{1,8}$/i)
    .optional()
    .nullable(),
});

function separator(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? { base: name.slice(0, dot), ext: name.slice(dot) }
    : { base: name, ext: "" };
}

async function freeDestination(folder: string, name: string): Promise<string> {
  const sep = separator(folder);
  let candidate = `${folder}${sep}${name}`;
  if (!(await exists(candidate))) return candidate;
  const { base, ext } = splitExtension(name);
  for (let n = 2; n <= 999; n++) {
    candidate = `${folder}${sep}${base}-${n}${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`No free filename for ${name}`);
}

async function run(
  args: Record<string, unknown>,
  ctx: HeavyContext
): Promise<HeavyResult> {
  const parsed = params.parse(args);
  const source = ctx.toSandbox(parsed.source_folder);
  const destination = ctx.toSandbox(parsed.destination_folder);
  if (!source || !destination) {
    return {
      ok: false,
      family: "on_purpose",
      text: "Refused - the source or destination is outside this automation's folders.",
      logLine: "Refused move_files - a folder was outside the file fence.",
    };
  }
  if (source.toLowerCase() === destination.toLowerCase()) {
    return {
      ok: false,
      family: "on_purpose",
      text: "Move held back - the source and destination are the same folder.",
      logLine: "move_files held back - source equals destination.",
    };
  }
  if (!(await exists(source))) {
    return {
      ok: false,
      family: "broke",
      text: `${parsed.source_folder} is not there to move files from.`,
      logLine: "move_files broke - source folder missing in the sandbox.",
    };
  }
  await mkdir(destination, { recursive: true });

  const needle = parsed.find.toLowerCase();
  const extension = parsed.only_extension?.toLowerCase() ?? null;
  const entries = (await readDir(source))
    .filter((entry) => entry.isFile)
    .filter((entry) => !needle || entry.name.toLowerCase().includes(needle))
    .filter(
      (entry) =>
        !extension || entry.name.toLowerCase().endsWith(`.${extension}`)
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  if (entries.length === 0) {
    const text = `Moved nothing - no file in ${parsed.source_folder} matched.`;
    return { ok: true, family: "ok", text, corpusText: text, logLine: text };
  }

  const sep = separator(source);
  const moved: string[] = [];
  for (const entry of entries) {
    const target = await freeDestination(destination, entry.name);
    await rename(`${source}${sep}${entry.name}`, target);
    const targetName = target.split(/[\\/]/).pop() ?? entry.name;
    moved.push(
      `${parsed.source_folder}/${entry.name} -> ${parsed.destination_folder}/${targetName}`
    );
    ctx.runNote(`Moved ${moved.length} of ${entries.length}...`);
  }

  const preview =
    moved.slice(0, 8).join(", ") +
    (moved.length > 8 ? `, +${moved.length - 8} more` : "");
  return {
    ok: true,
    family: "ok",
    text: `Moved ${moved.length} file${moved.length === 1 ? "" : "s"} from ${parsed.source_folder} to ${parsed.destination_folder} in a copy: ${preview}`,
    corpusText: moved.join("\n"),
    logLine: `move_files: ${moved.length} file${moved.length === 1 ? "" : "s"} moved in the sandbox copy - nothing real changed until Keep.`,
    producedNote: `${moved.length} moved`,
  };
}

export const moveFilesTool: HeavyToolSpec = {
  id: "move_files",
  writes: true,
  def: {
    type: "function",
    function: {
      name: "move_files",
      description:
        "Move matching files from one approved folder to another inside a copy. Existing files are never overwritten.",
      parameters: {
        type: "object",
        properties: {
          source_folder: { type: "string" },
          destination_folder: { type: "string" },
          find: { type: "string", description: "optional text the filename must contain" },
          only_extension: { type: "string", description: "optional extension such as pdf" },
        },
        required: ["source_folder", "destination_folder"],
      },
    },
  },
  params,
  run,
  menuLine:
    "move_files{source_folder, destination_folder, find?, only_extension?} - move matching files between approved folders in the sandbox copy.",
};
