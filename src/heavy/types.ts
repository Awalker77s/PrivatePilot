// Heavy tools: typed verbs whose command line is built by OUR code, never
// sampled from the model. The model fills validated blanks (an enum, a bounded
// number, a fenced path); TypeScript composes the argv; Rust's run_tool spawns
// exe + argv[] directly — no shell, no cmd.exe, no pwsh. Everything runs in the
// existing file sandbox; writes land in the copy → diff card → Keep. Same
// manifest shape as a connector ToolSpec, so the runner treats them uniformly.
import type { z } from "zod";
import type { ToolDef } from "../providers/types";
import type { Sandbox } from "../runner/sandbox";

export type HeavyToolId = "bulk_rename" | "zip_folder" | "unzip" | "ocr_pdf";

export type ToolFamily = "ok" | "on_purpose" | "needs_you" | "broke";

// The plan handed to Rust's run_tool — a real binary, or null for a tool that
// does its work in TypeScript (bulk_rename renames inside the sandbox itself).
export interface HeavyPlan {
  exe: string; // absolute path to a bundled/verified .exe
  argv: string[];
  cwd: string;
  allowed_roots: string[];
  timeout_ms: number;
  max_output_bytes: number;
  // Tool-declared env (our code, never the model) — e.g. TESSDATA_PREFIX.
  env?: [string, string][];
}

export interface HeavyResult {
  ok: boolean;
  text: string; // what the model reads back
  family: ToolFamily;
  logLine: string;
  corpusText?: string;
  // Files the tool created/changed inside the sandbox, display paths — the
  // diff/Keep card renders from the sandbox scan, this is just for the log.
  producedNote?: string;
}

export interface CostEstimate {
  files: number;
  bytes: number;
  minutes: number; // rough; gates the cost card
}

export interface HeavyContext {
  runNote: (line: string) => void;
  sandbox: Sandbox;
  // Absolute path to a bundled binary by name, or null if missing.
  binary: (name: string) => Promise<string | null>;
  // Map a display path (record language) into the sandbox copy, or null if it
  // escapes the fence.
  toSandbox: (display: string) => string | null;
}

export interface HeavyToolSpec {
  id: HeavyToolId;
  def: ToolDef; // what the model sees
  params: z.ZodTypeAny; // safeParse before anything runs
  writes: boolean;
  // Some tools read untrusted content the model shouldn't be able to steer
  // toward the web — heavy tools are all offline, this is documentation.
  run: (args: Record<string, unknown>, ctx: HeavyContext) => Promise<HeavyResult>;
  estimate?: (args: Record<string, unknown>, ctx: HeavyContext) => Promise<CostEstimate>;
  menuLine: string; // one line for the drafter menu
}
