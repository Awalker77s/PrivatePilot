// Exactly three JSON files — automations.json, chains.json, runs.json —
// written via the atomic temp-file-then-rename pattern. No database.
// Saving an automation keeps its last ~10 record versions for Put-it-back.
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile } from "@tauri-apps/plugin-fs";
import { atomicWriteJson } from "./atomic";
import { isDesktopApp } from "../platform";
import type { AutomationRecord, ChainRecord, RunRecord } from "./types";
import {
  automationContentHash,
  normalizeAutomation,
  publishRevision,
  mergePermissionManifests,
  normalizeWorkflow,
  publishWorkflowRevision,
  workflowContentHash,
} from "./revisions";

const VERSIONS_KEPT = 10;

function keepRecentAndPinnedVersions(
  automationId: string,
  versions: AutomationRecord[]
): AutomationRecord[] {
  const pinned = new Set(
    [
      ...state.chains.records,
      ...Object.values(state.chains.versions).flat(),
    ].flatMap((chain) =>
      (chain.components ?? [])
        .filter((component) => component.automationId === automationId)
        .map((component) => component.revisionId)
    )
  );
  const kept = [
    ...versions.slice(0, VERSIONS_KEPT),
    ...versions.filter((record) =>
      record.revision ? pinned.has(record.revision.id) : false
    ),
  ];
  return kept.filter(
    (record, index) =>
      kept.findIndex((candidate) => candidate.revision?.id === record.revision?.id) ===
      index
  );
}

// The records are verbatim A5; the file containers wrap them so version
// history can live inside the same three files (see NOTES.md).
interface AutomationsFile {
  records: AutomationRecord[];
  versions: Record<string, AutomationRecord[]>; // newest first
}
interface ChainsFile {
  records: ChainRecord[];
  versions: Record<string, ChainRecord[]>;
}
interface RunsFile {
  records: RunRecord[]; // append-only
}

interface StoreState {
  automations: AutomationsFile;
  chains: ChainsFile;
  runs: RunsFile;
  loaded: boolean;
  loadError: string | null; // designed sentence when a store can't be read
}

const state: StoreState = {
  automations: { records: [], versions: {} },
  chains: { records: [], versions: {} },
  runs: { records: [] },
  loaded: false,
  loadError: null,
};

// ---- tiny pub/sub so React re-renders from the records, not model output ----
type Listener = () => void;
const listeners = new Set<Listener>();
let snapshotVersion = 0;

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSnapshotVersion(): number {
  return snapshotVersion;
}

function emit() {
  snapshotVersion++;
  for (const fn of listeners) fn();
}

export function getState(): Readonly<StoreState> {
  return state;
}

// ---- paths ----
let baseDirPromise: Promise<string> | null = null;

async function baseDir(): Promise<string> {
  if (!baseDirPromise) {
    baseDirPromise = (async () => {
      const dir = await appDataDir();
      if (!(await exists(dir))) await mkdir(dir, { recursive: true });
      return dir;
    })();
  }
  return baseDirPromise;
}

export async function storePath(
  name: "automations" | "chains" | "runs"
): Promise<string> {
  return join(await baseDir(), `${name}.json`);
}

// ---- load ----
type StoreName = "automations" | "chains" | "runs";

function browserStoreKey(name: StoreName): string {
  return `private-pilot:${name}`;
}

async function readStore<T>(name: StoreName, fallback: T): Promise<T> {
  if (!isDesktopApp()) {
    const text = localStorage.getItem(browserStoreKey(name));
    return text ? (JSON.parse(text) as T) : fallback;
  }
  const path = await join(await baseDir(), `${name}.json`);
  if (!(await exists(path))) return fallback;
  const text = await readTextFile(path);
  return JSON.parse(text) as T;
}

async function persistStore(name: StoreName, data: unknown): Promise<void> {
  if (!isDesktopApp()) {
    localStorage.setItem(browserStoreKey(name), JSON.stringify(data));
    return;
  }
  await atomicWriteJson(await storePath(name), data);
}

