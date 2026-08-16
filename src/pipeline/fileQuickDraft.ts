// Deterministic compiler for common file work. It only uses paths already in
// the closed catalog. If the words do not identify one, it asks with real
// choices (and a Choose button) instead of starting the full local-AI draft.
import type { Catalog, CatalogFile, CatalogFolder } from "./catalog";
import { matchCatalog } from "./catalog";
import type { DraftContext } from "./draft";
import type { WireAutomation } from "./draft/schema";
import type { QuickCompileMatch, QuickQuestion } from "./quickDraft";
import { scheduleFrom } from "./quickDraft";
import {
  encodeQuickReadAll,
  encodeQuickToolStep,
} from "../runner/quickSteps";

type FileAction = "summarize" | "rename" | "move";

interface Ranked<T> {
  item: T;
  score: number;
  index: number;
}

function normalized(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function candidateHit(
  text: string,
  display: string,
  real: string,
  label: string
): { score: number; index: number } | null {
  const haystack = normalized(text);
  const realNeedle = normalized(real);
  const displayNeedle = normalized(display);
  const labelNeedle = normalized(label);
  const realIndex = realNeedle.length > 2 ? haystack.indexOf(realNeedle) : -1;
  if (realIndex >= 0) return { score: 10_000 + realNeedle.length, index: realIndex };
  const displayIndex = displayNeedle.length > 2 ? haystack.indexOf(displayNeedle) : -1;
  if (displayIndex >= 0)
    return { score: 8_000 + displayNeedle.length, index: displayIndex };
  const labelIndex = labelNeedle.length > 2 ? haystack.indexOf(labelNeedle) : -1;
  if (labelIndex >= 0)
    return { score: 100 + labelNeedle.length, index: labelIndex };
  return null;
}

function mentionedFolders(text: string, catalog: Catalog): Ranked<CatalogFolder>[] {
  return catalog.folders
    .filter((folder) => folder.readable)
    .flatMap((folder) => {
      const hit = candidateHit(text, folder.display, folder.real, folder.label);
      return hit ? [{ item: folder, ...hit }] : [];
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

function mentionedFiles(text: string, catalog: Catalog): Ranked<CatalogFile>[] {
  return catalog.files
    .flatMap((file) => {
      const hit = candidateHit(text, file.display, file.real, file.name);
      return hit ? [{ item: file, ...hit }] : [];
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

function requestedAction(text: string): FileAction | null {
  if (
    /\b(move|moves|moving|relocate|transfer)\b/i.test(text) ||
    (/\b(organize|sort)\b/i.test(text) && /\b(?:to|into)\b/i.test(text))
  )
    return "move";
  if (/\brename|change\s+(?:the\s+)?file\s*names?\b/i.test(text)) return "rename";
  if (/\bsummari[sz](?:e|es|ed|ing)|\bsummary\b|\brecap\b/i.test(text))
    return "summarize";
  return null;
}

function targetQuestion(
  text: string,
  catalog: Catalog,
  action: FileAction,
  forcedKind?: "file" | "folder"
): QuickCompileMatch {
  const kind =
    forcedKind ??
    (/\b(folder|directory|path)\b/i.test(text) || !/\.[a-z0-9]{1,8}\b/i.test(text)
      ? "folder"
      : "file");
  const verb = action === "summarize" ? "summarize" : action;
  const matched = matchCatalog(catalog, text, kind).map((option) => ({
    label: option.label,
    value: option.display,
  }));
  const fallback =
    kind === "folder"
      ? catalog.folders
          .filter((folder) => folder.readable)
          .slice(0, 3)
          .map((folder) => ({ label: folder.label, value: folder.display }))
      : catalog.files.slice(0, 3).map((file) => ({
          label: `${file.name} - in ${file.folderDisplay.replace("~/", "")}`,
          value: file.display,
        }));
  const question: QuickQuestion = {
    asking: `Which ${kind} should I ${verb}?`,
    term: text,
    kind,
    options: matched.length > 0 ? matched : fallback,
  };
  return { kind: "question", matched: [`${action} file request`], question };
}

function baseAutomation(
  text: string,
  fields: Pick<
    WireAutomation,
    "name" | "sentence" | "steps" | "files" | "tools" | "delivers"
  >
): WireAutomation {
  let schedule = scheduleFrom(text);
  if (fields.tools.length > 0 && schedule.trigger === "watch") {
    schedule = { trigger: "manual" };
  }
  return {
    ...fields,
    category: fields.delivers === "files" ? "Files" : "Documents",
    inputs: [],
    outputs: [],
    sources: [],
    apps: [],
    knowledge: [],
    schedule,
    effort: "quick",
  };
}

function shortLabel(value: string): string {
  return value
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
}

function requestedExtension(text: string): string | null {
  const match = text.match(/(?:\*\.)?\b(pdf|txt|csv|md|json|xlsx|docx)s?\b/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function renamePattern(text: string): string | null {
  const quoted = text.match(/\brename\b[\s\S]*?\b(?:to|as)\s+(["'`])(.+?)\1/i);
  if (quoted?.[2]) return quoted[2].trim();
  const token = text.match(/\brename\b[\s\S]*?\b(?:to|as)\s+([^\s,;.]+)/i);
  return token?.[1]?.trim() ?? null;
}

function lastDestinationMarker(text: string): number {
  let index = -1;
  for (const match of text.matchAll(/\b(?:to|into)\s+/gi)) index = match.index ?? index;
  return index;
}

function summarizeDraft(
  text: string,
  catalog: Catalog
): QuickCompileMatch {
  const file = mentionedFiles(text, catalog)[0]?.item;
  const folder = mentionedFolders(text, catalog)[0]?.item;
  const target = file?.display ?? folder?.display;
  const label = file?.name ?? folder?.label;
  if (!target || !label) return targetQuestion(text, catalog, "summarize");
  const record = baseAutomation(text, {
    name: `${shortLabel(label)} Summary`.split(/\s+/).slice(0, 4).join(" "),
    sentence: `Reads and summarizes every readable document in ${label} without changing the originals.`,
    steps: [
      encodeQuickReadAll(target),
      "Summarize the important facts clearly and group the answer by filename",
    ],
    files: { reads: [target], writes: [] },
    tools: [],
    delivers: "answer",
  });
  return {
    kind: "draft",
    matched: [`summary of ${label}`],
    draft: { automations: [record], chain: null, question: null },
  };
}

function renameDraft(text: string, catalog: Catalog): QuickCompileMatch {
  const file = mentionedFiles(text, catalog)[0]?.item;
  const folder = mentionedFolders(text, catalog)[0]?.item;
  const targetFolder = file?.folderDisplay ?? folder?.display;
  if (!targetFolder) return targetQuestion(text, catalog, "rename");
  const pattern = renamePattern(text);
  if (!pattern) {
    return {
      kind: "question",
      matched: ["rename files"],
      question: {
        asking: "What filename pattern should I use?",
        term: text,
        kind: "other",
        options: [
          { label: "Number them", value: "Rename them to file-{n}{ext}" },
          { label: "Add organized", value: "Rename them to {name}-organized{ext}" },
        ],
      },
    };
  }
  const extension = requestedExtension(text) ?? file?.ext ?? null;
  const args = {
    folder: targetFolder,
    find: file?.name ?? "",
    replace_with: pattern,
    use_regex: false,
    only_extension: extension,
  };
  const label = folder?.label ?? file?.name ?? "Files";
  const record = baseAutomation(text, {
    name: `${shortLabel(label)} Rename`.split(/\s+/).slice(0, 4).join(" "),
    sentence: `Renames matching files in ${label} to ${pattern} in a copy for review.`,
    steps: [encodeQuickToolStep("bulk_rename", args)],
    files: { reads: [targetFolder], writes: [targetFolder] },
    tools: ["bulk_rename"],
    delivers: "files",
  });
  return {
    kind: "draft",
    matched: [`rename files in ${label}`],
    draft: { automations: [record], chain: null, question: null },
  };
}

function moveDraft(text: string, catalog: Catalog): QuickCompileMatch {
  const files = mentionedFiles(text, catalog);
  const folders = mentionedFolders(text, catalog);
  const destinationMarker = lastDestinationMarker(text);
  const destination = folders
    .filter((candidate) => candidate.index > destinationMarker)
    .sort((a, b) => b.score - a.score)[0]?.item;
  const namedFile = files[0]?.item;
  const source =
    namedFile
      ? catalog.folders.find((folder) => folder.display === namedFile.folderDisplay)
      : folders
          .filter((candidate) => candidate.item.display !== destination?.display)
          .filter((candidate) => destinationMarker < 0 || candidate.index < destinationMarker)
          .sort((a, b) => b.score - a.score)[0]?.item ??
        folders.find((candidate) => candidate.item.display !== destination?.display)?.item;

  if (!source) return targetQuestion(text, catalog, "move", "folder");
  if (!destination || destination.display === source.display) {
    const options = catalog.folders
      .filter((folder) => folder.readable && folder.display !== source.display)
      .slice(0, 3)
      .map((folder) => ({ label: folder.label, value: folder.display }));
    return {
      kind: "question",
      matched: ["move files"],
      question: {
        asking: `Which folder should I move the files from ${source.label} into?`,
        term: text,
        kind: "folder",
        options,
      },
    };
  }

  const extension = requestedExtension(text) ?? namedFile?.ext ?? null;
  const args = {
    source_folder: source.display,
    destination_folder: destination.display,
    find: namedFile?.name ?? "",
    only_extension: extension,
  };
  const record = baseAutomation(text, {
    name: `${shortLabel(source.label)} File Move`.split(/\s+/).slice(0, 4).join(" "),
    sentence: `Moves matching files from ${source.label} to ${destination.label} in a copy for review.`,
    steps: [encodeQuickToolStep("move_files", args)],
    files: {
      reads: [source.display],
      writes: [source.display, destination.display],
    },
    tools: ["move_files"],
    delivers: "files",
  });
  return {
    kind: "draft",
    matched: [`move files from ${source.label} to ${destination.label}`],
    draft: { automations: [record], chain: null, question: null },
  };
}

export function tryQuickFileCompile(
  context: DraftContext,
  catalog: Catalog
): QuickCompileMatch | null {
  if (context.demo) return null;
  const answerText = context.answers.map((answer) => answer.answer).join(" ");
  const text = `${context.userText.trim()} ${answerText}`.trim();
  const action = requestedAction(text);
  if (!action) return null;
  if (action === "summarize") return summarizeDraft(text, catalog);
  if (action === "rename") return renameDraft(text, catalog);
  return moveDraft(text, catalog);
}
