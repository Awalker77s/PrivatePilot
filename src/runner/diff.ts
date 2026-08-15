// The diff card's data: added / changed / deleted between the sandbox copy
// and the real folder (dir-compare semantics: compareSize, then
// compareContent), with before/after hunks for text files under 256 KB.
// Apply is the only code path that touches real files, and even Keep is
// undoable — the old version moves to <target>/.pilot-versions/<runId>/.
import { structuredPatch } from "diff";
import {
  exists,
  mkdir,
  readDir,
  readFile,
  remove,
  rename,
} from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import type { DiffEntry, RunDiff } from "../storage/types";
import { Sandbox, toRealPath } from "./sandbox";
import { readAnyFile } from "./readFile";

const HUNK_MAX_BYTES = 256 * 1024;

interface FileMeta {
  rel: string; // display-relative path e.g. "~/Documents/invoices-2026.xlsx"
  abs: string;
  size: number;
}

async function walkFiles(
  root: string,
  displayRoot: string
): Promise<FileMeta[]> {
  const out: FileMeta[] = [];
  async function rec(dir: string, displayDir: string): Promise<void> {
    if (!(await exists(dir))) return;
    for (const e of await readDir(dir)) {
      if (e.name === ".pilot-versions") continue;
      const abs = `${dir}${dir.includes("\\") ? "\\" : "/"}${e.name}`;
      const display = `${displayDir}/${e.name}`;
      if (e.isDirectory) await rec(abs, display);
      else if (e.isFile) {
        const stats = (await invoke("walk_stats", {
          path: abs,
          maxFiles: 2,
          maxBytes: Number.MAX_SAFE_INTEGER,
        })) as { bytes: number };
        out.push({ rel: display, abs, size: stats.bytes });
      }
    }
  }
  await rec(root, displayRoot);
  return out;
}

function isTextFormat(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ["txt", "md", "csv", "tsv", "json", "log", "html", "htm", "xlsx", "xlsm"].includes(ext);
}

async function textOf(abs: string): Promise<string> {
  const r = await readAnyFile(abs);
  return r.text;
}

async function bytesEqual(a: string, b: string): Promise<boolean> {
  const [ba, bb] = await Promise.all([readFile(a), readFile(b)]);
  if (ba.length !== bb.length) return false;
  for (let i = 0; i < ba.length; i++) if (ba[i] !== bb[i]) return false;
  return true;
}

function renderHunks(
  rel: string,
  before: string,
  after: string
): { hunks: string | null; note: string | null } {
  try {
    const patch = structuredPatch(rel, rel, before, after, "", "", {
      context: 2,
      maxEditLength: 2000,
    });
    if (!patch || !patch.hunks) {
      return { hunks: null, note: "changed (too different to preview)" };
    }
    const lines: string[] = [];
    for (const h of patch.hunks) {
      lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
      lines.push(...h.lines);
    }
    return { hunks: lines.join("\n"), note: null };
  } catch {
    return { hunks: null, note: "changed (too different to preview)" };
  }
}

export async function scanDiff(sandbox: Sandbox): Promise<RunDiff> {
  const entries: DiffEntry[] = [];

  for (const root of sandbox.roots) {
    const sbFiles = await walkFiles(root.sandboxPath, root.display);
    const realFiles = await walkFiles(root.real, root.display);
    const sbByRel = new Map(sbFiles.map((f) => [f.rel, f]));
    const realByRel = new Map(realFiles.map((f) => [f.rel, f]));
    // With a cataloged-only copy the real side is compared only where the
    // sandbox has a counterpart — uncopied files can't honestly be "deleted".
    const partialCopy = sandbox.copyNote !== null;

    for (const sb of sbFiles) {
      const real = realByRel.get(sb.rel);
      if (!real) {
        entries.push({
          relPath: sb.rel,
          kind: "added",
          hunks: isTextFormat(sb.rel) && sb.size < HUNK_MAX_BYTES
            ? renderHunks(sb.rel, "", await textOf(sb.abs)).hunks
            : null,
          note: null,
          kept: true,
        });
      } else if (sb.size !== real.size || !(await bytesEqual(sb.abs, real.abs))) {
        const canHunk =
          isTextFormat(sb.rel) &&
          sb.size < HUNK_MAX_BYTES &&
          real.size < HUNK_MAX_BYTES;
        const h = canHunk
          ? renderHunks(sb.rel, await textOf(real.abs), await textOf(sb.abs))
          : { hunks: null, note: "changed (binary — no preview)" };
        entries.push({
          relPath: sb.rel,
          kind: "changed",
          hunks: h.hunks,
          note: h.note,
          kept: true,
        });
      }
    }
    for (const real of realFiles) {
      if (!sbByRel.has(real.rel) && !partialCopy) {
        entries.push({
          relPath: real.rel,
          kind: "deleted",
          hunks: null,
          note: null,
          kept: true,
        });
      }
    }
  }

  const added = entries.filter((e) => e.kind === "added").length;
  const changed = entries.filter((e) => e.kind === "changed").length;
  const deleted = entries.filter((e) => e.kind === "deleted").length;
  return {
    entries,
    applied: false,
    appliedAt: null,
    headline:
      entries.length === 0
        ? "Changed nothing — your files are exactly as they were."
        : `Changed ${changed} file${changed === 1 ? "" : "s"}, added ${added}, deleted ${deleted} — in a copy. Your real folder hasn't been touched.`,
  };
}

