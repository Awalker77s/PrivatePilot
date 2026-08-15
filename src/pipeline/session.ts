// The compile session: catalog → draft (stage 1) → validator loop (stage 2)
// → an assembled draft the user can watch run, or a grounded question card.
// Counters land in runs.json; the validator's argument is visible in the UI.
import { activeLocalModel, cloudActive, ranOnLabel } from "../providers";
import { getSettings } from "../storage/settings";
import { ProviderError } from "../providers/types";
import { appendRun, newId, updateRun } from "../storage/stores";
import type {
  AutomationRecord,
  ChainRecord,
  RunRecord,
  StageLog,
} from "../storage/types";
import {
  buildCatalog,
  catalogForRequest,
  Catalog,
  formatForPath,
  matchCatalog,
} from "./catalog";
import { draftCall, draftMessages, DraftContext } from "./draft";
import type { WireAutomation } from "./draft/schema";
import { validateLoop } from "./validate";

export interface QuestionOption {
  label: string; // "invoices-2026.xlsx — in Documents"
  value: string; // the display path / answer text injected on pick
}

export interface CompileQuestion {
  asking: string;
  term: string;
  kind: string;
  options: QuestionOption[];
}

export interface CompileResult {
  ok: boolean;
  automations: AutomationRecord[]; // assembled, NOT saved — Save is earned
  chain: ChainRecord | null;
  question: CompileQuestion | null;
  argument: string[]; // validator vs model, shown in the built card
  failSentence: string | null;
  runId: string; // the compile's record in runs.json (ids double as anchors)
  keptToOneStep: boolean;
}

export type ProgressFn = (stage: "draft" | "validate", text: string) => void;

function anchor(runId: string, n: number): string {
  return `${runId}#${n}`;
}

