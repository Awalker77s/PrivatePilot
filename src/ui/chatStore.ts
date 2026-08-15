// Chat state lives outside React so it survives tab switches. Items render
// from compile results (stored records + counters), never from raw model
// prose.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { compile, CompileResult, CompileQuestion } from "../pipeline/session";
import type { DraftContext } from "../pipeline/draft";
import { updateSettings } from "../storage/settings";
import { keepRun, putBackRun, runAutomation } from "../runner/run";
import {
  getRun,
  getState,
  restoreVersion,
  saveAutomation,
  saveChain,
} from "../storage/stores";
import { editAutomation, EditResult } from "../pipeline/edit";
import { activeLocalModel } from "../providers";
import { ChainCycleError, assertNoCycle, runChain } from "../dispatcher";
import type { AutomationRecord } from "../storage/types";

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
      runId: string | null; // the compile run this question came from
    }
  | {
      id: number;
      kind: "built";
      result: CompileResult;
      state: "fresh" | "discarded" | "running" | "ran" | "saved";
      runId: string | null; // the watched run — the card renders from its record
      chainRunIds: string[] | null; // multi-automation watched run, per step
      progress: string | null;
      keepSentence: string | null;
    }
  | { id: number; kind: "note"; tone: "gray" | "amber" | "red"; text: string }
  | {
      id: number;
      kind: "edit";
      autoId: string;
      result: EditResult;
      state: "fresh" | "kept" | "reverted";
    };

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
      push({
        kind: "question",
        q: result.question,
        answered: null,
        runId: result.runId,
      });
      pending = context; // the next answer continues this compile
    } else {
      push({
        kind: "built",
        result,
        state: "fresh",
        runId: null,
        chainRunIds: null,
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

// An edit in flight, waiting for a "Which one?" answer.
let pendingEditRequest: string | null = null;

// "make it 7am" about an existing automation is an edit, not a build.
// Resolve the target by name; two matches → a one-tap "Which one?" card,
// never a silent pick.
function editTargets(text: string): AutomationRecord[] {
  const t = text.toLowerCase();
  const aboutMatch = text.match(/^About "(.+?)":/);
  const records = getState().automations.records;
  if (aboutMatch) {
    const named = records.filter(
      (a) => a.name.toLowerCase() === aboutMatch[1].toLowerCase()
    );
    if (named.length > 0) return named;
  }
  return records.filter((a) => t.includes(a.name.toLowerCase()));
}

async function runEdit(auto: AutomationRecord, request: string) {
  busy = true;
  const progress = push({
    kind: "progress",
    stage: "draft",
    text: `Patching "${auto.name}"…`,
    startedAt: Date.now(),
  });
  try {
    const model = await activeLocalModel();
    if (!model) throw new Error("No local model.");
    const result = await editAutomation(auto, request, model);
    replace(progress.id, null);
    if (!result.ok || !result.after) {
      push({
        kind: "note",
        tone: "amber",
        text: result.failSentence ?? "The edit didn't land.",
      });
    } else {
      push({ kind: "edit", autoId: auto.id, result, state: "fresh" });
    }
  } catch (e) {
    replace(progress.id, null);
    push({ kind: "note", tone: "red", text: `Broke: ${String(e)}` });
  } finally {
    busy = false;
    emit();
  }
}

// Keep it: the patched record becomes current (the old version is kept for
// Put it back — last ~10).
export async function keepEdit(itemId: number) {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.kind !== "edit" || item.state !== "fresh" || !item.result.after)
    return;
  await saveAutomation(item.result.after);
  replace(itemId, { ...item, state: "kept" });
}

export async function revertEdit(itemId: number) {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.kind !== "edit" || item.state !== "kept") return;
  await restoreVersion(item.autoId);
  replace(itemId, { ...item, state: "reverted" });
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

  if (lastQuestion && pendingEditRequest) {
    replace(lastQuestion.id, { ...lastQuestion, answered: text });
    const target = getState().automations.records.find(
      (a) => a.name.toLowerCase() === text.trim().toLowerCase()
    );
    const request = pendingEditRequest;
    pendingEditRequest = null;
    if (target) {
      await runEdit(target, request);
    } else {
      push({ kind: "note", tone: "amber", text: `No automation is named "${text.trim()}".` });
    }
    return;
  }

  if (lastQuestion && pending) {
    replace(lastQuestion.id, { ...lastQuestion, answered: text });
    await rememberAlias(lastQuestion.q.asking, text);
    await resolveQuestionRun(lastQuestion.runId, text);
    await runCompile({
      userText: pending.userText,
      answers: [
        ...pending.answers,
        { asking: lastQuestion.q.asking, answer: text },
      ],
    });
    return;
  }

  const targets = editTargets(text);
  if (targets.length === 1) {
    await runEdit(targets[0], text);
    return;
  }
  if (targets.length > 1) {
    pendingEditRequest = text;
    push({
      kind: "question",
      q: {
        asking: "Which one?",
        term: text,
        kind: "automation",
        options: targets.map((a) => ({ label: a.name, value: a.name })),
      },
      answered: null,
      runId: null,
    });
    return;
  }

  await runCompile({ userText: text, answers: [] });
}

export async function pickOption(itemId: number, value: string) {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.kind !== "question" || item.answered !== null) return;

  if (pendingEditRequest) {
    replace(itemId, { ...item, answered: value });
    const target = getState().automations.records.find(
      (a) => a.name === value
    );
    const request = pendingEditRequest;
    pendingEditRequest = null;
    if (target) await runEdit(target, request);
    return;
  }

  if (!pending) return;
  replace(itemId, { ...item, answered: value });
  await rememberAlias(item.q.asking, value);
  await resolveQuestionRun(item.runId, value);
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

// An answered question resolves its compile run — the amber pin comes down.
async function resolveQuestionRun(runId: string | null, answer: string) {
  if (!runId) return;
  const { updateRun } = await import("../storage/stores");
  await updateRun(runId, (r) => {
    if (r.status === "needs_you") {
      r.status = "held";
      r.summary = `Answered: ${answer.slice(0, 60)}`;
    }
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

// Try it once: the watched run. Single automations run alone; a drafted
// chain runs member by member so the hand-off happens with real things in
// it. The card then renders from run records in runs.json — never model
// prose.
export async function tryOnce(itemId: number, inputValues?: Record<string, string>) {
  const item = builtItem(itemId);
  if (!item || item.state === "running") return;
  const autos = item.result.automations;
  if (autos.length === 0) return;
  patchBuilt(itemId, { state: "running", progress: "Starting…" });
  try {
    if (autos.length === 1 || !item.result.chain) {
      const run = await runAutomation(autos[0], {
        cause: "you pressed Try it once",
        inputValues,
        onProgress: (text) => patchBuilt(itemId, { progress: text }),
      });
      if (run.status === "broke") {
        patchBuilt(itemId, { state: "fresh", progress: null, runId: run.id });
        push({ kind: "note", tone: "red", text: run.summary ?? "Broke." });
      } else {
        patchBuilt(itemId, { state: "ran", progress: null, runId: run.id });
      }
    } else {
      const runs = await runChain(item.result.chain, autos, {
        cause: "you pressed Try it once",
        onProgress: (p) =>
          patchBuilt(itemId, {
            progress: `${p.autoName} — ${p.text}`,
          }),
      });
      const broke = runs.some((r) => r.status === "broke");
      patchBuilt(itemId, {
        state: broke ? "fresh" : "ran",
        progress: null,
        chainRunIds: runs.map((r) => r.id),
        runId: runs[0]?.id ?? null,
      });
      if (broke) {
        const bad = runs.find((r) => r.status === "broke");
        push({ kind: "note", tone: "red", text: bad?.summary ?? "Broke." });
      }
    }
  } catch (e) {
    patchBuilt(itemId, { state: "fresh", progress: null });
    push({ kind: "note", tone: "red", text: `Broke: ${String(e)}` });
  }
}

export async function keepBuilt(itemId: number, runId?: string) {
  const item = builtItem(itemId);
  const target = runId ?? item?.runId;
  if (!item || !target) return;
  const sentence = await keepRun(target);
  patchBuilt(itemId, { keepSentence: sentence });
}

export async function putBackBuilt(itemId: number, runId?: string) {
  const item = builtItem(itemId);
  const target = runId ?? item?.runId;
  if (!item || !target) return;
  const sentence = await putBackRun(target);
  patchBuilt(itemId, { keepSentence: null });
  push({ kind: "note", tone: "gray", text: sentence });
}

export async function notNowBuilt(itemId: number, runId?: string) {
  const item = builtItem(itemId);
  const target = runId ?? item?.runId;
  if (!item || !target) return;
  const { updateRun } = await import("../storage/stores");
  await updateRun(target, (r) => {
    if (r.status === "needs_you") {
      r.status = "held";
      r.summary = "Left in the copy — nothing applied.";
    }
  });
}

export function toggleDiffEntry(itemId: number, relPath: string, runId?: string) {
  const item = builtItem(itemId);
  const target = runId ?? item?.runId;
  if (!item || !target) return;
  const run = getRun(target);
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
  if (item.result.chain) {
    // A→B→A refused at save, with the circle drawn in words.
    try {
      assertNoCycle(item.result.chain, (id) => {
        const a = item.result.automations.find((x) => x.id === id);
        return a?.name ?? id;
      });
    } catch (e) {
      if (e instanceof ChainCycleError) {
        push({ kind: "note", tone: "amber", text: e.sentence });
        return;
      }
      throw e;
    }
  }
  const runIds = item.chainRunIds ?? (item.runId ? [item.runId] : []);
  for (const auto of item.result.automations) {
    const run = runIds
      .map((id) => getRun(id))
      .find((r) => r?.automationId === auto.id);
    if (run) {
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
