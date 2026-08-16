// Chat state lives outside React so it survives tab switches. Items render
// from compile results (stored records + counters), never from raw model
// prose.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { readChatFile, writeChatFile } from "../storage/chat";
import {
  ADD_SHAPE_RE,
  CHAIN_TALK_RE,
  splitConditional,
  CHANGE_NOUN_RE,
  COPY_INTENT_RE,
  DEIXIS_RE,
  DELTA_VERB_RE,
  EditTarget,
  MAKE_A_SEQUENCE_RE,
  NEW_TASK_RE,
  PLURAL_REF_RE,
  SCHEDULE_FIELD_RE,
  SEQUENCE_NAME_RE,
  TIMEY_RE,
  describeChain,
  findChainByName,
  findTargetNamed,
  findTargetsByName,
  focusTargets,
  isQuestionAbout,
  mentionIndex,
  nameAfterPreposition,
  recentAutomationRecords,
  renderHistory,
  rewriteDeixis,
  splitCoordination,
} from "./memory";
import { BRANCH_INTENT, CHAIN_REQUEST_RE } from "../pipeline/catalog";
import {
  appendToSequence,
  conditionalSequenceFrom,
  sequenceFrom,
} from "../pipeline/sequence";
import { explainAutomation } from "../pipeline/explain";
import {
  ELLIPTICAL_RE,
  FOLLOWUP_HINT_RE,
  classifyFollowUp,
  refersToFocus,
} from "../pipeline/followup";
import { compile, CompileResult, CompileQuestion } from "../pipeline/session";
import type { DraftContext } from "../pipeline/draft";
import { updateSettings } from "../storage/settings";
import { isDesktopApp } from "../platform";
import { keepRun, putBackRun, runAutomation } from "../runner/run";
import {
  appendRun,
  getRun,
  getState,
  newId,
  saveAutomation,
  saveChain,
} from "../storage/stores";
import { editAutomation, EditResult } from "../pipeline/edit";
import { activeLocalModel } from "../providers";
import { ChainCycleError, assertNoCycle, runChain } from "../dispatcher";
import type {
  AutomationRecord,
  AutomationReference,
  ChainRecord,
} from "../storage/types";
import {
  automationContentHash,
  normalizeAutomation,
} from "../storage/revisions";

type ChatItemVariant =
  | { id: number; kind: "user"; text: string; references?: AutomationReference[] }
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
  // A grounded answer ABOUT an automation ("what can this do?") — rendered
  // like a run answer, sourced only from the record + its run history.
  | { id: number; kind: "explain"; autoName: string; text: string }
  // A finished run's ANSWER, as its own assistant bubble below the card —
  // the card stays the record of what ran; the bubble is the reply. Renders
  // from the run record (never a prose copy).
  | { id: number; kind: "answer"; autoName: string; runId: string }
  | {
      id: number;
      kind: "edit";
      autoId: string;
      // The built card holding the unsaved draft this edit patches — null
      // means the target is a saved record in the store.
      builtItemId: number | null;
      result: EditResult;
      // dropped = a fresh change the person waved away before it ever
      // touched the store; stale = the record moved on and this card's
      // buttons stopped being safe to press.
      state: "fresh" | "kept" | "reverted" | "dropped" | "stale";
    }
  | {
      id: number;
      kind: "watchme";
      state: "recording" | "review" | "listening" | "reading" | "failed";
      framesHeld: number;
      startedAt: number;
      thumbs: { tMs: number; url: string; dropped: boolean }[];
      reason: string | null; // the designed sentence when a rung degrades
      micOk: boolean;
    };

// Every item carries when it happened — day dividers render from the gaps.
export type ChatItem = ChatItemVariant & {
  at?: number;
  scopeAutomationId?: string | null;
};

let items: ChatItem[] = [];
let nextId = 1;
let busy = false;
let activePromptController: AbortController | null = null;
// The conversation context carried across question cards.
let pending: DraftContext | null = null;
let activeAutomationId: string | null = null;
let pendingReferences: AutomationReference[] = [];
interface ThreadRuntimeState {
  pending: DraftContext | null;
  pendingEditRequest: string | null;
  pendingReferences: AutomationReference[];
}
let threadStates: Record<string, ThreadRuntimeState> = {};

function activeThreadKey(): string {
  return activeAutomationId ?? "general";
}

function saveActiveThreadState(): void {
  threadStates[activeThreadKey()] = {
    pending,
    pendingEditRequest,
    pendingReferences,
  };
}

function restoreActiveThreadState(): void {
  const state = threadStates[activeThreadKey()];
  pending = state?.pending ?? null;
  pendingEditRequest = state?.pendingEditRequest ?? null;
  pendingReferences = state?.pendingReferences ?? [];
}

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
  return items.filter(
    (item) => (item.scopeAutomationId ?? null) === activeAutomationId
  );
}
export function chatBusy(): boolean {
  return busy;
}
export function chatCanCancel(): boolean {
  return activePromptController !== null;
}
export function chatCancelling(): boolean {
  return activePromptController?.signal.aborted ?? false;
}

export function cancelChatPrompt(): void {
  if (!activePromptController || activePromptController.signal.aborted) return;
  activePromptController.abort(new DOMException("Stopped by you", "AbortError"));
  emit();
}

function emit() {
  version++;
  for (const fn of listeners) fn();
  scheduleSave();
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

function push(item: DistributiveOmit<ChatItemVariant, "id">): ChatItem {
  const it = {
    ...item,
    id: nextId++,
    at: Date.now(),
    scopeAutomationId: activeAutomationId,
  } as ChatItem;
  items = [...items, it];
  emit();
  return it;
}

// ---- Persistent chat memory: General chat and every Automation Studio
// survive restarts independently. ----
let chatLoaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function serializableItems(): { list: ChatItem[]; interrupted: boolean } {
  let interrupted = false;
  const list: ChatItem[] = [];
  for (const i of items) {
    if (i.kind === "progress" || i.kind === "watchme") {
      // A dead spinner would wait forever; watch-me thumbs are data: URLs of
      // the screen — persisting them would break the burn() promise that a
      // crash leaves zero recording bytes on disk.
      interrupted = true;
      continue;
    }
    if (i.kind === "built" && i.state === "running") {
      interrupted = true;
      list.push({ ...i, state: "fresh", progress: null });
      continue;
    }
    list.push(i);
  }
  return { list, interrupted };
}

function scheduleSave() {
  if (!chatLoaded) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveActiveThreadState();
    const { list, interrupted } = serializableItems();
    void writeChatFile({
      v: 2,
      nextId,
      interrupted,
      pending,
      pendingEditRequest,
      activeAutomationId,
      pendingReferences,
      threadStates,
      items: list,
    }).catch(() => {
      // The thread is scrollback, not the record of what ran — a failed
      // save must never block the conversation.
    });
  }, 500);
}