// Keep: apply the kept entries to the real folder. The old version of every
// touched file moves to <its folder>/.pilot-versions/<runId>/ first — a free
// same-filesystem rename — so even Keep is one click from undone.
export async function applyDiff(
  sandbox: Sandbox,
  diff: RunDiff
): Promise<{ applied: number; sentence: string }> {
  let applied = 0;
  for (const entry of diff.entries) {
    if (!entry.kept) continue;
    const sb = sandboxAbs(sandbox, entry.relPath);
    const real = toRealPath(sandbox, entry.relPath);
    if (!real) continue;
    const dir = real.replace(/[\\/][^\\/]+$/, "");
    const name = real.split(/[\\/]/).pop()!;
    const versionDir = `${dir}${dir.includes("\\") ? "\\" : "/"}.pilot-versions${dir.includes("\\") ? "\\" : "/"}${sandbox.runId}`;

    if (entry.kind === "added" && sb) {
      await invoke("copy_dir", { src: sb, dst: real });
      applied++;
    } else if (entry.kind === "changed" && sb) {
      await mkdir(versionDir, { recursive: true });
      await rename(real, `${versionDir}${versionDir.includes("\\") ? "\\" : "/"}${name}`);
      await invoke("copy_dir", { src: sb, dst: real });
      applied++;
    } else if (entry.kind === "deleted") {
      await mkdir(versionDir, { recursive: true });
      await rename(real, `${versionDir}${versionDir.includes("\\") ? "\\" : "/"}${name}`);
      applied++;
    }
  }
  diff.applied = true;
  diff.appliedAt = Date.now();
  return {
    applied,
    sentence: `Put it back the way it was ›`,
  };
}

// Put it back: reverse an applied diff from .pilot-versions.
export async function putBack(
  sandbox: Sandbox,
  diff: RunDiff
): Promise<number> {
  let restored = 0;
  for (const entry of diff.entries) {
    if (!entry.kept) continue;
    const real = toRealPath(sandbox, entry.relPath);
    if (!real) continue;
    const dir = real.replace(/[\\/][^\\/]+$/, "");
    const sep = dir.includes("\\") ? "\\" : "/";
    const name = real.split(/[\\/]/).pop()!;
    const versioned = `${dir}${sep}.pilot-versions${sep}${sandbox.runId}${sep}${name}`;

    if (entry.kind === "added") {
      if (await exists(real)) {
        await remove(real);
        restored++;
      }
    } else if (await exists(versioned)) {
      if (await exists(real)) await remove(real);
      await rename(versioned, real);
      restored++;
    }
  }
  diff.applied = false;
  return restored;
}

function sandboxAbs(sandbox: Sandbox, display: string): string | null {
  for (const root of sandbox.roots) {
    if (display.startsWith(root.display + "/")) {
      const rel = display.slice(root.display.length + 1);
      const sep = root.sandboxPath.includes("\\") ? "\\" : "/";
      return root.sandboxPath + sep + rel.replace(/\//g, sep);
    }
  }
  return null;
}
