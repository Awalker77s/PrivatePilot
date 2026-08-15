// A connector is a small manifest: an id the record's `apps` fence names,
// a few typed tools with narrow enum-heavy params (what a 9B calls
// reliably), and designed sentences for every way it can fail. The model
// composes business params; TypeScript composes the call; Rust does the
// mechanism. Nothing here sends, deletes, or clicks.
import type { z } from "zod";
import type { ToolDef } from "../providers/types";
import type { RunHandoff } from "../storage/types";

export type ConnectorId = "outlook" | "gmail" | "spotify" | "computer";

export type ToolFamily = "ok" | "on_purpose" | "needs_you" | "broke";

export interface ToolResult {
  ok: boolean;
  text: string; // what the model reads back (rows / the honest sentence)
  family: ToolFamily;
  logLine: string; // the stage-log line, plain words
  corpusText?: string; // appended to the run corpus for number verification
  handoff?: RunHandoff; // a draft waiting for the person's own hand
}

export interface ToolContext {
  runNote: (line: string) => void; // progress line for the card
  // Run-scoped memory a connector may use (short ids → real ids, addresses
  // seen this run so a draft can't be addressed to someone it never read).
  memory: Map<string, unknown>;
}

export interface ToolSpec {
  def: ToolDef;
  params: z.ZodTypeAny; // validated + coerced before run(); errors go back to the model
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  writes: boolean; // a draft or a transport command — surfaced in the built card
}

export type ConnectorStatus =
  | { state: "ready"; detail: string } // usable now
  | { state: "needs_allow"; detail: string } // installed/detected, one Allow away
  | { state: "unavailable"; detail: string }; // not on this computer

export interface Connector {
  id: ConnectorId;
  label: string; // "Outlook mail & calendar"
  blurb: string; // one sentence for the settings row and the drafter menu
  tools: ToolSpec[];
  status: () => Promise<ConnectorStatus>;
  // The drafter's one-line description of the calls (kept tiny — tokens).
  menuLine: string;
}