export async function loadAll(): Promise<void> {
  try {
    state.automations = await readStore("automations", {
      records: [],
      versions: {},
    });
    state.chains = await readStore("chains", { records: [], versions: {} });
    state.chains.versions ??= {};
    state.runs = await readStore("runs", { records: [] });
    state.automations.records = state.automations.records.map((record) =>
      normalizeAutomation(
        record,
        (state.automations.versions[record.id]?.length ?? 0) + 1
      )
    );
    for (const [id, versions] of Object.entries(state.automations.versions)) {
      state.automations.versions[id] = versions.map((record, index) =>
        normalizeAutomation(record, Math.max(1, versions.length - index))
      );
    }
    state.chains.records = state.chains.records.map((chain) => {
      const members = [...new Set(chain.links.flatMap((link) => [link.from, link.to]))]
        .map((automationId) => state.automations.records.find((a) => a.id === automationId))
        .filter((record): record is AutomationRecord => !!record);
      return normalizeWorkflow({
        ...chain,
        createdAt: chain.createdAt ?? Date.now(),
        components:
          chain.components ??
          members.map((record) => ({
            automationId: record.id,
            revisionId: record.revision!.id,
            revisionNumber: record.revision!.number,
          })),
        permissions: chain.permissions ?? mergePermissionManifests(members),
      }, (state.chains.versions[chain.id]?.length ?? 0) + 1);
    });
    for (const [id, versions] of Object.entries(state.chains.versions)) {
      state.chains.versions[id] = versions.map((workflow, index) =>
        normalizeWorkflow(workflow, Math.max(1, versions.length - index))
      );
    }
    await recoverInterruptedRuns();
    state.loaded = true;
    state.loadError = null;
  } catch (e) {
    // Never silent: a store that can't be read is a designed state.
    state.loaded = true;
    state.loadError = `Couldn't read the saved records — ${String(e)}`;
  }
  emit();
}

// A persisted "running" record cannot still belong to this fresh app
// process. Turn interrupted work into a designed failure instead of leaving
// Activity, tiles, and the red-dot system stuck in a forever-running state.
async function recoverInterruptedRuns(): Promise<void> {
  const interrupted = state.runs.records.filter((run) => run.status === "running");
  if (interrupted.length === 0) return;

  const recoveredAt = Date.now();
  const sentence = "The app closed before this run finished — run it again.";
  for (const run of interrupted) {
    run.status = "broke";
    run.finishedAt = recoveredAt;
    run.summary = sentence;
    const activeStage = [...run.stages]
      .reverse()
      .find((stage) => stage.status === "running");
    if (activeStage) {
      activeStage.status = "broke";
      activeStage.finishedAt = recoveredAt;
      activeStage.sentence = sentence;
    }
    run.events.push({
      at: recoveredAt,
      family: "broke",
      state: "Interrupted",
      sentence,
      anchor: `${run.id}#interrupted`,
    });

    const automation = state.automations.records.find(
      (candidate) => candidate.id === run.automationId
    );
    if (automation && (!automation.lastRun || automation.lastRun.at <= run.startedAt)) {
      automation.lastRun = { at: recoveredAt, status: "broke", summary: sentence };
    }
  }

  await persistStore("runs", state.runs);
  await persistStore("automations", state.automations);
}

// ---- automations (with version history) ----
export async function saveAutomation(record: AutomationRecord): Promise<void> {
  const file = state.automations;
  const idx = file.records.findIndex((r) => r.id === record.id);
  if (idx >= 0) {
    const prev = normalizeAutomation(file.records[idx]);
    const next = publishRevision(record, prev);
    if (automationContentHash(prev) !== automationContentHash(next)) {
      const versions = file.versions[record.id] ?? [];
      file.versions[record.id] = keepRecentAndPinnedVersions(record.id, [
        prev,
        ...versions,
      ]);
    }
    file.records[idx] = next;
  } else {
    file.records.push(publishRevision(record));
  }
  await persistStore("automations", file);
  emit();
}

export async function deleteAutomation(id: string): Promise<void> {
  const referenced = [
    ...state.chains.records,
    ...Object.values(state.chains.versions).flat(),
  ].some((workflow) =>
    (workflow.components ?? []).some(
      (component) => component.automationId === id
    )
  );
  if (referenced) return;
  const file = state.automations;
  file.records = file.records.filter((r) => r.id !== id);
  delete file.versions[id];
  await persistStore("automations", file);
  emit();
}

