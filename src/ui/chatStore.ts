// Chat state lives outside React so it survives tab switches. Items render
// from compile results (stored records + counters), never from raw model
// prose.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { compile, CompileResult, CompileQuestion } from "../pipeline/session";
import type { DraftContext } from "../pipeline/draft";
import { updateSettings } from "../storage/settings";
import { keepRun, putBackRun, runAutomation } from "../runner/run";
import { getRun, saveAutomation, saveChain } from "../storage/stores";

export type ChatItem =
  | { id: number; kind: "user"; text: string }
  | {
      id: number;
      kind: "progress";
      stage: "draft" | "validate";
      text: string;
      startedAt: number;
    }
  | {
      id: number;
      kind: "question";
      q: CompileQuestion;
      answered: string | null;
    }
  | {
      id: number;
      kind: "built";
      result: CompileResult;
      state: "fresh" | "discarded" | "running" | "ran" | "saved";
      runId: string | null; // the watched run — the card renders from its record
      progress: string | null;
      keepSentence: string | null;
    }
  | { id: number; kind: "note"; tone: "gray" | "amber" | "red"; text: string };

let items: ChatItem[] = [];
let nextId = 1;
let busy = false;
// The conversation context carried across question cards.
let pending: DraftContext | null = null;

const listeners = new Set<() => void>();
let version = 0;

export function subscribeChat(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function chatVersion(): number {
  return version;
}
export function chatItems(): ChatItem[] {
  return items;
}
export function chatBusy(): boolean {
  return busy;
}

function emit() {
  version++;
  for (const fn of listeners) fn();
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

function push(item: DistributiveOmit<ChatItem, "id">): ChatItem {
  const it = { ...item, id: nextId++ } as ChatItem;
  items = [...items, it];
  emit();
  return it;
}

function replace(id: number, item: ChatItem | null) {
  items = item
    ? items.map((i) => (i.id === id ? item : i))
    : items.filter((i) => i.id !== id);
  emit();
}

async function runCompile(context: DraftContext) {
  busy = true;
  const progress = push({
    kind: "progress",
    stage: "draft",
    text: "Reading your folders…",
    startedAt: Date.now(),
  });
  try {
    const result = await compile(context, (stage, text) => {
      replace(progress.id, {
        ...(progress as ChatItem & { kind: "progress" }),
        stage,
        text,
      });
    });
    replace(progress.id, null);
    if (result.failSentence) {
      push({ kind: "note", tone: "red", text: result.failSentence });
      pending = null;
    } else if (result.question) {
      push({ kind: "question", q: result.question, answered: null });
      pending = context; // the next answer continues this compile
    } else {
      push({
        kind: "built",
        result,
        state: "fresh",
        runId: null,
        progress: null,
        keepSentence: null,
      });
      pending = null;
    }
  } catch (e) {
    replace(progress.id, null);
    push({ kind: "note", tone: "red", text: `Broke: ${String(e)}` });
    pending = null;
  } finally {
    busy = false;
    emit();
  }
}

export async function sendText(text: string) {
  if (busy || !text.trim()) return;
  push({ kind: "user", text });

  // An open question card? The typed text is its answer.
  const lastQuestion = [...items]
    .reverse()
    .find((i) => i.kind === "question" && i.answered === null) as
    | (ChatItem & { kind: "question" })
    | undefined;

  if (lastQuestion && pending) {
    replace(lastQuestion.id, { ...lastQuestion, answered: text });
    await rememberAlias(lastQuestion.q.asking, text);
    await runCompile({
      userText: pending.userText,
      answers: [
        ...pending.answers,
        { asking: lastQuestion.q.asking, answer: text },
      ],
    });
  } else {
    await runCompile({ userText: text, answers: [] });
  }
}

export async function pickOption(itemId: number, value: string) {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.kind !== "question" || item.answered !== null || !pending)
    return;
  replace(itemId, { ...item, answered: value });
  await rememberAlias(item.q.asking, value);
  await runCompile({
    userText: pending.userText,
    answers: [...pending.answers, { asking: item.q.asking, answer: value }],
  });
}

// "Choose…" — the dialog-picked path is allowed at pick time (fs scope does
// not auto-add it), remembered, and the compile resumes with it.
export async function chooseFile(itemId: number) {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.kind !== "question" || !pending) return;
  const picked = await openDialog({
    multiple: false,
    directory: item.q.kind === "folder",
  });
  if (!picked || typeof picked !== "string") return;
  await invoke(item.q.kind === "folder" ? "allow_folder" : "allow_file", {
    path: picked,
  });
  const parent = picked.replace(/[\\/][^\\/]+$/, "");
  await updateSettings((s) => {
    const dir = item.q.kind === "folder" ? picked : parent;
    if (!s.pickedFolders.includes(dir)) s.pickedFolders.push(dir);
  });
  await invoke("allow_folder", {
    path: item.q.kind === "folder" ? picked : parent,
  });
  await pickOption(itemId, picked);
}

