// chat.json: General chat plus automation-scoped Studio threads persist as
// scrollback. automations/chains/runs stay the durable execution record.
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { atomicWriteJson } from "./atomic";
import type { AutomationReference } from "./types";

export interface DiskChat {
  v: 1 | 2;
  nextId: number;
  // Something live (a compile, a recording, a running card) was stripped at
  // save — the reload says so once instead of silently vanishing it.
  interrupted: boolean;
  pending: unknown | null;
  pendingEditRequest: string | null;
  activeAutomationId?: string | null;
  pendingReferences?: AutomationReference[];
  threadStates?: Record<
    string,
    {
      pending: unknown | null;
      pendingEditRequest: string | null;
      pendingReferences: AutomationReference[];
    }
  >;
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
