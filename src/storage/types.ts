// The data model, verbatim from the build pack (A5). Everything any surface
// displays reads from these records — never from model output at render time.

export type Category =
  | "Documents"
  | "Email"
  | "Web"
  | "Notes"
  | "Money"
  | "Watch"
  | "Files";

export type Schedule =
  | { trigger: "daily"; hour: number }
  | { trigger: "watch"; everyMinutes: number }
  | { trigger: "manual" };

export interface AutomationInput {
  name: string;
  label: string;
  example: string;
}

export interface AutomationOutput {
  name: string;
}

export type RunStatus =
  | "ok" // Ran
  | "broke" // Broke
  | "held" // Held back — stopped on purpose
  | "needs_you" // question card / diff waiting / already-true ask
  | "running";

export interface AutomationRecord {
  id: string; // "auto-x7k2"
  name: string; // 2–4 words
  sentence: string; // the compiled sentence — the record's entire documentation
  category: Category; // drives the tile gradient+glyph
  steps: string[];
  inputs: AutomationInput[]; // fill-ins, asked at run time
  outputs: AutomationOutput[]; // what it hands back
  files: { reads: string[]; writes: string[] };
  formats: Record<string, string>; // resolved at compile from the catalog, never guessed at runtime
  sources: string[]; // the ONLY sites it may fetch — a fence, not a suggestion
  // The ONLY apps it may look into (connector ids like "outlook", "spotify",
  // "computer") — the same kind of fence as sources. Absent on old records.
  apps?: string[];
  // The ONLY heavy tools it may run (ids like "bulk_rename", "ocr_pdf") — a
  // closed fence like apps. Heavy tools act on files in the sandbox; the
  // model never composes a command line. Absent on old records.
  tools?: string[];
  delivers: "answer" | "files";
  schedule: Schedule;
  model: string;
  effort: "quick" | "thorough";
  compiledBy: string; // the model passport — re-runs under a different brain say so
  // Provenance — app-written after validation, never sampled from the model.
  origin?: {
    kind: "told" | "watched" | "edited";
    at: number;
    frames?: number;
    narrationWords?: number;
  };
  lastRun: { at: number; status: RunStatus; summary: string } | null;
}

export interface ChainCondition {
  field: string;
  op:
    | "crosses_above"
    | "crosses_below"
    | "moves_more_than_pct"
    | "now_contains"
    | "changed_at_all";
  value: number | string | null;
}

export interface ChainLink {
  from: string;
  to: string;
  map: Record<string, string>; // outputs → inputs, by name
  onlyWhen: ChainCondition | null;
}

export interface ChainRecord {
  id: string; // "chain-m1"
  name: string;
  links: ChainLink[];
  timeoutMinutes: number;
}

// ---- run records (append-only) ----

export type StageName = "draft" | "validate" | "tools" | "thorough" | "verify";

export interface StageLog {
  stage: StageName;
  startedAt: number;
  finishedAt: number | null;
  status: "ok" | "broke" | "held" | "running" | "skipped";
  lines: { at: number; text: string; anchor: string }[]; // searchable log, stable anchors
  sentence: string | null; // the designed sentence when a stage stops
}

export interface HonestyEvent {
  at: number;
  family: "on_purpose" | "needs_you" | "broke";
  state: string; // e.g. "Bot wall (403)", "Context trimmed"
  sentence: string; // the exact sentence the user sees
  anchor: string;
}

export interface RunRecord {
  id: string; // "run-991" — ids double as UI anchors
  automationId: string;
  chainId: string | null;
  stepIndex: number | null;
  cause: string; // "watcher saw 3 new files" | "you pressed Run" | ...
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  ranOn: string; // "local" or "featherless:Qwen/Qwen3-32B" — the honest line
  sandbox: { path: string; preflightBytes: number; preflightFiles: number } | null;
  baton: Record<string, string | number> | null;
  summary: string | null;
  stages: StageLog[];
  events: HonestyEvent[];
  counters: { drafts: number; fieldsFixed: number; questionCard: boolean };
  didNotDo: string[]; // "What I did not do" — refused hosts, skipped hops, sandbox-only
  diff: RunDiff | null;
  answer: string | null; // delivered answer text (delivers: "answer")
  // Things the run left waiting for the person's own hand — a draft saved
  // in Outlook they press Send on. Rendered as buttons; never auto-acted.
  handoffs?: RunHandoff[];
}

export interface RunHandoff {
  kind: "outlook_draft" | "gmail_draft";
  label: string; // "Open the draft in Outlook"
  caption: string; // "saved in your Drafts folder — you press Send there"
  ref: string; // opaque id the connector can open (EntryID) or a URL
  to: string;
  subject: string;
}

export interface DiffEntry {
  relPath: string;
  kind: "added" | "changed" | "deleted";
  hunks: string | null; // unified before/after hunks for text files under 256 KB
  note: string | null; // "changed (too different to preview)" etc.
  kept: boolean; // per-file keep-checkbox — partial acceptance, like staging
}

export interface RunDiff {
  entries: DiffEntry[];
  applied: boolean;
  appliedAt: number | null;
  headline: string; // "Changed 3 files, added 1, deleted 0 — in a copy. Your real folder hasn't been touched."
}
