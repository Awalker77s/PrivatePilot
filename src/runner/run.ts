// The runner: sandbox → tool loop → thorough → grounded verification → diff.
// Every stop is a designed sentence in one of the three families; the run
// record is the only thing any surface reads.
import { activeLocalModel } from "../providers";
import { ProviderError } from "../providers/types";
import { buildCatalog } from "../pipeline/catalog";
import { appendRun, newId, updateRun, getAutomation, saveAutomation } from "../storage/stores";
import type {
  AutomationRecord,
  HonestyEvent,
  RunRecord,
  StageLog,
} from "../storage/types";
import { buildSandbox, Sandbox, SandboxRefusal } from "./sandbox";
import { runToolLoop } from "./loop";
import { scanDiff, applyDiff, putBack } from "./diff";
import { parseOutputs, thoroughPass, verifyNumbers } from "./verify";
import { holdModelInMemory, OLLAMA_DOWN_SENTENCE } from "../providers/ollama";

export interface RunOptions {
  cause: string;
  inputValues?: Record<string, string>;
  chainId?: string | null;
  stepIndex?: number | null;
  onProgress?: (text: string) => void;
  viaChain?: boolean; // the chain driver handles hand-offs itself
}

// The dispatcher registers here (avoids a circular import): it runs whenever
// any run finishes and follows chain links with plain-JS conditions.
let runFinishedHook: ((run: RunRecord) => void) | null = null;
export function registerRunFinishedHook(fn: (run: RunRecord) => void): void {
  runFinishedHook = fn;
}

export interface RunHandle {
  runId: string;
  record: RunRecord;
  sandbox: Sandbox | null;
}

const sandboxes = new Map<string, Sandbox>(); // runId → sandbox, for Keep

export function sandboxFor(runId: string): Sandbox | undefined {
  return sandboxes.get(runId);
}

export async function runAutomation(
  auto: AutomationRecord,
  opts: RunOptions
): Promise<RunRecord> {
  const runId = newId("run");
  const onProgress = opts.onProgress ?? (() => {});
  let anchorN = 0;
  const anchor = () => `${runId}#${anchorN++}`;

  const stages: StageLog[] = [];
  const events: HonestyEvent[] = [];
  const run: RunRecord = {
    id: runId,
    automationId: auto.id,
    chainId: opts.chainId ?? null,
    stepIndex: opts.stepIndex ?? null,
    cause: opts.cause,
    startedAt: Date.now(),
    finishedAt: null,
    status: "running",
    ranOn: "local",
    sandbox: null,
    baton: null,
    summary: null,
    stages,
    events,
    counters: { drafts: 0, fieldsFixed: 0, questionCard: false },
    didNotDo: ["Sandbox only — your real folder untouched"],
    diff: null,
    answer: null,
  };
  await appendRun(run);

  const releaseHold = holdModelInMemory();
  try {
    const result = await runInner(auto, run, opts, onProgress, anchor);
    if (!opts.viaChain && runFinishedHook) runFinishedHook(result);
    return result;
  } finally {
    releaseHold();
  }
}

