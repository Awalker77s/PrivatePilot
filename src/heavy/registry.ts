// The heavy-tool registry — the closed set of typed heavy tools a record's
// `tools` fence can name, mirroring the connector registry. Tools bind per
// record (only the ones the record lists), and only when the Heavy tasks
// consent is on and a sandbox exists.
import { getSettings } from "../storage/settings";
import type { HeavyToolId, HeavyToolSpec } from "./types";
import { bulkRenameTool } from "./bulkRename";
import { zipFolderTool, unzipTool } from "./archive";
import { ocrPdfTool } from "./ocr";

export const HEAVY_TOOLS: HeavyToolSpec[] = [
  bulkRenameTool,
  zipFolderTool,
  unzipTool,
  ocrPdfTool,
];
export const HEAVY_TOOL_IDS = HEAVY_TOOLS.map((t) => t.id) as [
  HeavyToolId,
  ...HeavyToolId[],
];

export function heavyToolById(id: string): HeavyToolSpec | undefined {
  return HEAVY_TOOLS.find((t) => t.id === id);
}

export function heavyToolNames(): string[] {
  return HEAVY_TOOLS.map((t) => t.def.function.name);
}

// Consent: the person allowed heavy tools (Settings → Heavy tasks).
export function heavyAllowed(): boolean {
  return getSettings().heavy?.filesAllowed === true;
}

export function heavyToolsFor(ids: string[] | undefined): HeavyToolSpec[] {
  const out: HeavyToolSpec[] = [];
  for (const id of ids ?? []) {
    const t = heavyToolById(id);
    if (t) out.push(t);
  }
  return out;
}

// The drafter menu — one line per tool, injected next to the connector menu.
export function heavyMenu(): string {
  return HEAVY_TOOLS.map((t) => `- ${t.menuLine}`).join("\n");
}
