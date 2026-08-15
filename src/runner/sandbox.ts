// The sandbox: pre-flight walk, then copy the target folders to
// $APPDATA/sandbox/run-<id> — never inside the target. All writes hit the
// copy; Apply is the only code path that touches real files.
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir } from "@tauri-apps/plugin-fs";
import type { Catalog } from "../pipeline/catalog";

const SILENT_BYTES = 200 * 1024 * 1024; // 200 MB
const SILENT_FILES = 2000;
const REFUSE_BYTES = 1024 * 1024 * 1024; // 1 GB

export interface SandboxRoot {
  display: string; // "~/Downloads"
  real: string; // C:\Users\...\Downloads
  sandboxPath: string; // ...\sandbox\run-x\Downloads
}

export interface Sandbox {
  runId: string;
  base: string;
  roots: SandboxRoot[];
  preflightBytes: number;
  preflightFiles: number;
  copyNote: string | null; // "Copied only the N cataloged files — <folder> is X GB."
}

export class SandboxRefusal extends Error {
  constructor(public sentence: string) {
    super(sentence);
  }
}

interface WalkStats {
  bytes: number;
  files: number;
  capped: boolean;
}

function rootDisplays(reads: string[], writes: string[]): string[] {
  // Collapse file paths to their parent folder displays; keep folder targets.
  const roots = new Set<string>();
  for (const p of [...reads, ...writes]) {
    const isFile = /\.[A-Za-z0-9]+$/.test(p.split("/").pop() ?? "");
    roots.add(isFile ? p.split("/").slice(0, -1).join("/") : p);
  }
  return [...roots];
}

export async function buildSandbox(
  runId: string,
  reads: string[],
  writes: string[],
  catalog: Catalog
): Promise<Sandbox> {
  const base = await join(await appDataDir(), "sandbox", runId);
  await mkdir(base, { recursive: true });

  const roots: SandboxRoot[] = [];
  let totalBytes = 0;
  let totalFiles = 0;
  let copyNote: string | null = null;

  for (const display of rootDisplays(reads, writes)) {
    const real = catalog.displayToReal[display];
    if (!real) {
      throw new SandboxRefusal(
        `Couldn't find ${display} on this computer — the record names a folder that isn't here.`
      );
    }
    if (!(await exists(real))) {
      // Folder unreadable: refused before the run starts, naming the folder —
      // never an empty result pretending to be clean.
      throw new SandboxRefusal(
        `Couldn't read ${display} — the folder isn't there any more.`
      );
    }
    const label = display.split("/").filter(Boolean).pop() ?? "folder";
    const sandboxPath = await join(base, label);

    const stats = (await invoke("walk_stats", {
      path: real,
      maxFiles: SILENT_FILES,
      maxBytes: SILENT_BYTES,
    })) as WalkStats;

    if (!stats.capped) {
      // Small enough: copy the whole folder silently.
      totalBytes += stats.bytes;
      totalFiles += stats.files;
      await invoke("copy_dir", { src: real, dst: sandboxPath });
    } else {
      // Above the silent tier: copy only cataloged files, and say so.
      const catalogFiles = catalog.files.filter(
        (f) => f.folderDisplay === display
      );
      let catalogBytes = 0;
      for (const f of catalogFiles) {
        const s = (await invoke("walk_stats", {
          path: f.real,
          maxFiles: 1,
          maxBytes: REFUSE_BYTES,
        })) as WalkStats;
        catalogBytes += s.bytes;
      }
      if (catalogBytes > REFUSE_BYTES) {
        throw new SandboxRefusal(
          `${display} is too big to copy safely (over 1 GB even keeping only its documents) — point the automation at a smaller folder.`
        );
      }
      const full = (await invoke("walk_stats", {
        path: real,
        maxFiles: 1e9,
        maxBytes: Number.MAX_SAFE_INTEGER,
      })) as WalkStats;
      for (const f of catalogFiles) {
        await invoke("copy_dir", {
          src: f.real,
          dst: await join(sandboxPath, f.name),
        });
      }
      totalBytes += catalogBytes;
      totalFiles += catalogFiles.length;
      copyNote = `Copied only the ${catalogFiles.length} cataloged files — ${display} holds ${full.files.toLocaleString()} files (${(full.bytes / 1e9).toFixed(1)} GB).`;
      await mkdir(sandboxPath, { recursive: true }).catch(() => {});
    }
    roots.push({ display, real, sandboxPath });
  }

  return {
    runId,
    base,
    roots,
    preflightBytes: totalBytes,
    preflightFiles: totalFiles,
    copyNote,
  };
}

// Map a display path (the record's language) into the sandbox. Returns null
// if the path escapes every sandbox root — the fence says no.
export function toSandboxPath(sandbox: Sandbox, display: string): string | null {
  for (const root of sandbox.roots) {
    if (display === root.display) return root.sandboxPath;
    if (display.startsWith(root.display + "/")) {
      const rel = display.slice(root.display.length + 1);
      if (rel.includes("..")) return null;
      const sep = root.sandboxPath.includes("\\") ? "\\" : "/";
      return root.sandboxPath + sep + rel.replace(/\//g, sep);
    }
  }
  return null;
}

export function toRealPath(sandbox: Sandbox, display: string): string | null {
  for (const root of sandbox.roots) {
    if (display === root.display) return root.real;
    if (display.startsWith(root.display + "/")) {
      const rel = display.slice(root.display.length + 1);
      if (rel.includes("..")) return null;
      const sep = root.real.includes("\\") ? "\\" : "/";
      return root.real + sep + rel.replace(/\//g, sep);
    }
  }
  return null;
}