async function runInner(
  auto: AutomationRecord,
  run: RunRecord,
  opts: RunOptions,
  onProgress: (text: string) => void,
  anchor: () => string
): Promise<RunRecord> {
  const runId = run.id;

  const stage = (name: StageLog["stage"]): StageLog => {
    const s: StageLog = {
      stage: name,
      startedAt: Date.now(),
      finishedAt: null,
      status: "running",
      lines: [],
      sentence: null,
    };
    run.stages.push(s);
    return s;
  };
  const line = (s: StageLog, text: string) =>
    s.lines.push({ at: Date.now(), text, anchor: anchor() });
  const event = (
    family: HonestyEvent["family"],
    state: string,
    sentence: string
  ) => run.events.push({ at: Date.now(), family, state, sentence, anchor: anchor() });

  const finish = async (
    status: RunRecord["status"],
    summary: string
  ): Promise<RunRecord> => {
    await updateRun(runId, (r) => {
      Object.assign(r, run);
      r.status = status;
      r.finishedAt = Date.now();
      r.summary = summary;
    });
    const saved = getAutomation(auto.id);
    if (saved) {
      saved.lastRun = { at: Date.now(), status, summary };
      await saveAutomation(saved);
    }
    return run;
  };

  const model = await activeLocalModel();
  if (!model) {
    return finish("broke", OLLAMA_DOWN_SENTENCE);
  }

  // ---- sandbox (pre-flight + copy) — only when files are involved ----
  const touchesFiles =
    auto.files.reads.length > 0 || auto.files.writes.length > 0;
  const toolsLog = stage("tools");
  let sandbox: Sandbox | null = null;
  if (touchesFiles) {
    onProgress("Copying your files into the sandbox…");
    try {
      const catalog = await buildCatalog();
      sandbox = await buildSandbox(
        runId,
        auto.files.reads,
        auto.files.writes,
        catalog
      );
    } catch (e) {
      const sentence =
        e instanceof SandboxRefusal
          ? e.sentence
          : `Couldn't set up the sandbox — ${String(e)}`;
      toolsLog.status = "broke";
      toolsLog.finishedAt = Date.now();
      toolsLog.sentence = sentence;
      event("broke", "Folder unreadable", sentence);
      return finish("broke", sentence);
    }
    sandboxes.set(runId, sandbox);
    run.sandbox = {
      path: runId,
      preflightBytes: sandbox.preflightBytes,
      preflightFiles: sandbox.preflightFiles,
    };
    line(
      toolsLog,
      `Copied ${sandbox.preflightFiles.toLocaleString()} files (${(sandbox.preflightBytes / 1e6).toFixed(1)} MB) into the sandbox.`
    );
    if (sandbox.copyNote) {
      line(toolsLog, sandbox.copyNote);
      run.didNotDo.push(sandbox.copyNote);
    }
  } else {
    // An online automation: no files, no sandbox — the fence and the
    // verification stages are the whole safety story.
    run.didNotDo = ["Touched no files — worked online, answered in the app"];
    line(toolsLog, "No files involved — running online.");
  }

  // ---- stage 3 · tool loop ----
  let loop;
  try {
    loop = await runToolLoop(
      auto,
      model,
      sandbox,
      opts.inputValues ?? {},
      (e) => onProgress(e.text)
    );
  } catch (e) {
    const sentence =
      e instanceof ProviderError ? e.sentence : `The tool loop broke — ${String(e)}`;
    toolsLog.status = "broke";
    toolsLog.finishedAt = Date.now();
    toolsLog.sentence = sentence;
    return finish("broke", sentence);
  }
  for (const l of loop.logLines) line(toolsLog, l);
  if (loop.contextTrimmed) {
    event(
      "on_purpose",
      "Context trimmed",
      "I forgot the oldest steps to keep going."
    );
  }
  for (const refusal of loop.refusals) {
    run.didNotDo.push(refusal);
  }
  if (loop.recoveredCalls > 0) {
    line(
      toolsLog,
      `Recovered ${loop.recoveredCalls} tool call${loop.recoveredCalls === 1 ? "" : "s"} written as text.`
    );
  }
  if (loop.stalled) {
    toolsLog.status = "broke";
    toolsLog.finishedAt = Date.now();
    toolsLog.sentence = "Stopped after 30 minutes without finishing.";
    event("broke", "Stalled", toolsLog.sentence);
    return finish("broke", toolsLog.sentence);
  }
  if (!loop.answer) {
    toolsLog.status = "broke";
    toolsLog.finishedAt = Date.now();
    toolsLog.sentence = `Stopped after ${loop.turns} turns without a final answer.`;
    return finish("broke", toolsLog.sentence);
  }
  toolsLog.status = "ok";
  toolsLog.finishedAt = Date.now();
  line(toolsLog, `Finished in ${loop.turns} turns.`);

  // ---- stage 4 · thorough mode ----
  const thoroughLog = stage("thorough");
  let answer = loop.answer;
  if (auto.effort === "thorough" && loop.corpus.trim().length > 0) {
    onProgress("Thorough — re-reading its own answer against the source…");
    try {
      const revised = await thoroughPass(model, answer, loop.corpus);
      if (revised !== answer) {
        line(thoroughLog, "Second pass corrected the answer against the source.");
        answer = revised;
      } else {
        line(thoroughLog, "Second pass re-read the source — answer stood.");
      }
      thoroughLog.status = "ok";
    } catch {
      thoroughLog.status = "held";
      thoroughLog.sentence = "Skipped the second pass — the first answer stands.";
    }
  } else {
    thoroughLog.status = "skipped";
    thoroughLog.sentence =
      auto.effort === "thorough"
        ? "Nothing was read — nothing to re-check."
        : "Quick mode — no second pass.";
  }
  thoroughLog.finishedAt = Date.now();

  // ---- stage 5 · grounded verification ----
  const verifyLog = stage("verify");
  onProgress("Verifying the numbers against the source…");
  const { cleanAnswer, baton } = parseOutputs(answer);
  run.baton = baton;
  run.answer = cleanAnswer;
  if (loop.corpus.trim().length > 0) {
    try {
      const v = await verifyNumbers(model, cleanAnswer, loop.corpus);
      for (const c of v.checkedLines) line(verifyLog, c);
      if (!v.ok) {
        verifyLog.status = "broke";
        verifyLog.finishedAt = Date.now();
        verifyLog.sentence = `I couldn't confirm that number. (${v.unconfirmed})`;
        event("broke", "Unconfirmed number", verifyLog.sentence);
        return finish("broke", "I couldn't confirm that number.");
      }
      verifyLog.status = "ok";
      line(verifyLog, "Every delivered number traces to the source.");
    } catch (e) {
      verifyLog.status = "broke";
      verifyLog.finishedAt = Date.now();
      verifyLog.sentence =
        e instanceof ProviderError ? e.sentence : `Verification broke — ${String(e)}`;
      return finish("broke", verifyLog.sentence);
    }
  } else {
    verifyLog.status = "skipped";
    verifyLog.sentence = "Nothing was read or fetched — no numbers to check.";
  }
  verifyLog.finishedAt = Date.now();

  // ---- diff (only when a sandbox exists) ----
  if (!sandbox) {
    const summary = cleanAnswer.split("\n")[0].slice(0, 140) || "Ran.";
    return finish("ok", summary);
  }
  onProgress("Comparing the sandbox against your real files…");
  const diff = await scanDiff(sandbox);
  run.diff = diff;

  if (diff.entries.length > 0) {
    const n = diff.entries.length;
    event(
      "needs_you",
      "Diff waiting",
      `Wants to change ${n} file${n === 1 ? "" : "s"} → Look first.`
    );
    return finish(
      "needs_you",
      `${diff.headline}`
    );
  }

  const summary = cleanAnswer.split("\n")[0].slice(0, 140) || "Ran.";
  return finish("ok", summary);
}

