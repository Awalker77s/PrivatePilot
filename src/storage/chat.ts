// chat.json: the thread persists as a bounded console with scrollback —
// automations/chains/runs stay the durable record; this file is what lets
// "schedule this automation for 9am" still resolve tomorrow morning. Same
// atomic temp→fsync→rename pattern as the three stores.
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { atomicWriteJson } from "./atomic";

export interface DiskChat {
  v: 1;
  nextId: number;
  // Something live (a compile, a recording, a running card) was stripped at
  // save — the reload says so once instead of silently vanishing it.
  interrupted: boolean;
  pending: unknown | null;
  pendingEditRequest: string | null;
  items: unknown[];
}

async function chatPath(): Promise<string> {
  return join(await appDataDir(), "chat.json");
}

export async function readChatFile(): Promise<DiskChat | null> {
  try {
    const p = await chatPath();
    if (!(await exists(p))) return null;
    const parsed = JSON.parse(await readTextFile(p)) as DiskChat;
    return Array.isArray(parsed.items) ? parsed : null;
  } catch {
    // A corrupt thread must never brick launch — the caller starts fresh;
    // the stores are untouched.
    return null;
  }
}

export async function writeChatFile(data: DiskChat): Promise<void> {
  await atomicWriteJson(await chatPath(), data);
}
