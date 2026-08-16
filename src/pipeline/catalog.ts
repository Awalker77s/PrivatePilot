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
import { isDesktopApp } from "../platform";

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
  // Knowledge bases (named document collections) the person has built.
  knowledgeBases: string[];
  // The person's words route on a result ("if…, otherwise…") — the validator
  // insists on chain.steps when multiple jobs arrive unchained.
  branchIntent?: boolean;
  // The person explicitly asked for ONE connected sequence ("as a chain",
  // "connect them", "one after the other") — the validator then insists
  // multi-job drafts arrive chained, and allows pure-ordering links.
  chainIntent?: boolean;
  // chainIntent AND branchIntent together: "a sequence … if X … if not …".
  // Kept as its own flag because the lenient final pass clears chainIntent to
  // let an imperfect shape through — but a conditional folded into ONE
  // automation is not an imperfect sequence, it is the wrong structure, so
  // this rule has to survive that pass.
  splitRequired?: boolean;
  // This request is ONE job by construction (a coordination-split segment) —
  // the validator refuses drafts with more than one automation.
  singleJob?: boolean;
}

// Online requests do not need 150 real paths embedded into the JSON grammar.
// Keeping those enums out makes local CPU drafting materially faster while
// preserving the closed catalog whenever the person actually mentions files.
const FILE_INTENT =
  /\b(file|folder|document|documents|pdf|spreadsheet|sheet|excel|csv|xlsx|docx|invoice|invoices|receipt|receipts|ledger|downloads?|desktop|directory|directories|scan|scanned|scans|image|images|photo|photos|picture|pictures|jpe?g|png|tiff?|ocr|searchable|rename|zip|archive|convert)\b/i;
