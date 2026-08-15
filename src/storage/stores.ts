// Exactly three JSON files — automations.json, chains.json, runs.json —
// written via the atomic temp-file-then-rename pattern. No database.
// Saving an automation keeps its last ~10 record versions for Put-it-back.
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile } from "@tauri-apps/plugin-fs";
import { atomicWriteJson } from "./atomic";
import { isDesktopApp } from "../platform";
import type { AutomationRecord, ChainRecord, RunRecord } from "./types";

const VERSIONS_KEPT = 10;

// The records are verbatim A5; the file containers wrap them so version
// history can live inside the same three files (see NOTES.md).
interface AutomationsFile {
  records: AutomationRecord[];
  versions: Record<string, AutomationRecord[]>; // newest first
}
interface ChainsFile {
  records: ChainRecord[];
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
  chains: { records: [] },
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
    state.chains = await readStore("chains", { records: [] });
    state.runs = await readStore("runs", { records: [] });
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
    const prev = file.records[idx];
    const versions = file.versions[record.id] ?? [];
    file.versions[record.id] = [prev, ...versions].slice(0, VERSIONS_KEPT);
    file.records[idx] = record;
  } else {
    file.records.push(record);
  }
  await persistStore("automations", file);
  emit();
}

export async function deleteAutomation(id: string): Promise<void> {
  const file = state.automations;
  file.records = file.records.filter((r) => r.id !== id);
  delete file.versions[id];
  await persistStore("automations", file);
  emit();
}

export function getAutomation(id: string): AutomationRecord | undefined {
  return state.automations.records.find((r) => r.id === id);
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
  if (idx >= 0) file.records[idx] = record;
  else file.records.push(record);
  await persistStore("chains", file);
  emit();
}

export async function deleteChain(id: string): Promise<void> {
  state.chains.records = state.chains.records.filter((r) => r.id !== id);
  await persistStore("chains", state.chains);
  emit();
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
