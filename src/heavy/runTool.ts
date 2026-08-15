// The bridge to Rust's run_tool, plus locating bundled/fetched binaries.
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join, resourceDir } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import type { HeavyPlan } from "./types";

export interface ToolRunReport {
  exit_code: number;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  output_truncated: boolean;
  ms: number;
}

export async function runTool(plan: HeavyPlan): Promise<ToolRunReport> {
  return (await invoke("run_tool", { plan })) as ToolRunReport;
}

// A binary is either bundled in the installer (resource_dir/binaries) or
// fetched to appdata/tools. Returns the absolute path, or null if absent —
// the caller shows the "get the toolkit" amber card, never a silent fail.
export async function findBinary(name: string): Promise<string | null> {
  const candidates: string[] = [];
  // appdata/tools first — it's inside the fs scope, so exists() works in dev.
  try {
    candidates.push(await join(await appDataDir(), "tools", name));
  } catch {
    // appdata unavailable
  }
  try {
    candidates.push(await join(await resourceDir(), "binaries", name));
  } catch {
    // resource dir unavailable in some dev contexts
  }
  for (const p of candidates) {
    // A candidate outside the fs scope (the dev resource dir) throws from
    // exists() — treat that as "not here", not an error.
    try {
      if (await exists(p)) return p;
    } catch {
      // out of scope / unreadable — skip
    }
  }
  return null;
}

export async function toolsDir(): Promise<string> {
  return join(await appDataDir(), "tools");
}