// A NAMED file is a file request even when the sentence never says "file":
// "summarize Project Phoenix Update.md" carries no keyword above, so the
// catalog arrived with zero files and the app asked "Which file?" about a
// filename the person had just typed in full.
export const FILENAME_RE =
  /[\w()[\]{}~%&#@+,'-][\w ()[\]{}~%&#@+,'-]*\.(pdf|docx?|xlsx?|xlsm|csv|tsv|txt|md|markdown|rtf|json|ya?ml|pptx?|html?|png|jpe?g|gif|tiff?|bmp|webp|heic|zip|7z|rar|eml|msg|log)\b/i;

// Result-dependent routing in the person's own words. Deliberately narrow:
// a bare "if" appears in single-job requests ("check if…") all the time.
export const BRANCH_INTENT =
  /\b(otherwise|or else|if not\b|if it (does not|doesn't)|depending on (what|the|that|it)|if the \w+ (fails|breaks|is down|works|succeeds)|if the (result|answer|outcome|check)|if (it|that|this)(\s+\w+)? (fails|breaks|finds|says|mentions|succeeds|is down|works))\b/i;

// An explicit ask that the jobs be CONNECTED, in any of the words people use
// for it — chain, sequence, connect, put together, one after the other.
// Deliberately shaped (not a bare \bchain\b): "supply chain news" is a topic,
// not a request to link jobs.
export const CHAIN_REQUEST_RE = new RegExp(
  [
    // "…as a chain", "…into one sequence"
    String.raw`\b(?:as|into) (?:a |one )?(?:chain|sequence|workflow)\b`,
    // "make a sequence from A and B" — the thing being made IS the chain.
    String.raw`\b(?:make|build|create|set up) (?:me )?(?:a|one|an) (?:chain|sequence|workflow)\b`,
    // "make an automation for this and one for that a chain" — the ask
    // tacked onto the end, which is how people say it out loud.
    String.raw`\b(?:a|one) (?:chain|sequence|workflow)\b(?:\s+or\s+(?:a\s+)?(?:chain|sequence|workflow))?\s*[.!?]*\s*$`,
    String.raw`\b(?:chain|sequence|connect|link|combine|join) (?:them|these|those|both|the two|together)\b`,
    // "connect the tesla price and the top tech news" — an imperative connect
    // verb leading the sentence, naming two jobs that do not exist yet. The
    // chat tier already understood this shape for SAVED automations; without
    // it here the compiler built both jobs and left them unlinked.
    String.raw`^(?:\s*(?:please|can you|could you|would you|i want (?:you )?to|i'?d like (?:you )?to|let'?s|now|also)\s+)*(?:connect|chain|link|combine|join|merge)\b`,
    String.raw`\b(?:make|turn) (?:it|this|them|these|those)?\s*(?:in)?to (?:a |one )?(?:chain|sequence|workflow)\b`,
    // "a sequence of them" AND "a sequence of the meta price and the orlando
    // weather" — the jobs named after "of" may not exist yet, which is the
    // whole point: one sentence builds both and joins them.
    String.raw`\b(?:a|one) (?:chain|sequence|workflow) (?:of|from|out of|with)\b`,
    String.raw`\bfeeds? (?:it |that |the result )?into\b`,
    String.raw`\bone after (?:the other|another)\b`,
    String.raw`\bback to back\b`,
    String.raw`\bput (?:them|these|those|the two)\b[^.]{0,40}?\btogether\b`,
    String.raw`\bput\s+(?!together\b)[^.]{1,60}?\s+and\s+[^.]{1,60}?\s+together\b`,
    String.raw`\bstring (?:them|these|those) together\b`,
    String.raw`\bhook (?:them|these|those) (?:up|together)\b`,
  ].join("|"),
  "i"
);

export function catalogForRequest(catalog: Catalog, userText: string): Catalog {
  const branchIntent = BRANCH_INTENT.test(userText);
  const chainIntent = CHAIN_REQUEST_RE.test(userText);
  if (FILE_INTENT.test(userText) || FILENAME_RE.test(userText))
    return { ...catalog, branchIntent, chainIntent, splitRequired: chainIntent && branchIntent };
  return {
    ...catalog,
    branchIntent,
    chainIntent,
    splitRequired: chainIntent && branchIntent,
    files: [],
    readTargets: [],
    writeTargets: [],
    displayToReal: Object.fromEntries(
      catalog.folders.map((folder) => [folder.display, folder.real])
    ),
  };
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

// Images can't be READ as text (readAnyFile refuses them) but they ARE valid
// targets for the OCR heavy tool, so the catalog must be able to name them.
const OCR_EXTS = new Set(["png", "jpg", "jpeg", "tiff", "tif", "bmp", "webp"]);

export function isOcrImage(display: string): boolean {
  return OCR_EXTS.has(display.split(".").pop()?.toLowerCase() ?? "");
}

export function formatForPath(display: string): string {
  const ext = display.split(".").pop()?.toLowerCase() ?? "";
  return FORMAT_BY_EXT[ext] ?? "text";
}

export async function buildCatalog(): Promise<Catalog> {
  await loadSettings();
  const folderSpecs: {
    label: string;
    real: string;
    display: string;
    recursive: boolean;
  }[] = [];
  const fwd = (path: string) =>
    path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

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
        recursive: false,
      });
    } catch {
      // folder genuinely unavailable on this machine — simply absent
    }
  };

  if (isDesktopApp()) {
    await tryDir("Downloads", downloadDir);
  await tryDir("Documents", documentDir);
  await tryDir("Desktop", desktopDir);
  // A picked folder displays relative to home when it sits under a standard
  // folder (~/Downloads/receipts), so the model sees a resolvable path — a
  // "~/…/x" abbreviation reads as out-of-scope to a small model.
  const knownReals = folderSpecs.map((f) => ({ realFwd: fwd(f.real), display: f.display }));
  for (const picked of getSettings().pickedFolders) {
    const norm = picked.replace(/[\\/]+$/, "");
    const pf = fwd(norm);
    const parent = knownReals.find((k) => pf.startsWith(k.realFwd + "/"));
    const name = norm.split(/[\\/]/).filter(Boolean).pop() ?? norm;
    const display = parent
      ? `${parent.display}/${pf.slice(parent.realFwd.length + 1)}`
      : `~/…/${name}`;
    folderSpecs.push({ label: name, real: norm, display, recursive: true });
  }

  }

  const folders: CatalogFolder[] = [];
  const files: CatalogFile[] = [];
  const displayToReal: Record<string, string> = {};
  const perFolder: CatalogFile[][] = [];
  const seenFolderReals = new Set<string>();
  const MAX_RECURSIVE_DEPTH = 3;
  const MAX_FOLDERS_PER_ROOT = 50;
  const SKIP_FOLDERS = new Set([
    "node_modules",
    "target",
    "dist",
    ".git",
    ".pilot-versions",
  ]);

  for (const spec of folderSpecs) {
    const bucket: CatalogFile[] = [];
    let foldersSeen = 0;
    const scan = async (
      real: string,
      display: string,
      label: string,
      depth: number
    ): Promise<void> => {
      const realKey = fwd(real);
      if (seenFolderReals.has(realKey)) return;
      seenFolderReals.add(realKey);
      let entries;
      try {
        entries = await readDir(real);
      } catch {
        folders.push({ display, real, label, readable: false });
        displayToReal[display] = real;
        return;
      }
      folders.push({ display, real, label, readable: true });
      displayToReal[display] = real;

      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
        // OCR leaves its machinery beside the documents: a "<stem>-pages"
        // folder of rendered PNGs, a .pagelist.txt, an .ocr.json sidecar.
        // Cataloguing those offers them to the drafter as if they were the
        // person's documents — one run fenced "scanned-receipt-pages" and
        // filed page images into a knowledge base instead of the folder it
        // was asked about.
        if (entry.isDirectory && /-pages$/i.test(entry.name)) continue;
        if (/\.(pagelist\.txt|ocr\.json)$/i.test(entry.name)) continue;
        // A previous run's OWN outputs are not new documents. Left in, a
        // second filing indexed "receipt-1", "receipt-1.ocr" and
        // "receipt-1.searchable" as three separate things.
        if (/\.(searchable\.pdf|ocr\.txt)$/i.test(entry.name)) continue;
        const entryReal = await join(real, entry.name);
        const entryDisplay = `${display}/${entry.name}`;
        if (entry.isFile) {
          // Text formats the runner can read, PLUS image formats the OCR tool
          // can turn into searchable text — both are automatable targets.
          const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
          if (!(ext in FORMAT_BY_EXT) && !OCR_EXTS.has(ext)) continue;
          if (bucket.length >= MAX_FILES_PER_FOLDER) continue;
          bucket.push({
            display: entryDisplay,
            real: entryReal,
            name: entry.name,
            ext,
            folderDisplay: display,
          });
          continue;
        }
        if (
          !spec.recursive ||
          !entry.isDirectory ||
          depth >= MAX_RECURSIVE_DEPTH ||
          foldersSeen >= MAX_FOLDERS_PER_ROOT ||
          SKIP_FOLDERS.has(entry.name.toLowerCase())
        ) {
          continue;
        }
        foldersSeen++;
        await scan(entryReal, entryDisplay, entry.name, depth + 1);
      }
    };
    await scan(spec.real, spec.display, spec.label, 0);
    perFolder.push(bucket);
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
  let knowledgeBases: string[] = [];
  try {
    const { listKnowledgeBases } = await import("../rag/store");
    knowledgeBases = (await listKnowledgeBases()).map((k) => k.name);
  } catch {
    // no KBs yet, or the store is unavailable
  }

  return {
    folders,
    files,
    automationNames,
    readTargets: [...folderDisplays, ...fileDisplays],
    writeTargets: [...folderDisplays, ...fileDisplays],
    displayToReal,
    apps,
    knowledgeBases,
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
