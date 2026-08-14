// Atomic JSON writes: temp file in the same directory → fsync → rename over
// the target (the single Rust escape-hatch command does one attempt), wrapped
// in a 100/200/400ms backoff because Windows Defender and the Search indexer
// hold transient locks on just-written files — the documented top failure of
// atomic renames on Windows.
import { invoke } from "@tauri-apps/api/core";

const BACKOFF_MS = [100, 200, 400];

// Signatures of transient Windows locks: EPERM/EACCES (PermissionDenied /
// os error 5), EBUSY (os error 32 sharing violation / ResourceBusy).
const TRANSIENT =
  /PermissionDenied|ResourceBusy|os error 5\b|os error 32\b|simulated-lock/i;

export class StorageError extends Error {
  constructor(
    public sentence: string, // the designed sentence the UI shows
    public detail: string
  ) {
    super(sentence);
  }
}

// Test hook: the storage self-test arms this to prove the retry path recovers
// instead of corrupting. Counts down; each armed call fails like Defender.
let simulatedLocks = 0;
export function armSimulatedLock(times: number) {
  simulatedLocks = times;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function atomicWriteText(
  path: string,
  contents: string
): Promise<void> {
  let lastDetail = "";
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      if (simulatedLocks > 0) {
        simulatedLocks--;
        throw "PermissionDenied:simulated-lock (test)";
      }
      await invoke("atomic_write", { path, contents });
      return;
    } catch (e) {
      lastDetail = String(e);
      const transient = TRANSIENT.test(lastDetail);
      if (transient && attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      throw new StorageError(
        `Couldn't save ${fileName(path)} — another program is holding it. Nothing was corrupted; the last good version is still on disk.`,
        lastDetail
      );
    }
  }
}

export async function atomicWriteJson(
  path: string,
  data: unknown
): Promise<void> {
  await atomicWriteText(path, JSON.stringify(data, null, 2));
}

function fileName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