export function getAutomation(id: string): AutomationRecord | undefined {
  return state.automations.records.find((r) => r.id === id);
}

export function getAutomationRevision(
  id: string,
  revisionId: string
): AutomationRecord | undefined {
  const current = getAutomation(id);
  if (current?.revision?.id === revisionId) return current;
  return (state.automations.versions[id] ?? []).find(
    (record) => record.revision?.id === revisionId
  );
}

export function automationVersions(id: string): AutomationRecord[] {
  return state.automations.versions[id] ?? [];
}

// Put-it-back: restore the newest kept version (it becomes current; the
// replaced current is itself versioned so redo works).
export async function restoreVersion(id: string): Promise<boolean> {
  const versions = state.automations.versions[id] ?? [];
  const prev = versions[0];
  if (!prev) return false;
  const file = state.automations;
  const idx = file.records.findIndex((r) => r.id === id);
  if (idx < 0) return false;
  const current = file.records[idx];
  file.records[idx] = prev;
  file.versions[id] = [current, ...versions.slice(1)].slice(0, VERSIONS_KEPT);
  await persistStore("automations", file);
  emit();
  return true;
}

// ---- chains ----
export async function saveChain(record: ChainRecord): Promise<void> {
  const file = state.chains;
  const idx = file.records.findIndex((r) => r.id === record.id);
  if (idx >= 0) {
    const previous = normalizeWorkflow(file.records[idx]);
    const next = publishWorkflowRevision(record, previous);
    if (workflowContentHash(previous) !== workflowContentHash(next)) {
      file.versions[record.id] = [
        previous,
        ...(file.versions[record.id] ?? []),
      ].slice(0, VERSIONS_KEPT);
    }
    file.records[idx] = next;
  } else file.records.push(publishWorkflowRevision(record));
  await persistStore("chains", file);
  emit();
}

export async function deleteChain(id: string): Promise<void> {
  state.chains.records = state.chains.records.filter((r) => r.id !== id);
  delete state.chains.versions[id];
  await persistStore("chains", state.chains);
  emit();
}

export function workflowVersions(id: string): ChainRecord[] {
  return state.chains.versions[id] ?? [];
}

export async function restoreWorkflowVersion(
  id: string,
  revisionId?: string
): Promise<boolean> {
  const versions = state.chains.versions[id] ?? [];
  // Restore the version the person actually clicked — not always the newest.
  const pickIdx = revisionId
    ? versions.findIndex((v) => v.revision?.id === revisionId)
    : 0;
  const idx = pickIdx < 0 ? 0 : pickIdx;
  const previous = versions[idx];
  if (!previous) return false;
  const index = state.chains.records.findIndex((workflow) => workflow.id === id);
  if (index < 0) return false;
  const current = state.chains.records[index];
  // Swap: the current record goes to the head of history, the chosen version
  // becomes current, and the rest of history keeps its order.
  const rest = versions.filter((_, i) => i !== idx);
  state.chains.records[index] = previous;
  state.chains.versions[id] = [current, ...rest].slice(0, VERSIONS_KEPT);
  await persistStore("chains", state.chains);
  emit();
  return true;
}

// ---- runs (append-only; the chain resume checkpoint) ----
export async function appendRun(run: RunRecord): Promise<void> {
  state.runs.records.push(run);
  await persistStore("runs", state.runs);
  emit();
}

// A run's own record accumulates while it executes — appended, updated in
// place, never removed. Persist on meaningful transitions.
export async function updateRun(
  id: string,
  mutate: (run: RunRecord) => void,
  persist = true
): Promise<void> {
  const run = state.runs.records.find((r) => r.id === id);
  if (!run) return;
  mutate(run);
  if (persist) await persistStore("runs", state.runs);
  emit();
}

export function getRun(id: string): RunRecord | undefined {
  return state.runs.records.find((r) => r.id === id);
}

// ---- ids ----
export function newId(prefix: "auto" | "chain" | "run"): string {
  const s = Math.random().toString(36).slice(2, 6);
  const t = (Date.now() % 46656).toString(36);
  return `${prefix}-${s}${t}`;
}