export async function loadChat(): Promise<void> {
  const disk = await readChatFile();
  if (disk) {
    let loaded = disk.items as ChatItem[];
    const diskScope = disk.activeAutomationId ?? null;
    activeAutomationId =
      diskScope && getState().automations.records.some((record) => record.id === diskScope)
        ? diskScope
        : null;
    threadStates = (disk.threadStates as Record<string, ThreadRuntimeState> | undefined) ?? {};
    if (!disk.threadStates) {
      threadStates[activeThreadKey()] = {
        pending: (disk.pending as DraftContext | null) ?? null,
        pendingEditRequest: disk.pendingEditRequest ?? null,
        pendingReferences: disk.pendingReferences ?? [],
      };
    }
    restoreActiveThreadState();
    const activeLoaded = loaded.filter(
      (item) => (item.scopeAutomationId ?? null) === activeAutomationId
    );
    const tail = activeLoaded[activeLoaded.length - 1];
    const tailOpenQuestion =
      tail?.kind === "question" && tail.answered === null;
    // Question cards that lost their compile context are inert — say so
    // instead of leaving dead buttons.
    loaded = loaded.map((i) =>
      i.kind === "question" &&
      i.answered === null &&
      (i.scopeAutomationId ?? null) === activeAutomationId &&
      !(tailOpenQuestion && i.id === tail.id)
        ? { ...i, answered: "(left unanswered)" }
        : i
    );
    items = loaded;
    nextId = Math.max(
      disk.nextId ?? 1,
      ...loaded.map((i) => i.id + 1),
      1
    );
    if (!tailOpenQuestion) {
      pending = null;
      pendingEditRequest = null;
    }
    if (disk.interrupted) {
      items = [
        ...items,
        {
          id: nextId++,
          kind: "note",
          tone: "gray",
          at: Date.now(),
          text: "Something was still running when the app closed — it was stopped, and nothing half-done was kept.",
        },
      ];
    }
  }
  chatLoaded = true;
  emit();
}

function scopedItems(): ChatItem[] {
  return items.filter(
    (item) => (item.scopeAutomationId ?? null) === activeAutomationId
  );
}

export function activeStudioAutomationId(): string | null {
  return activeAutomationId;
}

export function openAutomationStudio(automationId: string): void {
  if (busy) return;
  saveActiveThreadState();
  activeAutomationId = automationId;
  restoreActiveThreadState();
  emit();
}

export function closeAutomationStudio(): void {
  if (busy) return;
  saveActiveThreadState();
  activeAutomationId = null;
  restoreActiveThreadState();
  emit();
}

export function composerReferences(): AutomationReference[] {
  return pendingReferences;
}

export function addAutomationReference(automationId: string): void {
  const record = getState().automations.records.find((a) => a.id === automationId);
  if (!record) return;
  const normalized = normalizeAutomation(record);
  const reference: AutomationReference = {
    automationId,
    revisionId: normalized.revision!.id,
    name: normalized.name,
  };
  pendingReferences = [
    ...pendingReferences.filter((item) => item.automationId !== automationId),
    reference,
  ];
  emit();
}

export function removeAutomationReference(automationId: string): void {
  pendingReferences = pendingReferences.filter(
    (item) => item.automationId !== automationId
  );
  emit();
}

export function detachLibraryFromChat(): void {
  if (busy) return;
  saveActiveThreadState();
  activeAutomationId = null;
  threadStates.general = {
    pending: null,
    pendingEditRequest: null,
    pendingReferences: [],
  };
  pending = null;
  pendingEditRequest = null;
  pendingReferences = [];
  composerSeed = null;
  for (const state of Object.values(threadStates)) {
    state.pendingReferences = [];
  }
  emit();
}

function referenceContext(
  references: AutomationReference[],
  records: AutomationRecord[]
): string {
  if (!references.length) return "";
  const lines = references.map((reference) => {
    const record = records.find((candidate) => candidate.id === reference.automationId);
    if (!record) return `Referenced automation: ${reference.name} (${reference.revisionId}).`;
    return [
      `Referenced automation \"${record.name}\" (${reference.revisionId}):`,
      record.sentence,
      `Inputs: ${record.inputs.map((input) => input.name).join(", ") || "none"}.`,
      `Outputs: ${record.outputs.map((output) => output.name).join(", ") || "none"}.`,
    ].join(" ");
  });
  return `\n\nStructured library references:\n${lines.join("\n")}`;
}

function replace(id: number, item: ChatItem | null) {
  items = item
    ? items.map((i) => (i.id === id ? item : i))
    : items.filter((i) => i.id !== id);
  emit();
}

