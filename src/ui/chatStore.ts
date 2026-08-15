// Chat state lives outside React so it survives tab switches. Items render
// from compile results (stored records + counters), never from raw model
// prose.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { readChatFile, writeChatFile } from "../storage/chat";
import {
  DEIXIS_RE,
  DELTA_VERB_RE,
  EditTarget,
  NEW_TASK_RE,
  TIMEY_RE,
  findTargetNamed,
  findTargetsByName,
  focusTargets,
  renderHistory,
  rewriteDeixis,
  splitCoordination,
} from "./memory";
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

type ChatItemVariant =
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
      // The built card holding the unsaved draft this edit patches — null
      // means the target is a saved record in the store.
      builtItemId: number | null;
      result: EditResult;
      state: "fresh" | "kept" | "reverted";
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
export type ChatItem = ChatItemVariant & { at?: number };

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
  scheduleSave();
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

function push(item: DistributiveOmit<ChatItemVariant, "id">): ChatItem {
  const it = { ...item, id: nextId++, at: Date.now() } as ChatItem;
  items = [...items, it];
  emit();
  return it;
}

// ---- Persistent chat memory: the thread survives restarts, so "this
// automation" typed tomorrow still points at something. ----
const CHAT_CAP = 200;
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
  return { list: list.slice(-CHAT_CAP), interrupted };
}

function scheduleSave() {
  if (!chatLoaded) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { list, interrupted } = serializableItems();
    void writeChatFile({
      v: 1,
      nextId,
      interrupted,
      pending,
      pendingEditRequest,
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
    const tail = loaded[loaded.length - 1];
    const tailOpenQuestion =
      tail?.kind === "question" && tail.answered === null;
    // Question cards that lost their compile context are inert — say so
    // instead of leaving dead buttons.
    loaded = loaded.map((i) =>
      i.kind === "question" &&
      i.answered === null &&
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
    pending = tailOpenQuestion
      ? ((disk.pending as DraftContext | null) ?? null)
      : null;
    pendingEditRequest = tailOpenQuestion
      ? (disk.pendingEditRequest ?? null)
      : null;
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
    push({ kind: "note", tone: "red", text: `Broke: ${String(e)}` });
  } finally {
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
  // job actually DOES demands a fresh watched run before Save.
  const execChanged = result.changed.some((c) =>
    ["steps", "sources", "files", "inputs", "delivers"].includes(c.key)
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

// Keep it: the patched record becomes current (the old version is kept for
// Put it back — last ~10).
export async function keepEdit(itemId: number) {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.kind !== "edit" || item.state !== "fresh" || !item.result.after)
    return;
  item.result.after.origin = { kind: "edited", at: Date.now() };
  await saveAutomation(item.result.after);
  replace(itemId, { ...item, state: "kept" });
}

export async function revertEdit(itemId: number) {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.kind !== "edit" || item.state !== "kept") return;
  if (item.builtItemId !== null) {
    // Draft edits never touched the store — put the before-record back into
    // the built card.
    const host = builtItem(item.builtItemId);
    if (host) {
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
    await restoreVersion(item.autoId);
  }
  replace(itemId, { ...item, state: "reverted" });
}

// A one-tap "Which one?" card — a delta with an ambiguous target never
// guesses and never falls through to a fresh build.
function askWhichOne(targets: EditTarget[], request: string) {
  pendingEditRequest = request;
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
  // The digest is rendered BEFORE this message joins the thread — the
  // request itself rides separately as userText.
  const history = renderHistory(items, saved);
  push({ kind: "user", text });

  // An open question card? The typed text is its answer.
  const lastQuestion = [...items]
    .reverse()
    .find((i) => i.kind === "question" && i.answered === null) as
    | (ChatItem & { kind: "question" })
    | undefined;

  if (lastQuestion && pendingEditRequest) {
    replace(lastQuestion.id, { ...lastQuestion, answered: text });
    const target = findTargetNamed(text, items, saved);
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
      ...pending,
      answers: [
        ...pending.answers,
        { asking: lastQuestion.q.asking, answer: text },
      ],
    });
    return;
  }

  // "…and another automation to check meta" = independent jobs. Split before
  // drafting: one compile per job, each with the digest (so job 2 sees job
  // 1's card and doesn't re-create it), chain null by construction.
  const segments = splitCoordination(text);
  if (segments.length > 1) {
    for (const seg of segments) {
      await runCompile({
        userText: seg,
        answers: [],
        history: renderHistory(items, saved),
      });
    }
    return;
  }

  // A named automation — drafts on built cards are first-class targets, so
  // "schedule the tech news one for 9am" patches the unsaved draft instead
  // of re-building it.
  const named = findTargetsByName(text, items, saved);
  if (named.length === 1 && !NEW_TASK_RE.test(text)) {
    await runEdit(named[0], text);
    return;
  }
  if (named.length > 1 && !NEW_TASK_RE.test(text)) {
    askWhichOne(named, text);
    return;
  }

  // Deixis: "schedule this for 9am", "change the time" — the thread knows
  // what "this" is; the model never sees the bare pronoun.
  if (
    !NEW_TASK_RE.test(text) &&
    DELTA_VERB_RE.test(text) &&
    (DEIXIS_RE.test(text) || TIMEY_RE.test(text))
  ) {
    const focus = focusTargets(items, saved);
    if (focus.length === 1) {
      await runEdit(focus[0], rewriteDeixis(text, focus[0].record.name));
      return;
    }
    if (focus.length > 1) {
      askWhichOne(focus, text);
      return;
    }
  }

  await runCompile({ userText: text, answers: [], history });
}

export async function pickOption(itemId: number, value: string) {
  const item = items.find((i) => i.id === itemId);
  if (!item || item.kind !== "question" || item.answered !== null) return;

  if (pendingEditRequest) {
    replace(itemId, { ...item, answered: value });
    const target = findTargetNamed(
      value,
      items,
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
      } else if (run.status === "held" || (run.status === "needs_you" && !run.diff)) {
        // Nothing real happened — the watched run didn't earn Save. (A
        // needs_you WITH a diff is different: files changed, Keep waits.)
        patchBuilt(itemId, { state: "fresh", progress: null, runId: run.id });
        push({ kind: "note", tone: "amber", text: run.summary ?? "Held back." });
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
