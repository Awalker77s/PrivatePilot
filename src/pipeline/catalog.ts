// The closed catalog: at compile time, list the real files and existing
// automations, then build the schema dynamically — the model literally
// cannot draft a file that doesn't exist.
import {
  desktopDir,
  documentDir,
  downloadDir,
  join,
} from "@tauri-apps/api/path";
import { readDir } from "@tauri-apps/plugin-fs";
import { getState } from "../storage/stores";
import { getSettings, loadSettings } from "../storage/settings";
import { connectorStatuses, ConnectorSnapshot } from "../connectors/registry";

export interface CatalogFile {
  display: string; // "~/Downloads/invoice-jan.pdf" — what records store
  real: string; // absolute path
  name: string;
  ext: string;
  folderDisplay: string; // "~/Downloads"
}

export interface CatalogFolder {
  display: string;
  real: string;
  label: string; // "Downloads"
  readable: boolean; // false = designed "Folder unreadable" state
}

export interface Catalog {
  folders: CatalogFolder[];
  files: CatalogFile[];
  automationNames: string[];
  readTargets: string[]; // folder + file displays — the reads enum
  writeTargets: string[];
  displayToReal: Record<string, string>;
  // Apps automations can look into, with live status — the drafter's menu.
  apps: ConnectorSnapshot[];
}

const MAX_FILES_PER_FOLDER = 250;
// Total cap across all folders: the paths live twice in the drafting call
// (schema enum + prompt copy of the schema), and drafting has a fixed 16k
// context — an oversized catalog silently truncates the draft mid-JSON.
const MAX_FILES_TOTAL = 150;

const FORMAT_BY_EXT: Record<string, string> = {
  pdf: "pdf",
  xlsx: "xlsx",
  xlsm: "xlsx",
  csv: "csv",
  tsv: "csv",
  txt: "text",
  md: "text",
  log: "text",
  json: "json",
  docx: "docx",
  html: "text",
  htm: "text",
};

export function formatForPath(display: string): string {
  const ext = display.split(".").pop()?.toLowerCase() ?? "";
  return FORMAT_BY_EXT[ext] ?? "text";
}

export async function buildCatalog(): Promise<Catalog> {
  await loadSettings();
  const folderSpecs: { label: string; real: string; display: string }[] = [];

  const tryDir = async (
    label: string,
    getter: () => Promise<string>
  ): Promise<void> => {
    try {
      const real = await getter();
      folderSpecs.push({
        label,
        real: real.replace(/[\\/]+$/, ""),
        display: `~/${label}`,
      });
    } catch {
      // folder genuinely unavailable on this machine — simply absent
    }
  };

  await tryDir("Downloads", downloadDir);
  await tryDir("Documents", documentDir);
  await tryDir("Desktop", desktopDir);
  for (const picked of getSettings().pickedFolders) {
    const name = picked.split(/[\\/]/).filter(Boolean).pop() ?? picked;
    folderSpecs.push({ label: name, real: picked, display: `~/…/${name}` });
  }

  const folders: CatalogFolder[] = [];
  const files: CatalogFile[] = [];
  const displayToReal: Record<string, string> = {};
  const perFolder: CatalogFile[][] = [];

  for (const spec of folderSpecs) {
    let readable = true;
    const bucket: CatalogFile[] = [];
    try {
      const entries = await readDir(spec.real);
      for (const e of entries) {
        if (!e.isFile) continue;
        if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;
        // Only formats the runner can actually read — images and binaries
        // would bloat the closed enum without being automatable targets.
        const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
        if (!(ext in FORMAT_BY_EXT)) continue;
        if (bucket.length >= MAX_FILES_PER_FOLDER) break;
        const display = `${spec.display}/${e.name}`;
        const real = await join(spec.real, e.name);
        bucket.push({
          display,
          real,
          name: e.name,
          ext,
          folderDisplay: spec.display,
        });
      }
    } catch {
      readable = false; // surfaced as the "Folder unreadable" designed state
    }
    perFolder.push(bucket);
    folders.push({
      display: spec.display,
      real: spec.real,
      label: spec.label,
      readable,
    });
    displayToReal[spec.display] = spec.real;
  }

  // Round-robin across folders up to the total cap — a crowded Downloads
  // must not starve Documents out of the closed enum.
  for (let i = 0; files.length < MAX_FILES_TOTAL; i++) {
    let any = false;
    for (const bucket of perFolder) {
      if (i < bucket.length && files.length < MAX_FILES_TOTAL) {
        files.push(bucket[i]);
        displayToReal[bucket[i].display] = bucket[i].real;
        any = true;
      }
    }
    if (!any) break;
  }

  const automationNames = getState().automations.records.map((r) => r.name);
  const folderDisplays = folders.filter((f) => f.readable).map((f) => f.display);
  const fileDisplays = files.map((f) => f.display);
  let apps: ConnectorSnapshot[] = [];
  try {
    apps = await connectorStatuses();
  } catch {
    // A status probe that breaks must not block compiling — the drafter
    // just sees no app menu this time.
  }

  return {
    folders,
    files,
    automationNames,
    readTargets: [...folderDisplays, ...fileDisplays],
    writeTargets: [...folderDisplays, ...fileDisplays],
    displayToReal,
    apps,
  };
}

// Fuzzy match catalog entries against the user's words — used to draw
// question-card options FROM the catalog, never guessed.
export function matchCatalog(
  catalog: Catalog,
  words: string,
  kind: "file" | "folder"
): { display: string; label: string }[] {
  const tokens = words
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  // "sheet"-like words imply spreadsheet files even when the filename says
  // neither — the mockup's "invoices-2026.xlsx" must surface for "tracking
  // sheet".
  const extBoost: Record<string, number> = {};
  if (tokens.some((t) => ["sheet", "spreadsheet", "excel", "xlsx", "csv", "tracking"].includes(t))) {
    extBoost["xlsx"] = 4;
    extBoost["csv"] = 3;
  }
  if (tokens.some((t) => ["note", "notes"].includes(t))) {
    extBoost["md"] = 3;
    extBoost["txt"] = 3;
  }
  const score = (name: string, ext = ""): number => {
    const n = name.toLowerCase();
    let s = extBoost[ext] ?? 0;
    for (const t of tokens) if (n.includes(t)) s += t.length;
    return s;
  };
  if (kind === "folder") {
    return catalog.folders
      .filter((f) => f.readable)
      .map((f) => ({ display: f.display, label: f.label, s: score(f.label) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map(({ display, label }) => ({ display, label }));
  }
  return catalog.files
    .map((f) => ({
      display: f.display,
      label: `${f.name} — in ${f.folderDisplay.replace("~/", "")}`,
      s: score(f.name, f.ext),
    }))
    .filter((f) => f.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map(({ display, label }) => ({ display, label }));
}