function explicitWindowsPath(text: string): string | null {
  const quoted = text.match(/(["'`])([A-Za-z]:\\[^\r\n"'`]+)\1/);
  if (quoted?.[2]) return quoted[2].trim();
  const atEnd = text.match(/([A-Za-z]:\\[^\r\n"'`]+?)\s*[.!?]*\s*$/);
  return atEnd?.[1]?.trim() ?? null;
}

// Naming an exact path in the request is the same narrow permission as
// choosing it from the folder card. Register only an existing path; anything
// malformed or missing falls through to the ordinary grounded question.
async function rememberExplicitPath(text: string): Promise<void> {
  if (!isDesktopApp()) return;
  const path = explicitWindowsPath(text);
  if (!path) return;
  try {
    const directory = await invoke<string>("allow_exact_path", { path });
    if (!directory) return;
    await updateSettings((settings) => {
      if (!settings.pickedFolders.includes(directory)) {
        settings.pickedFolders.push(directory);
      }
      settings.permissions ??= {
        fullAccess: false,
        approvedRevisions: {},
        approvedWorkflowRevisions: {},
        approvedDirectories: [],
      };
      if (!settings.permissions.approvedDirectories.includes(directory)) {
        settings.permissions.approvedDirectories.push(directory);
      }
    });
  } catch {
    // The compile session will ask with real choices and a Choose button.
  }
}

async function runCompile(context: DraftContext) {
  const controller = new AbortController();
  activePromptController = controller;
  busy = true;
  const progress = push({
    kind: "progress",
    stage: "draft",
    text: "Reading your folders…",
    startedAt: Date.now(),
  });
  try {
    await rememberExplicitPath(context.userText);
    const result = await compile(context, (stage, text) => {
      replace(progress.id, {
        ...(progress as ChatItem & { kind: "progress" }),
        stage,
        text,
      });
    }, controller.signal);
    replace(progress.id, null);
    if (result.cancelled) {
      push({ kind: "note", tone: "gray", text: "Stopped by you. Nothing was saved." });
      pending = null;
    } else if (result.failSentence) {
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
    push(
      controller.signal.aborted
        ? { kind: "note", tone: "gray", text: "Stopped by you. Nothing was saved." }
        : { kind: "note", tone: "red", text: `Broke: ${String(e)}` }
    );
    pending = null;
  } finally {
    if (activePromptController === controller) activePromptController = null;
    busy = false;
    emit();
  }
}

// An edit in flight, waiting for a "Which one?" answer.
let pendingEditRequest: string | null = null;
// items.length when the question was asked — an answer arrives within a turn
// or two; anything later routes normally instead of firing the old request.
let pendingEditAskedAt = 0;

async function runEdit(target: EditTarget, request: string) {
  // The patch base is the record's CURRENT state — a draft may have been
  // pinned or re-edited since the target was picked (the v0 disease: patching
  // a stale copy silently reverts the user's tweaks).
  let auto = target.record;
  if (target.builtItemId !== null) {
    const host = builtItem(target.builtItemId);
    const cur = host?.result.automations.find((a) => a.id === auto.id);
    if (cur) auto = cur;
  } else {
    auto = getState().automations.records.find((r) => r.id === auto.id) ?? auto;
  }

  const controller = new AbortController();
  activePromptController = controller;
  busy = true;
  const progress = push({
    kind: "progress",
    stage: "draft",
    text: `Patching "${auto.name}"…`,
    startedAt: Date.now(),
  });
  try {
    const result = await editAutomation(auto, request, undefined, controller.signal);
    replace(progress.id, null);
    if (!result.ok || !result.after) {
      push({
        kind: "note",
        tone: "amber",
        text: result.failSentence ?? "The edit didn't land.",
      });
    } else if (target.builtItemId !== null) {
      applyDraftEdit(target.builtItemId, result);
    } else {
      push({
        kind: "edit",
        autoId: auto.id,
        builtItemId: null,
        result,
        state: "fresh",
      });
    }
  } catch (e) {
    replace(progress.id, null);
    push(
      controller.signal.aborted
        ? { kind: "note", tone: "gray", text: "Stopped by you. Nothing was changed." }
        : { kind: "note", tone: "red", text: `Broke: ${String(e)}` }
    );
  } finally {
    if (activePromptController === controller) activePromptController = null;
    busy = false;
    emit();
  }
}

// A question about an automation answers from the record — never the patcher.
// This is what makes an automation something you can TALK to: open it from
// the Library, ask "what can this do?", then keep upgrading it in words.
async function runExplain(record: AutomationRecord, question: string, history?: string) {
  const controller = new AbortController();
  activePromptController = controller;
  busy = true;
  const progress = push({
    kind: "progress",
    stage: "draft",
    text: `Reading "${record.name}"…`,
    startedAt: Date.now(),
  });
  try {
    const model = await activeLocalModel();
    if (!model) throw new Error("No local model.");
    const result = await explainAutomation(record, question, model, history, controller.signal);
    replace(progress.id, null);
    if (!result.ok) {
      push({
        kind: "note",
        tone: "amber",
        text: result.failSentence ?? "Couldn't answer that one.",
      });
    } else {
      push({ kind: "explain", autoName: record.name, text: result.answer });
    }
  } catch (e) {
    replace(progress.id, null);
    push(
      controller.signal.aborted
        ? { kind: "note", tone: "gray", text: "Stopped by you." }
        : { kind: "note", tone: "red", text: `Broke: ${String(e)}` }
    );
  } finally {
    if (activePromptController === controller) activePromptController = null;
    busy = false;
    emit();
  }
}

// A draft edit mutates the built card in place (the Zapier/GPT-builder
// pattern: one open draft, follow-ups change IT) and drops an already-kept
// edit card as the visible change summary — Put it back reverses it.
function applyDraftEdit(builtItemId: number, result: EditResult) {
  const host = builtItem(builtItemId);
  if (!host || !result.after) return;
  result.after.origin = { kind: "edited", at: Date.now() };
  const autos = host.result.automations.map((a) =>
    a.id === result.after!.id ? result.after! : a
  );
  // A watched run stays earned through cosmetic patches; changing what the
  // job actually DOES — including which apps, tools, and knowledge bases it
  // may touch — demands a fresh watched run before Save.
  const execChanged = result.changed.some((c) =>
    [
      "steps",
      "sources",
      "files",
      "inputs",
      "outputs",
      "delivers",
      "apps",
      "tools",
      "knowledge",
    ].includes(c.key)
  );
  patchBuilt(builtItemId, {
    result: { ...host.result, automations: autos },
    ...(host.state === "ran" && execChanged
      ? { state: "fresh" as const, runId: host.runId }
      : {}),
  });
  push({
    kind: "edit",
    autoId: result.after.id,
    builtItemId,
    result,
    state: "kept",
  });
}

// Same job, same content? name is deliberately OUTSIDE the content hash
// (renames must not re-earn approval), so an honest "is this still the
// record my card described" check needs both.
function sameRecord(a: AutomationRecord, b: AutomationRecord): boolean {
  return a.name === b.name && automationContentHash(a) === automationContentHash(b);
}

// A card whose before/after no longer matches reality must SAY so, never
// silently clobber the newer change with its stale copy.
function markStale(item: ChatItem & { kind: "edit" }, verb: string) {
  replace(item.id, { ...item, state: "stale" });
  push({
    kind: "note",
    tone: "amber",
    text: `"${item.result.before.name}" has changed again since this card — nothing was ${verb}. Use the newest change card, or just say the change again.`,
  });
}

// Keep it: the patched record becomes current (the old version is kept for
// Put it back — last ~10).
export async function keepEdit(itemId: number) {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.kind !== "edit" || item.state !== "fresh" || !item.result.after)
    return;
  // The patch was drawn against item.result.before — if the record moved on
  // (another card was kept first), saving this after would erase that change.
  const current = getState().automations.records.find((r) => r.id === item.autoId);
  if (current && !sameRecord(current, item.result.before)) {
    markStale(item, "kept");
    return;
  }
  item.result.after.origin = { kind: "edited", at: Date.now() };
  await saveAutomation(item.result.after);
  replace(itemId, { ...item, state: "kept" });
}

// Put it back (fresh card): the change never touched the store — just wave
// the card away.
export function dropEdit(itemId: number) {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.kind !== "edit" || item.state !== "fresh") return;
  replace(itemId, { ...item, state: "dropped" });
}

export async function revertEdit(itemId: number) {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.kind !== "edit" || item.state !== "kept" || !item.result.after)
    return;
  if (item.builtItemId !== null) {
    // Draft edits never touched the store — put the before-record back into
    // the built card, but only if the draft still IS what this card made
    // (a later follow-up edit must not be silently thrown away).
    const host = builtItem(item.builtItemId);
    if (host) {
      if (host.state === "saved") {
        // The draft was SAVED after this edit — the record lives in the
        // store now. Reverting only the card would leave the Library (and
        // the scheduler) running the edit while the chat claims "Put back."
        const current = getState().automations.records.find(
          (r) => r.id === item.autoId
        );
        if (!current || !sameRecord(current, item.result.after)) {
          markStale(item, "put back");
          return;
        }
        await saveAutomation(item.result.before);
        patchBuilt(item.builtItemId, {
          result: {
            ...host.result,
            automations: host.result.automations.map((a) =>
              a.id === item.autoId ? item.result.before : a
            ),
          },
        });
        replace(itemId, { ...item, state: "reverted" });
        return;
      }
      const cur = host.result.automations.find((a) => a.id === item.autoId);
      if (cur && !sameRecord(cur, item.result.after)) {
        markStale(item, "put back");
        return;
      }
      patchBuilt(item.builtItemId, {
        result: {
          ...host.result,
          automations: host.result.automations.map((a) =>
            a.id === item.autoId ? item.result.before : a
          ),
        },
      });
    }
  } else {
    // Restore THIS card's before-record. restoreVersion (newest version off
    // the pile) is wrong here twice over: a rename keeps no version at all
    // (name is outside the content hash), and an older pile entry may not be
    // this card's before. saveAutomation versions the replaced current, so
    // redo stays possible.
    const current = getState().automations.records.find((r) => r.id === item.autoId);
    if (!current || !sameRecord(current, item.result.after)) {
      markStale(item, "put back");
      return;
    }
    await saveAutomation(item.result.before);
  }
  replace(itemId, { ...item, state: "reverted" });
}

// "Connect A and B" — a sequence built deterministically from records that
// already exist, exactly the way the Library's Sequence builder would:
// sequential links, outputs auto-wired to same-named inputs, permissions
// merged, member revisions pinned. No model call — nothing is re-drafted.
// One shared builder (pipeline/sequence.ts) so a sequence made by naming
// saved automations and one made from a single "a sequence of X and Y"
// sentence are the same object, built the same way.
function buildSequenceRecord(
  members: AutomationRecord[],
  name: string | null
): ChainRecord | null {
  return sequenceFrom(members, name);
}

// The connected sequence lands as a normal built card: Try it once runs the
// whole line watched (each step answers in its own bubble), Save keeps it.
// Connecting is itself a recorded action — Activity shows it like any other,
// and the card's runId points at a REAL record rather than a minted id.
async function pushSequenceCard(input: AutomationRecord[], text: string) {
  const members = input.filter(
    (m, i) => input.findIndex((x) => x.id === m.id) === i
  );
  if (members.length < 2) {
    push({
      kind: "note",
      tone: "amber",
      text: "A sequence needs two different automations — name the second one and I'll connect them.",
    });
    return;
  }
  const custom = text.match(SEQUENCE_NAME_RE)?.[1]?.trim() ?? null;
  const chain = buildSequenceRecord(members, custom);
  if (!chain) return; // guarded above; belt and braces for the shared builder
  const order = members.map((m) => m.name).join(" → ");
  const summary = `Connected ${order} into "${chain.name}" — no automation was re-drafted.`;
  const runId = newId("run");
  const at = Date.now();
  await appendRun({
    id: runId,
    automationId: members[0].id,
    chainId: chain.id,
    stepIndex: null,
    cause: "you asked to connect automations",
    startedAt: at,
    finishedAt: at,
    status: "ok",
    ranOn: "local",
    sandbox: null,
    baton: null,
    summary,
    stages: [],
    events: [],
    counters: { drafts: 0, fieldsFixed: 0, questionCard: false },
    didNotDo: [],
    diff: null,
    answer: null,
  });
  push({
    kind: "built",
    result: {
      ok: true,
      automations: members,
      chain,
      question: null,
      argument: [
        `Connected ${order} — nothing was re-drafted. Try it once to watch the whole sequence run, then Save keeps it in the Library.`,
      ],
      failSentence: null,
      runId,
      keptToOneStep: false,
    },
    state: "fresh",
    runId: null,
    chainRunIds: null,
    progress: null,
    keepSentence: null,
  });
}

// Growing a sequence that already exists. Same card as building a fresh one,
// but the chain keeps its id — so Save updates it in place and its version
// history survives, instead of leaving a near-duplicate behind.
async function pushSequenceChangeCard(
  before: ChainRecord,
  after: ChainRecord,
  _text: string
) {
  const saved = getState().automations.records;
  const idOf = (c: ChainRecord) =>
    c.steps?.length
      ? c.steps.map((s) => s.automationId)
      : [...new Set(c.links.flatMap((l) => [l.from, l.to]))];
  const beforeIds = new Set(idOf(before));
  const addedIds = idOf(after).filter((id) => !beforeIds.has(id));
  const named = (id: string) =>
    saved.find((a) => a.id === id)?.name ?? "an automation";
  const addedNames = addedIds.map(named);
  const members = idOf(after)
    .map((id) => saved.find((a) => a.id === id))
    .filter((m): m is AutomationRecord => Boolean(m));

  const summary = `Added ${addedNames
    .map((n) => `"${n}"`)
    .join(" and ")} to the end of "${after.name}" — ${
    beforeIds.size
  } step${beforeIds.size === 1 ? "" : "s"} became ${idOf(after).length}.`;
  const runId = newId("run");
  const at = Date.now();
  await appendRun({
    id: runId,
    automationId: addedIds[0] ?? members[0]?.id ?? "",
    chainId: after.id,
    stepIndex: null,
    cause: "you asked to add to a sequence",
    startedAt: at,
    finishedAt: at,
    status: "ok",
    ranOn: "local",
    sandbox: null,
    baton: null,
    summary,
    stages: [],
    events: [],
    counters: { drafts: 0, fieldsFixed: 0, questionCard: false },
    didNotDo: [],
    diff: null,
    answer: null,
  });
  push({
    kind: "built",
    result: {
      ok: true,
      automations: members,
      chain: after,
      question: null,
      argument: [
        `${summary} Nothing was re-drafted, and "${after.name}" keeps its history — Save updates the sequence you already had.`,
      ],
      failSentence: null,
      runId,
      keptToOneStep: false,
    },
    state: "fresh",
    runId: null,
    chainRunIds: null,
    progress: null,
    keepSentence: null,
  });
}

// The card for a conditional built from one sentence: two automations and the
// branch between them, none of it re-drafted.
async function pushConditionalCard(
  members: AutomationRecord[],
  chain: ChainRecord,
  contains: string
) {
  const summary = `Built "${members[0].name}" and "${members[1].name}", and linked them so the second only runs when the first mentions "${contains}".`;
  const runId = newId("run");
  const at = Date.now();
  await appendRun({
    id: runId,
    automationId: members[0].id,
    chainId: chain.id,
    stepIndex: null,
    cause: "you described a job with a condition",
    startedAt: at,
    finishedAt: at,
    status: "ok",
    ranOn: "local",
    sandbox: null,
    baton: null,
    summary,
    stages: [],
    events: [],
    counters: { drafts: 0, fieldsFixed: 0, questionCard: false },
    didNotDo: [],
    diff: null,
    answer: null,
  });
  push({
    kind: "built",
    result: {
      ok: true,
      automations: members,
      chain,
      question: null,
      argument: [summary],
      failSentence: null,
      runId,
      keptToOneStep: false,
    },
    state: "fresh",
    runId: null,
    chainRunIds: null,
    progress: null,
    keepSentence: null,
  });
}

// A one-tap "Which one?" card — a delta with an ambiguous target never
// guesses and never falls through to a fresh build.
function askWhichOne(targets: EditTarget[], request: string) {
  pendingEditRequest = request;
  pendingEditAskedAt = items.length;
  push({
    kind: "question",
    q: {
      asking: "Which one?",
      term: request,
      kind: "automation",
      options: targets.map((t) => ({
        label: `${t.record.name}${t.builtItemId === null ? "" : " (unsaved draft)"}`,
        value: t.record.name,
      })),
    },
    answered: null,
    runId: null,
  });
}

export async function sendText(text: string) {
  if (busy || !text.trim()) return;
  const saved = getState().automations.records;
  const references = pendingReferences;
  pendingReferences = [];
  // The digest is rendered BEFORE this message joins the thread — the
  // request itself rides separately as userText.
  const thread = scopedItems();
  const history = renderHistory(thread, saved);
  push({ kind: "user", text, references });

  // An open question card? The typed text is its answer.
  const lastQuestion = [...thread]
    .reverse()
    .find((i) => i.kind === "question" && i.answered === null) as
    | (ChatItem & { kind: "question" })
    | undefined;

  if (lastQuestion && pendingEditRequest) {
    // A which-one answer comes NEXT, not three topics later — a stale stored
    // request must never ambush an unrelated message.
    if (items.length - pendingEditAskedAt > 6) {
      pendingEditRequest = null;
    } else {
      // Exact name first, then a natural answer that uniquely names one
      // ("the Tech News one" → Tech News).
      const exact = findTargetNamed(text, thread, saved);
      const loose = exact ? [] : findTargetsByName(text, thread, saved);
      const target = exact ?? (loose.length === 1 ? loose[0] : null);
      if (target) {
        replace(lastQuestion.id, { ...lastQuestion, answered: text });
        const request = pendingEditRequest;
        pendingEditRequest = null;
        // A reply that carries its own change ("actually change Tech News to
        // 8am") wins over the stored request — replaying the old one would
        // silently discard what the person just said.
        await runEdit(target, DELTA_VERB_RE.test(text) ? text : request);
        return;
      }
      // Not a name — a correction or a new thought ("actually make it 8am").
      // The which-one question stays open; the message routes normally instead
      // of dead-ending on an amber "No automation is named that".
    }
  }

  if (lastQuestion && pending) {
    replace(lastQuestion.id, { ...lastQuestion, answered: text });
    await rememberAlias(lastQuestion.q.asking, text);
    await resolveQuestionRun(lastQuestion.runId, text);
    await runCompile({
      ...pending,
      answers: [
        ...pending.answers,
        { asking: lastQuestion.q.asking, answer: text },
      ],
    });
    return;
  }

  // "make a change to the schedule" ASKS for an edit — NEW_TASK_RE's bare
  // "make a…" must not read it as a fresh job. And copy-intent words
  // ("another", "a second") only mean "build a variant" when the message also
  // NAMES an automation — "send it to another email" changes a field, it
  // doesn't ask for a second automation.
  const asksNewThing = NEW_TASK_RE.test(text) && !CHANGE_NOUN_RE.test(text);
  const asksVariant = () =>
    COPY_INTENT_RE.test(text) &&
    findTargetsByName(text, thread, saved).length > 0;

  // An Automation Studio is an explicit scope for THIS record: a question
  // answers from it, an instruction edits it — but "make me a NEW automation"
  // is never an edit of this one; it falls through to a fresh compile.
  if (activeAutomationId && !asksNewThing && !asksVariant()) {
    const record = saved.find((candidate) => candidate.id === activeAutomationId);
    if (record) {
      if (isQuestionAbout(text)) {
        await runExplain(record, text, history);
      } else {
        await runEdit({ record, builtItemId: null }, text);
      }
      return;
    }
  }

  // A single structured reference: questions answer from it, instructions
  // edit it — no need to repeat its name either way.
  if (references.length === 1 && !asksNewThing && !asksVariant()) {
    const record = saved.find(
      (candidate) => candidate.id === references[0].automationId
    );
    if (record) {
      if (isQuestionAbout(text)) {
        await runExplain(record, text, history);
      } else {
        await runEdit({ record, builtItemId: null }, text);
      }
      return;
    }
  }

  // A named SEQUENCE is a thing you can talk to as well: "what does the
  // Bitcoin Morning Briefing do?" is answered from the record itself — no
  // model, no guessing. Without this the message names nothing the
  // automation tiers recognize and compiles a junk lookalike.
  const namedChain = findChainByName(text, getState().chains.records);
  if (namedChain && !NEW_TASK_RE.test(text)) {
    if (isQuestionAbout(text)) {
      push({
        kind: "explain",
        autoName: namedChain.name,
        text: describeChain(namedChain, saved),
      });
      return;
    }
    // A change aimed at the sequence itself. Chat can't rewire sequences
    // yet — say where it CAN be done rather than compiling something new.
    if (DELTA_VERB_RE.test(text) || ADD_SHAPE_RE.test(text)) {
      push({
        kind: "note",
        tone: "amber",
        text: `Changing "${namedChain.name}" isn't something I can do from chat yet — open it in the Library's Sequence builder. I can build you a fresh sequence though: name the automations and say "connect them".`,
      });
      return;
    }
  }

  // ---- sequences by talking ----
  // "connect A and B", "put these together", "make an automation for X and
  // one for Y as a chain" — every wording of "these should run as one
  // connected thing". A chain WORD alone proves nothing ("supply chain
  // news"); it starts meaning something next to two named automations, a
  // plural pointer, or an explicit as-a-chain shape.
  // "make a sequence to check my gmail, if someone emailed me, summarize it"
  // is two jobs and a condition. The drafter will not take that apart — the
  // seam is in the words, so split it here, compile each half as ONE job
  // (which a small model does reliably), and build the branch in code.
  const conditional =
    CHAIN_REQUEST_RE.test(text) && BRANCH_INTENT.test(text)
      ? splitConditional(text)
      : null;
  if (conditional) {
    const before = new Set(getState().automations.records.map((a) => a.id));
    const madeIn = (seg: string) =>
      runCompile({
        userText: seg,
        answers: [],
        history: renderHistory(scopedItems(), saved),
        singleJob: true,
      });
    await madeIn(conditional.check);
    if (!pending) await madeIn(conditional.then);
    // Whatever the two compiles produced, newest last.
    const pair: AutomationRecord[] = [];
    for (const item of scopedItems()) {
      if (item.kind !== "built" || item.state === "discarded") continue;
      for (const record of item.result.automations)
        if (!before.has(record.id) && !pair.some((p) => p.id === record.id))
          pair.push(record);
    }
    if (pair.length >= 2) {
      const chain = conditionalSequenceFrom(
        pair[pair.length - 2],
        pair[pair.length - 1],
        conditional.contains,
        null
      );
      if (chain) {
        await pushConditionalCard(pair.slice(-2), chain, conditional.contains);
        return;
      }
    }
    return;
  }

  if (CHAIN_TALK_RE.test(text)) {
    const chainNamed = findTargetsByName(text, thread, saved);
    // "make an automation that combines Top Tech News and Bitcoin Note into
    // one summary" asks for a NEW job that happens to mention two names —
    // building it beats wiring the two together. But "MAKE A SEQUENCE from
    // A and B" is a connect request whose noun happens to follow "make a".
    const asksNewAutomation =
      NEW_TASK_RE.test(text) && !MAKE_A_SEQUENCE_RE.test(text);
    if (chainNamed.length >= 2 && !asksNewAutomation) {
      // Existing automations, named: connect them in the order they were
      // said. Deterministic — no model, no re-drafting.
      const members = [...chainNamed]
        .sort(
          (a, b) =>
            mentionIndex(text, a.record.name) - mentionIndex(text, b.record.name)
        )
        .map((t) => t.record);
      await pushSequenceCard(members, text);
      return;
    }
    // "connect this to the Bitcoin Morning Briefing" — pointing INTO an
    // existing sequence. Chat can't edit sequences yet; say so instead of
    // compiling junk.
    const chainMention = getState().chains.records.find((c) =>
      new RegExp(
        `\\b${c.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`,
        "i"
      ).test(text)
    );
    if (chainMention && chainNamed.length >= 1) {
      // "add the tesla check to the Bitcoin Morning Briefing" — grow the
      // sequence that already exists. Appending keeps its id, so its history
      // and pinned member revisions survive; rebuilding would throw both away.
      const saved = getState().automations.records;
      const grown = appendToSequence(
        chainMention,
        chainNamed.map((t) => t.record),
        (id) => saved.find((a) => a.id === id)
      );
      if (!grown) {
        push({
          kind: "note",
          tone: "gray",
          text: `${chainNamed.map((t) => `"${t.record.name}"`).join(" and ")} ${
            chainNamed.length > 1 ? "are" : "is"
          } already in "${chainMention.name}" — nothing to add.`,
        });
        return;
      }
      await pushSequenceChangeCard(chainMention, grown, text);
      return;
    }
    // Exactly one name + chain talk ("combine the two steps in X") is about
    // THAT automation, not about connecting the thread's recent pair — only
    // a nameless plural pointer reaches for the thread.
    if (chainNamed.length === 0 && PLURAL_REF_RE.test(text) && !asksNewAutomation) {
      // "connect these two" — the thread knows which ones.
      const recent = recentAutomationRecords(thread, saved);
      if (recent.length >= 2) {
        await pushSequenceCard(recent, text);
        return;
      }
      push({
        kind: "note",
        tone: "amber",
        text: 'Tell me which automations to connect — like "connect Bitcoin Price Check and Bitcoin Email Summary".',
      });
      return;
    }
    if (CHAIN_REQUEST_RE.test(text)) {
      // A BUILD request that wants its jobs connected ("make an automation
      // for X and one for Y, as a chain") — compile the whole text as one
      // call, never split into independent jobs: the drafter sees the chain
      // ask (chainIntent) and must join what it drafts.
      await runCompile({
        userText: `${text}${referenceContext(references, saved)}`,
        answers: [],
        history,
      });
      return;
    }
    // A chain word with no other evidence — a topic, not a request. Fall
    // through to normal routing.
  }

  // "…and another automation to check meta" = independent jobs. Split before
  // drafting: one compile per job, each with the digest (so job 2 sees job
  // 1's card and doesn't re-create it), chain null by construction.
  const segments = splitCoordination(text);
  if (segments.length > 1) {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      // Each segment routes on its own: a segment that names a saved/drafted
      // automation to CHANGE it patches that record (a duplicate compile would
      // otherwise leave the real one untouched); everything else compiles as
      // one job.
      const segNamed = findTargetsByName(seg, scopedItems(), saved);
      // Only the FIRST segment can be an edit: every later one was introduced
      // by an explicit "and another automation to…" marker that the splitter
      // consumed, so it is a new job by construction.
      if (
        i === 0 &&
        segNamed.length === 1 &&
        DELTA_VERB_RE.test(seg) &&
        !NEW_TASK_RE.test(seg)
      ) {
        await runEdit(segNamed[0], seg);
      } else {
        await runCompile({
          userText: seg,
          answers: [],
          history: renderHistory(scopedItems(), saved),
          singleJob: true, // a split segment is one job by construction
        });
      }
      // A segment that opened a question owns the conversation now — running
      // the next segment would clobber its pending context and orphan the
      // card. Stop and say what's left rather than silently dropping it.
      if (pending && i < segments.length - 1) {
        push({
          kind: "note",
          tone: "gray",
          text: "Answer the question above first — then send me the rest of that request.",
        });
        break;
      }
    }
    return;
  }

  // A named automation — drafts on built cards are first-class targets, so
  // "schedule the tech news one for 9am" patches the unsaved draft instead
  // of re-building it.
  // A saved automation's name is ordinary topic vocabulary ("Bitcoin Price",
  // "Top Tech News"), so a bare name match must NOT mean "edit this" — the
  // message also has to ask for a CHANGE. "alert me when the bitcoin price
  // drops" names a topic and is a new job; "change Bitcoin Price to 9am" is
  // an edit. (Questions about a named automation still route to explain.)
  const named = findTargetsByName(text, thread, saved);
  // "add the weather to Morning Brief": an ADD aimed AT the named automation
  // (name behind to/on/in) is an edit of IT — without this, the anchored
  // delta-verb check drops the name and the follow-up tier patches whatever
  // card happens to be newest. "add Solana Watcher to my chain" stays a
  // non-edit: there the name sits in front of the preposition.
  if (
    !NEW_TASK_RE.test(text) &&
    ADD_SHAPE_RE.test(text) &&
    named.length >= 1
  ) {
    const aimedAt = named.filter((t) =>
      nameAfterPreposition(text, t.record.name)
    );
    if (aimedAt.length === 1) {
      await runEdit(aimedAt[0], text);
      return;
    }
    if (aimedAt.length > 1) {
      askWhichOne(aimedAt, text);
      return;
    }
  }
  const namedIsTarget =
    !NEW_TASK_RE.test(text) &&
    (DELTA_VERB_RE.test(text) || isQuestionAbout(text));
  if (named.length === 1 && namedIsTarget) {
    if (isQuestionAbout(text)) {
      await runExplain(named[0].record, text, history);
      return;
    }
    // "a second Morning Brief for the weekend" names an automation only to ask
    // for a VARIANT — compile it fresh, don't patch the original.
    // A plain mention such as "Bitcoin price and 24-hour change" is also a
    // fresh job unless it starts with a real change directive.
    if (DELTA_VERB_RE.test(text) && !COPY_INTENT_RE.test(text)) {
      await runEdit(named[0], text);
      return;
    }
  }
  // Several names matched: only ask "which one?" when the message actually
  // asks for a CHANGE — otherwise it just mentions two topics and belongs in
  // a fresh compile (a question about two automations isn't a patch target).
  if (
    named.length > 1 &&
    !NEW_TASK_RE.test(text) &&
    DELTA_VERB_RE.test(text)
  ) {
    // "rename A to B" names its target unambiguously — A, the part before
    // to/as. B is the NEW name; when B collides with another automation the
    // edit pass refuses with a sentence, which beats asking "Which one?"
    // about a name that was never a target.
    const renameShape =
      text.match(/^\s*(?:rename|call)\s+(.+?)\s+(?:to|as)\s+/i) ??
      text.match(/^\s*(?:change|set|update)\s+(?:the\s+)?(?:name|title)\s+of\s+(.+?)\s+to\s+/i);
    if (renameShape) {
      const head = renameShape[1].toLowerCase();
      const inHead = named.filter((t) =>
        head.includes(t.record.name.toLowerCase())
      );
      if (inHead.length === 1) {
        await runEdit(inHead[0], text);
        return;
      }
    }
    askWhichOne(named, text);
    return;
  }

  // Deixis: "schedule this for 9am", "change the time" — the thread knows
  // what "this" is; the model never sees the bare pronoun.
  if (
    !NEW_TASK_RE.test(text) &&
    DELTA_VERB_RE.test(text) &&
    // A real pronoun aimed at the focus, OR a schedule tweak that names an
    // existing FIELD ("change the time to 9am"). TIMEY alone is not enough —
    // "set up a daily backup of my Documents folder" is a new job, not an edit.
    (DEIXIS_RE.test(text) || (TIMEY_RE.test(text) && SCHEDULE_FIELD_RE.test(text)))
  ) {
    const focus = focusTargets(thread, saved);
    if (focus.length === 1) {
      await runEdit(focus[0], rewriteDeixis(text, focus[0].record.name));
      return;
    }
    if (focus.length > 1) {
      askWhichOne(focus, text);
      return;
    }
    // Nothing in the thread to point at (cleared chat, discarded cards) —
    // but "change the schedule to 8am" is unmistakably an edit of SOMETHING
    // saved. Compiling a junk job out of a bare field tweak helps no one:
    // ask which one, or with too many, ask for the name.
    if (saved.length === 1) {
      await runEdit(
        { record: saved[0], builtItemId: null },
        rewriteDeixis(text, saved[0].name)
      );
      return;
    }
    if (saved.length > 1 && saved.length <= 6) {
      askWhichOne(
        saved.map((record) => ({ record, builtItemId: null })),
        text
      );
      return;
    }
    if (saved.length > 6) {
      push({
        kind: "note",
        tone: "gray",
        text: 'Which automation should I change? Say its name — e.g. "change Bitcoin Price to 8am".',
      });
      return;
    }
    // No saved automations at all — fall through to a fresh compile.
  }

  // A HINTED follow-up ("can you also…", "add…", "now show…") right after a
  // built card is usually ABOUT that card — but no regex can be sure. Before
  // it can compile as a brand-new automation (or get grabbed by a keyword
  // template), one tiny local call thinks about what was actually prompted.
  // Copy-intent with a NAMED automation ("make another Morning Brief for the
  // weekend") is a variant request — never a patch of the original.
  if (
    !NEW_TASK_RE.test(text) &&
    FOLLOWUP_HINT_RE.test(text.trim()) &&
    !(COPY_INTENT_RE.test(text) && named.length > 0)
  ) {
    const focus = focusTargets(thread, saved);
    if (focus.length === 1) {
      const model = await activeLocalModel().catch(() => null);
      if (model) {
        const intent = await classifyFollowUp(
          text,
          { name: focus[0].record.name, sentence: focus[0].record.sentence },
          model
        );
        // Trust EDIT only with evidence the message is ABOUT that card: a
        // pronoun aimed at it, or a real word in common with what it does.
        // Without this, a primed "EDIT" from a small model turns a brand-new
        // request into a patch of the last automation.
        const refers =
          DEIXIS_RE.test(text) ||
          ELLIPTICAL_RE.test(text.trim()) ||
          refersToFocus(text, {
            name: focus[0].record.name,
            sentence: focus[0].record.sentence,
            steps: focus[0].record.steps,
            sources: focus[0].record.sources,
          });
        if (intent === "edit" && refers) {
          await runEdit(focus[0], rewriteDeixis(text, focus[0].record.name));
          return;
        }
        if (intent === "question") {
          await runExplain(focus[0].record, text, history);
          return;
        }
        // "new" (or junk) falls through to the compile below.
      }
    }
  }

  await runCompile({
    userText: `${text}${referenceContext(references, saved)}`,
    answers: [],
    history,
  });
}

export async function pickOption(itemId: number, value: string) {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.kind !== "question" || item.answered !== null) return;

  if (pendingEditRequest) {
    replace(itemId, { ...item, answered: value });
    const target = findTargetNamed(
      value,
      scopedItems(),
      getState().automations.records
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
    ...pending,
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
    s.permissions ??= {
      fullAccess: false,
      approvedRevisions: {},
      approvedWorkflowRevisions: {},
      approvedDirectories: [],
    };
    if (!s.permissions.approvedDirectories.includes(dir))
      s.permissions.approvedDirectories.push(dir);
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

// ---- Watch me: recording → consent strip → the same compile pipe ----
import {
  CaptureError,
  DisplayFrameSource,
  FixtureFrameSource,
  FrameSource,
  MicRecorder,
} from "../watchme/capture";
import { KeyframeStore } from "../watchme/keyframes";
import { SttError, ensureModel, transcribe } from "../watchme/transcribe";
import {
  VisionUnavailable,
  enrichFrames,
  enrichmentEvidence,
} from "../watchme/enrich";

interface WatchSession {
  itemId: number;
  source: FrameSource;
  mic: MicRecorder | null;
  store: KeyframeStore;
  narration: Blob | null;
}

let watchSession: WatchSession | null = null;

function watchItem(itemId: number) {
  const item = items.find((i) => i.id === itemId);
  return item && item.kind === "watchme" ? item : null;
}

function patchWatch(
  itemId: number,
  patch: Partial<Extract<ChatItem, { kind: "watchme" }>>
) {
  const item = watchItem(itemId);
  if (!item) return;
  replace(itemId, { ...item, ...patch });
}

function syncThumbs(itemId: number, store: KeyframeStore) {
  patchWatch(itemId, {
    framesHeld: store.held,
    thumbs: store.frames.map((f) => ({
      tMs: f.tMs,
      url: f.thumbUrl,
      dropped: f.dropped,
    })),
  });
}

export function isWatching(): boolean {
  return (
    watchSession !== null &&
    watchItem(watchSession.itemId)?.state === "recording"
  );
}

export function hasNarration(itemId: number): boolean {
  return (
    watchSession?.itemId === itemId && watchSession.narration !== null
  );
}

export async function startWatchMe(fixture?: {
  frameUrls: string[];
  narration: Blob | null;
}): Promise<void> {
  if (watchSession) return;
  const item = push({
    kind: "watchme",
    state: "recording",
    framesHeld: 0,
    startedAt: Date.now(),
    thumbs: [],
    reason: null,
    micOk: true,
  });

  const store = new KeyframeStore();
  store.onChange = () => syncThumbs(item.id, store);
  const source: FrameSource = fixture
    ? new FixtureFrameSource(fixture.frameUrls)
    : new DisplayFrameSource();
  source.onEnded = () => void stopWatchMe();

  let mic: MicRecorder | null = null;
  let micOk = true;
  let reason: string | null = null;

  if (!fixture) {
    mic = new MicRecorder();
    try {
      await mic.start();
    } catch (e) {
      micOk = false;
      mic = null;
      reason =
        e instanceof CaptureError
          ? e.sentence
          : "The microphone wasn't allowed.";
    }
  }

  watchSession = {
    itemId: item.id,
    source,
    mic,
    store,
    narration: fixture?.narration ?? null,
  };
  patchWatch(item.id, { micOk, reason });

  try {
    await source.start((frame, tMs) => void store.offer(frame, tMs));
  } catch (e) {
    // Screen failed — the ladder degrades to words-only or plain typing.
    const sentence =
      e instanceof CaptureError ? e.sentence : `Couldn't record — ${String(e)}`;
    if (mic || fixture) {
      patchWatch(item.id, { reason: sentence });
    } else {
      // Nothing works: fall back to the composer, honestly.
      watchSession = null;
      replace(item.id, {
        id: item.id,
        kind: "note",
        tone: "amber",
        text: `${sentence} Type what you want done instead.`,
      });
      return;
    }
  }
}

export async function stopWatchMe(): Promise<void> {
  const session = watchSession;
  if (!session) return;
  session.source.stop();
  if (session.mic) {
    session.narration = await session.mic.stop();
  }
  const state = watchItem(session.itemId);
  if (state?.state === "recording") {
    patchWatch(session.itemId, { state: "review" });
    syncThumbs(session.itemId, session.store);
  }
}

export function dropWatchFrame(itemId: number, tMs: number): void {
  const session = watchSession;
  if (!session || session.itemId !== itemId) return;
  session.store.drop(tMs);
}

export function discardWatchMe(itemId: number): void {
  const session = watchSession;
  if (!session || session.itemId !== itemId) return;
  session.source.stop();
  session.mic?.discard();
  session.store.burn();
  syncThumbs(itemId, session.store);
  watchSession = null;
  replace(itemId, {
    id: itemId,
    kind: "note",
    tone: "gray",
    text: "Thrown away — every frame and the recording deleted. Nothing was kept.",
  });
}

export async function compileFromDemo(
  itemId: number,
  wordsOnly: boolean
): Promise<void> {
  const session = watchSession;
  if (!session || session.itemId !== itemId || busy) return;

  let transcriptText = "";
  let segments: { fromMs: number; toMs: number; text: string }[] = [];
  let reason: string | null = null;

  // ---- listen back ----
  if (session.narration) {
    patchWatch(itemId, { state: "listening" });
    try {
      await ensureModel(() =>
        patchWatch(itemId, { state: "listening" })
      );
      const t = await transcribe(session.narration);
      transcriptText = t.text;
      segments = t.segments;
    } catch (e) {
      reason =
        e instanceof SttError
          ? e.sentence
          : `Listening back broke — ${String(e).slice(0, 80)}`;
    }
  } else {
    reason = watchItem(itemId)?.micOk
      ? "No narration was recorded."
      : (watchItem(itemId)?.reason ?? "No narration was recorded.");
  }

  if (!transcriptText) {
    // Rung 3: no words — frames alone are not enough to compile honestly.
    patchWatch(itemId, { state: "failed", reason:
      `${reason ?? "I couldn't hear you."} Type what you did instead — I'll use it with the frames.` });
    return;
  }

  // ---- read the frames (enrichment) ----
  let evidence: string | null = null;
  const kept = session.store.kept();
  if (!wordsOnly && kept.length > 0) {
    patchWatch(itemId, { state: "reading" });
    try {
      const model = await activeLocalModel();
      if (!model) throw new VisionUnavailable("No local model.");
      const enrichment = await enrichFrames(model, kept, segments);
      evidence = enrichmentEvidence(enrichment);
    } catch (e) {
      reason =
        e instanceof VisionUnavailable
          ? e.sentence
          : "I couldn't watch the screen, so I compiled from your words alone.";
    }
  }

  // ---- burn, then compile through the SAME pipe ----
  const frameCount = kept.length;
  session.store.burn();
  session.mic?.discard();
  watchSession = null;
  replace(itemId, {
    id: itemId,
    kind: "note",
    tone: "gray",
    text: `Recording deleted — ${frameCount} frame${frameCount === 1 ? "" : "s"} and the narration are gone.${reason ? ` ${reason}` : ""}`,
  });

  await runCompile({
    userText: "",
    answers: [],
    history: renderHistory(items, getState().automations.records),
    demo: {
      transcript: transcriptText,
      evidence,
      frames: evidence ? frameCount : 0,
    },
  });
}

// "type what you did instead" — the typed text takes the transcript's slot.
export async function compileFromTypedDemo(
  itemId: number,
  typed: string
): Promise<void> {
  const session = watchSession;
  if (!session || session.itemId !== itemId || !typed.trim()) return;
  session.narration = null;
  const kept = session.store.kept();
  let evidence: string | null = null;
  if (kept.length > 0) {
    patchWatch(itemId, { state: "reading" });
    try {
      const model = await activeLocalModel();
      if (model) {
        const enrichment = await enrichFrames(model, kept, []);
        evidence = enrichmentEvidence(enrichment);
      }
    } catch {
      // words alone
    }
  }
  const frameCount = kept.length;
  session.store.burn();
  watchSession = null;
  replace(itemId, {
    id: itemId,
    kind: "note",
    tone: "gray",
    text: `Recording deleted — ${frameCount} frame${frameCount === 1 ? "" : "s"} gone.`,
  });
  await runCompile({
    userText: "",
    answers: [],
    history: renderHistory(items, getState().automations.records),
    demo: { transcript: typed.trim(), evidence, frames: evidence ? frameCount : 0 },
  });
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

// Clear only the General chat scrollback. Saved automations, Activity runs,
// and every automation-scoped Studio conversation remain untouched.
export function clearGeneralChat(): void {
  if (busy || watchSession) return;
  items = items.filter(
    (item) => (item.scopeAutomationId ?? null) !== null
  );
  threadStates.general = {
    pending: null,
    pendingEditRequest: null,
    pendingReferences: [],
  };
  if (activeAutomationId === null) {
    pending = null;
    pendingEditRequest = null;
    pendingReferences = [];
    composerSeed = null;
  }
  emit();
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

function markBuiltTested(itemId: number): void {
  const item = builtItem(itemId);
  if (!item) return;
  patchBuilt(itemId, {
    result: {
      ...item.result,
      automations: item.result.automations.map((record) => {
        const normalized = normalizeAutomation(record);
        return {
          ...normalized,
          revision: { ...normalized.revision!, status: "tested" as const },
        };
      }),
    },
  });
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
  // Hold the conversation while the watched run executes — otherwise an edit
  // typed mid-run patches the draft the run isn't executing, and when the run
  // finishes the untested edit gets stamped "tested" and Save unlocks.
  busy = true;
  emit();
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
      } else if (run.status === "held" || (run.status === "needs_you" && !run.diff)) {
        // Nothing real happened — the watched run didn't earn Save. (A
        // needs_you WITH a diff is different: files changed, Keep waits.)
        patchBuilt(itemId, { state: "fresh", progress: null, runId: run.id });
        push({ kind: "note", tone: "amber", text: run.summary ?? "Held back." });
      } else {
        markBuiltTested(itemId);
        patchBuilt(itemId, { state: "ran", progress: null, runId: run.id });
        // The answer is a REPLY, not card furniture — it gets its own
        // assistant bubble below the card, rendered from the run record.
        if (run.status === "ok" && (run.answer ?? "").trim()) {
          push({ kind: "answer", autoName: autos[0].name, runId: run.id });
        }
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
      if (!broke) markBuiltTested(itemId);
      patchBuilt(itemId, {
        state: broke ? "fresh" : "ran",
        chainRunIds: runs.map((r) => r.id),
        progress: null,
        runId: runs[0]?.id ?? null,
      });
      if (broke) {
        const bad = runs.find((r) => r.status === "broke");
        push({ kind: "note", tone: "red", text: bad?.summary ?? "Broke." });
      }
      // Each step that answered gets its own labeled bubble, in run order.
      for (const r of runs) {
        if (r.status === "ok" && (r.answer ?? "").trim()) {
          const auto = autos.find((a) => a.id === r.automationId);
          push({ kind: "answer", autoName: auto?.name ?? "Automation", runId: r.id });
        }
      }
    }
  } catch (e) {
    patchBuilt(itemId, { state: "fresh", progress: null });
    push({ kind: "note", tone: "red", text: `Broke: ${String(e)}` });
  } finally {
    busy = false;
    emit();
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

// Parameterization: a demo-extracted fill-in can be pinned to its
// demonstrated value ("Always use this") — the input disappears and the
// steps get the literal. Reversible until Save.
export function pinDemoValue(itemId: number, autoId: string, inputName: string) {
  const item = builtItem(itemId);
  if (!item || item.state === "saved") return;
  const auto = item.result.automations.find((a) => a.id === autoId);
  const input = auto?.inputs.find((i) => i.name === inputName);
  if (!auto || !input) return;
  auto.inputs = auto.inputs.filter((i) => i.name !== inputName);
  auto.steps = auto.steps.map((s) =>
    s.split(`{${inputName}}`).join(input.example)
  );
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