async function rememberAlias(asking: string, answer: string) {
  // Ask once, remember forever — the next compile resolves it silently.
  await updateSettings((s) => {
    s.aliases[asking.toLowerCase().trim()] = answer;
  });
}

export function discardBuilt(itemId: number) {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.kind !== "built") return;
  replace(itemId, { ...item, state: "discarded" });
}

export function setBuiltState(
  itemId: number,
  state: "fresh" | "discarded" | "running" | "ran" | "saved"
) {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.kind !== "built") return;
  replace(itemId, { ...item, state });
}

export function pushNote(tone: "gray" | "amber" | "red", text: string) {
  push({ kind: "note", tone, text });
}

// The sheet's Change link seeds the composer with the row quoted.
let composerSeed: string | null = null;
export function seedComposer(text: string) {
  composerSeed = text;
  emit();
}
export function consumeComposerSeed(): string | null {
  const s = composerSeed;
  composerSeed = null;
  return s;
}

function builtItem(itemId: number) {
  const item = items.find((i) => i.id === itemId);
  return item && item.kind === "built" ? item : null;
}

function patchBuilt(
  itemId: number,
  patch: Partial<Extract<ChatItem, { kind: "built" }>>
) {
  const item = builtItem(itemId);
  if (!item) return;
  replace(itemId, { ...item, ...patch });
}

// Try it once: the watched run. Runs the drafted record in a sandbox; the
// card then renders from the run record in runs.json — never model prose.
export async function tryOnce(itemId: number) {
  const item = builtItem(itemId);
  if (!item || item.state === "running") return;
  const auto = item.result.automations[0];
  if (!auto || item.result.automations.length !== 1) return;
  patchBuilt(itemId, { state: "running", progress: "Starting…" });
  try {
    const run = await runAutomation(auto, {
      cause: "you pressed Try it once",
      onProgress: (text) => patchBuilt(itemId, { progress: text }),
    });
    if (run.status === "broke") {
      patchBuilt(itemId, { state: "fresh", progress: null, runId: run.id });
      push({ kind: "note", tone: "red", text: run.summary ?? "Broke." });
    } else {
      patchBuilt(itemId, { state: "ran", progress: null, runId: run.id });
    }
  } catch (e) {
    patchBuilt(itemId, { state: "fresh", progress: null });
    push({ kind: "note", tone: "red", text: `Broke: ${String(e)}` });
  }
}

export async function keepBuilt(itemId: number) {
  const item = builtItem(itemId);
  if (!item?.runId) return;
  const sentence = await keepRun(item.runId);
  patchBuilt(itemId, { keepSentence: sentence });
}

export async function putBackBuilt(itemId: number) {
  const item = builtItem(itemId);
  if (!item?.runId) return;
  const sentence = await putBackRun(item.runId);
  patchBuilt(itemId, { keepSentence: null });
  push({ kind: "note", tone: "gray", text: sentence });
}

export function toggleDiffEntry(itemId: number, relPath: string) {
  const item = builtItem(itemId);
  if (!item?.runId) return;
  const run = getRun(item.runId);
  const entry = run?.diff?.entries.find((e) => e.relPath === relPath);
  if (!entry || run?.diff?.applied) return;
  entry.kept = !entry.kept;
  emit();
}

// Save is earned: enabled only after the watched run completed. The watched
// run's outcome rides onto the saved record so the tile is born live.
export async function saveBuilt(itemId: number) {
  const item = builtItem(itemId);
  if (!item || item.state !== "ran") return;
  const run = item.runId ? getRun(item.runId) : undefined;
  for (const auto of item.result.automations) {
    if (run && run.automationId === auto.id) {
      auto.lastRun = {
        at: run.finishedAt ?? run.startedAt,
        status: run.status === "needs_you" ? "ok" : run.status,
        summary: run.summary ?? "",
      };
    }
    await saveAutomation(auto);
  }
  if (item.result.chain) await saveChain(item.result.chain);
  patchBuilt(itemId, { state: "saved" });
}