// Keep: apply the diff to real files. The only code path that touches them.
export async function keepRun(runId: string): Promise<string> {
  const sandbox = sandboxes.get(runId);
  let sentence = "";
  await updateRun(runId, () => {});
  const { getRun } = await import("../storage/stores");
  const run = getRun(runId);
  if (!run || !run.diff || !sandbox) {
    return "This run's sandbox is gone — run it again to apply changes.";
  }
  const result = await applyDiff(sandbox, run.diff);
  sentence = result.sentence;
  await updateRun(runId, (r) => {
    r.diff = run.diff;
    r.status = "ok";
    const kept = run.diff!.entries.filter((e) => e.kept).length;
    r.summary = `Kept ${kept} change${kept === 1 ? "" : "s"} — applied to your real files.`;
  });
  const auto = getAutomation(run.automationId);
  if (auto) {
    auto.lastRun = { at: Date.now(), status: "ok", summary: "Kept — applied." };
    await saveAutomation(auto);
  }
  return sentence;
}

export async function putBackRun(runId: string): Promise<string> {
  const sandbox = sandboxes.get(runId);
  const { getRun } = await import("../storage/stores");
  const run = getRun(runId);
  if (!run || !run.diff || !sandbox) {
    return "Nothing to put back.";
  }
  const n = await putBack(sandbox, run.diff);
  await updateRun(runId, (r) => {
    r.diff = run.diff;
    r.summary = `Put back ${n} file${n === 1 ? "" : "s"} — the way it was.`;
    r.status = "held";
  });
  return `Put back ${n} file${n === 1 ? "" : "s"} — the way it was.`;
}