export async function compile(
  context: DraftContext,
  onProgress: ProgressFn
): Promise<CompileResult> {
  const runId = newId("run");
  const startedAt = Date.now();
  let anchorN = 0;
  const stages: StageLog[] = [];

  const run: RunRecord = {
    id: runId,
    automationId: "draft",
    chainId: null,
    stepIndex: null,
    cause: context.demo ? "you showed me" : "you described a task",
    startedAt,
    finishedAt: null,
    status: "running",
    ranOn: ranOnLabel(),
    sandbox: null,
    baton: null,
    summary: null,
    stages,
    events: [],
    counters: { drafts: 0, fieldsFixed: 0, questionCard: false },
    didNotDo: [],
    diff: null,
    answer: null,
  };
  await appendRun(run);

  const fail = async (sentence: string): Promise<CompileResult> => {
    await updateRun(runId, (r) => {
      r.status = "broke";
      r.finishedAt = Date.now();
      r.summary = sentence;
    });
    return {
      ok: false,
      automations: [],
      chain: null,
      question: null,
      argument: [],
      failSentence: sentence,
      runId,
      keptToOneStep: false,
    };
  };

  // ---- stage 1 · schema-constrained drafting ----
  onProgress("draft", "Reading your folders…");
  const draftLog: StageLog = {
    stage: "draft",
    startedAt: Date.now(),
    finishedAt: null,
    status: "running",
    lines: [],
    sentence: null,
  };
  stages.push(draftLog);

  let catalog: Catalog;
  try {
    catalog = catalogForRequest(await buildCatalog(), context.userText);
  } catch (e) {
    draftLog.status = "broke";
    draftLog.finishedAt = Date.now();
    draftLog.sentence = "Couldn't read your folders before drafting.";
    return fail(`Couldn't read your folders — ${String(e)}`);
  }
  draftLog.lines.push({
    at: Date.now(),
    text: `Catalog: ${catalog.files.length} files across ${catalog.folders.length} folders, ${catalog.automationNames.length} existing automations.`,
    anchor: anchor(runId, anchorN++),
  });

  const model = cloudActive()
    ? getSettings().featherless.model
    : await activeLocalModel();
  if (!model) {
    draftLog.status = "broke";
    draftLog.finishedAt = Date.now();
    draftLog.sentence = "No local model to draft with.";
    return fail("No local model is pulled yet — run: ollama pull qwen3.5:4b");
  }
  draftLog.lines.push({
    at: Date.now(),
    text: cloudActive()
      ? "Drafting on the borrowed computer — validated after (cloud), not grammar-locked."
      : "Drafting locally — schema locked by grammar (local).",
    anchor: anchor(runId, anchorN++),
  });

  onProgress("draft", "Drafting…");
  const messages = draftMessages(catalog, context);
  let firstContent: string;
  try {
    const res = await draftCall(model, catalog, messages);
    firstContent = res.content;
    run.counters.drafts++;
    draftLog.lines.push({
      at: Date.now(),
      text: `Draft 1 returned in ${(res.ms / 1000).toFixed(1)}s (grammar-locked to the schema).`,
      anchor: anchor(runId, anchorN++),
    });
  } catch (e) {
    draftLog.status = "broke";
    draftLog.finishedAt = Date.now();
    draftLog.sentence =
      e instanceof ProviderError ? e.sentence : "The drafting call broke.";
    return fail(
      e instanceof ProviderError ? e.sentence : `Drafting broke — ${String(e)}`
    );
  }
  draftLog.status = "ok";
  draftLog.finishedAt = Date.now();

  // ---- stage 2 · validator loop ----
  onProgress("validate", "Validator — checking the draft…");
  const valLog: StageLog = {
    stage: "validate",
    startedAt: Date.now(),
    finishedAt: null,
    status: "running",
    lines: [],
    sentence: null,
  };
  stages.push(valLog);

  let outcome;
  try {
    outcome = await validateLoop(
      model,
      catalog,
      messages,
      firstContent,
      context,
      (text) => onProgress("validate", text)
    );
  } catch (e) {
    valLog.status = "broke";
    valLog.finishedAt = Date.now();
    valLog.sentence =
      e instanceof ProviderError ? e.sentence : "The validator loop broke.";
    return fail(
      e instanceof ProviderError ? e.sentence : `Validation broke — ${String(e)}`
    );
  }

  run.counters.drafts = outcome.attempts;
  run.counters.fieldsFixed = outcome.fieldsFixed;
  for (const line of outcome.argument) {
    valLog.lines.push({
      at: Date.now(),
      text: line,
      anchor: anchor(runId, anchorN++),
    });
  }

  if (!outcome.ok || !outcome.draft) {
    // Three failed passes → a question card, never a crash.
    run.counters.questionCard = true;
    valLog.status = "held";
    valLog.finishedAt = Date.now();
    valLog.sentence =
      "Three drafts didn't line up — asking you instead of guessing.";
    const question: CompileQuestion = {
      asking: "What exactly should this automation work on?",
      term: context.userText,
      kind: "other",
      options: catalog.folders
        .filter((f) => f.readable)
        .slice(0, 3)
        .map((f) => ({ label: `Something in ${f.label}`, value: f.display })),
    };
    await updateRun(runId, (r) => {
      r.status = "needs_you";
      r.finishedAt = Date.now();
      r.summary = valLog.sentence;
    });
    return {
      ok: true,
      automations: [],
      chain: null,
      question,
      argument: outcome.argument,
      failSentence: null,
      runId,
      keptToOneStep: false,
    };
  }

  valLog.status = "ok";
  valLog.finishedAt = Date.now();

  const draft = outcome.draft;

  // ---- grounded-or-ask: the model asked its one question ----
  if (draft.question) {
    run.counters.questionCard = true;
    const kind = (draft.question.kind === "file" || draft.question.kind === "folder"
      ? draft.question.kind
      : "file") as "file" | "folder";
    const options = matchCatalog(
      catalog,
      `${draft.question.term} ${context.userText}`,
      kind
    );
    const question: CompileQuestion = {
      asking: draft.question.asking,
      term: draft.question.term,
      kind: draft.question.kind,
      options: options.map((o) => ({ label: o.label, value: o.display })),
    };
    valLog.sentence = `Asked instead of guessing: ${draft.question.asking}`;
    await updateRun(runId, (r) => {
      r.status = "needs_you";
      r.finishedAt = Date.now();
      r.summary = draft.question!.asking;
    });
    return {
      ok: true,
      automations: [],
      chain: null,
      question,
      argument: outcome.argument,
      failSentence: null,
      runId,
      keptToOneStep: false,
    };
  }

  // ---- assemble records (compiled truth — every surface reads these) ----
  const assembled = draft.automations.map((a) =>
    assembleRecord(a, model, context)
  );
  let chain: ChainRecord | null = null;
  if (draft.chain && draft.chain.links.length > 0) {
    const nameToId = new Map(assembled.map((r) => [r.name, r.id]));
    chain = {
      id: newId("chain"),
      name: draft.chain.name,
      links: draft.chain.links.map((l) => ({
        from: nameToId.get(l.from) ?? l.from,
        to: nameToId.get(l.to) ?? l.to,
        map: Object.fromEntries(l.map.map((p) => [p.output, p.input])),
        onlyWhen: l.onlyWhen,
      })),
      timeoutMinutes: 30,
    };
  }

  const summary =
    assembled.length === 1
      ? `Built "${assembled[0].name}" — waiting for a watched run`
      : `Built ${assembled.length} automations, one hand-off — waiting for a watched run`;
  await updateRun(runId, (r) => {
    r.status = "ok";
    r.finishedAt = Date.now();
    r.summary = summary;
    r.automationId = assembled[0]?.id ?? "draft";
  });

  return {
    ok: true,
    automations: assembled,
    chain,
    question: null,
    argument: outcome.argument,
    failSentence: null,
    runId,
    keptToOneStep: assembled.length === 1,
  };
}

function assembleRecord(
  a: WireAutomation,
  model: string,
  context: DraftContext
): AutomationRecord {
  const formats: Record<string, string> = {};
  for (const p of [...a.files.reads, ...a.files.writes]) {
    formats[p] = formatForPath(p);
  }
  return {
    id: newId("auto"),
    name: a.name,
    sentence: a.sentence,
    category: a.category,
    steps: a.steps,
    inputs: a.inputs,
    outputs: a.outputs,
    files: a.files,
    formats,
    sources: a.sources,
    apps: a.apps,
    delivers: a.delivers,
    schedule: a.schedule,
    model,
    effort: a.effort,
    compiledBy: model,
    origin: context.demo
      ? {
          kind: "watched",
          at: Date.now(),
          frames: context.demo.frames,
          narrationWords: context.demo.transcript.split(/\s+/).length,
        }
      : { kind: "told", at: Date.now() },
    lastRun: null,
  };
}
