// The runner: sandbox → tool loop → thorough → grounded verification → diff.
// Every stop is a designed sentence in one of the three families; the run
// record is the only thing any surface reads.
import { activeLocalModel, cloudActive, ranOnLabel } from "../providers";
import { getSettings } from "../storage/settings";
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
import { DirectEndpointError, runDirectEndpoint } from "./direct";
import { scanDiff, applyDiff, putBack } from "./diff";
import { parseOutputs, thoroughPass, verifyNumbers } from "./verify";
import { holdModelInMemory, OLLAMA_DOWN_SENTENCE } from "../providers/ollama";
import { connectorById } from "../connectors/registry";

function appLabel(id: string): string {
  return connectorById(id)?.label ?? id;
}

export interface RunOptions {
  cause: string;
  inputValues?: Record<string, string>;
  chainId?: string | null;
  stepIndex?: number | null;
  onProgress?: (text: string) => void;
  viaChain?: boolean; // the chain driver handles hand-offs itself
  contextNote?: string; // e.g. "the watcher confirmed: price crossed below 75.50"
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
  // A malformed record (imported, hand-built) must degrade, not crash.
  auto = {
    ...auto,
    files: {
      reads: auto.files?.reads ?? [],
      writes: auto.files?.writes ?? [],
    },
    sources: auto.sources ?? [],
    apps: auto.apps ?? [],
    tools: auto.tools ?? [],
    knowledge: auto.knowledge ?? [],
    steps: auto.steps ?? [],
    inputs: auto.inputs ?? [],
    outputs: auto.outputs ?? [],
  };
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
    ranOn: ranOnLabel(), // the honest line — where compute actually happens
    sandbox: null,
    baton: null,
    summary: null,
    stages,
    events,
    counters: { drafts: 0, fieldsFixed: 0, questionCard: false },
    didNotDo: ["Sandbox only — your real folder untouched"],
    diff: null,
    answer: null,
    indexInto:
      auto.delivers === "files" && (auto.knowledge ?? []).length > 0
        ? auto.knowledge![0]
        : null,
  };
  await appendRun(run);

  const releaseHold = holdModelInMemory();
  try {
    const result = await runInner(auto, run, opts, onProgress, anchor);
    if (!opts.viaChain && runFinishedHook) runFinishedHook(result);
    return result;
  } finally {
    releaseHold();
    // Don't leave an authenticated Gmail socket open past the run.
    if ((auto.apps ?? []).includes("gmail")) {
      const { invoke } = await import("@tauri-apps/api/core");
      void invoke("gmail_disconnect_pool").catch(() => {});
    }
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
  if ((auto.apps ?? []).length > 0) {
    const names = (auto.apps ?? []).map(appLabel).join(", ");
    line(toolsLog, `Apps this run may look into: ${names}. Reading only — a draft is the most it writes; nothing sends itself.`);
    if (getSettings().featherless.enabled) {
      // The cloud toggle changes where app text goes — say it up front.
      event(
        "on_purpose",
        "Cloud compute on",
        `Reading ${names} with Borrow cloud compute on — what those apps show goes to the borrowed computer too.`
      );
    }
  }

  // ---- stage 3 · tool loop ----
  let loop;
  let model: string | null = null;
  try {
    const direct = sandbox ? null : await runDirectEndpoint(auto);
    if (direct) {
      loop = {
          answer: direct.answer,
          turns: 0,
          corpus: direct.corpus,
          contextTrimmed: false,
          recoveredCalls: 0,
          refusals: [],
          logLines: direct.logLines,
          stalled: false,
          // A direct-endpoint job never touches apps — empty connector fields.
          heldBack: null,
          handoffs: [],
          appsRead: 0,
        };
    } else {
      model = cloudActive()
        ? getSettings().featherless.model
        : await activeLocalModel();
      if (!model) {
        toolsLog.status = "broke";
        toolsLog.finishedAt = Date.now();
        toolsLog.sentence = OLLAMA_DOWN_SENTENCE;
        return finish("broke", OLLAMA_DOWN_SENTENCE);
      }
      loop = await runToolLoop(
          auto,
          model,
          sandbox,
          opts.inputValues ?? {},
          (e) => onProgress(e.text),
          opts.contextNote
        );
    }
  } catch (e) {
    const sentence =
      e instanceof ProviderError || e instanceof DirectEndpointError
        ? e.sentence
        : `The tool loop broke — ${String(e)}`;
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
  if (loop.handoffs.length > 0) {
    run.handoffs = loop.handoffs;
    run.didNotDo.push("Sent nothing — the draft waits in your Drafts folder.");
  }
  if (loop.heldBack) {
    // An app said "needs you" or broke mid-run: nothing half-read gets an
    // answer. Held back with the app's own sentence; the pin says what to do.
    toolsLog.status = "held";
    toolsLog.finishedAt = Date.now();
    toolsLog.sentence = loop.heldBack;
    // Amber = the person must DO something. Match intentful phrases, not the
    // bare word "connect" (which lives inside "Connection reset by peer" — a
    // pure network crash that is red/broke, nothing for the person to fix).
    const family =
      /\bSettings\b|\bAllow\b|sign[- ]?in|permission|app password|not connected|\bpaste\b|connect your|reconnect|turn (it |this )?on/i.test(
        loop.heldBack
      )
        ? "needs_you"
        : "broke";
    event(family, "An app stopped the run", loop.heldBack);
    return finish(family === "needs_you" ? "needs_you" : "held", loop.heldBack);
  }
  if (!loop.answer) {
    toolsLog.status = "broke";
    toolsLog.finishedAt = Date.now();
    toolsLog.sentence = `Stopped after ${loop.turns} turns without a final answer.`;
    return finish("broke", toolsLog.sentence);
  }
  toolsLog.status = "ok";
  toolsLog.finishedAt = Date.now();
  line(
    toolsLog,
    loop.turns === 0
      ? "Finished directly from a verified endpoint."
      : `Finished in ${loop.turns} turns.`
  );

  // ---- stage 4 · thorough mode ----
  const thoroughLog = stage("thorough");
  let answer = loop.answer;
  if (
    auto.effort === "thorough" &&
    loop.corpus.trim().length > 0 &&
    model
  ) {
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
      // The clock is something the APP told the model ("Right now it is …"),
      // so a time or date in the answer is a restatement, not an invention.
      // Without this, "at 11:38 PM in Orlando" failed verification on the
      // number 11 and broke a run whose data was perfectly good.
      const now = new Date();
      const clockText = [
        now.toLocaleString(),
        now.toLocaleString(undefined, {
          weekday: "short",
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
        now.toISOString(),
        `${now.getFullYear()} ${now.getMonth() + 1} ${now.getDate()} ${now.getHours()} ${now.getMinutes()} ${((now.getHours() + 11) % 12) + 1}`,
      ].join("\n");
      const contextText = [
        auto.sentence,
        ...auto.steps,
        JSON.stringify(opts.inputValues ?? {}),
        clockText,
      ].join("\n");
      const v = await verifyNumbers(
        model ?? auto.model,
        cleanAnswer,
        loop.corpus,
        contextText
      );
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

  // A grounded answer run that reached NONE of its grounding — sources, apps,
  // files, or a knowledge base — delivered nothing but its own guesswork. Hold
  // it; a green checkmark over a fabricated answer is the one thing this app
  // must never do. (Files and knowledge were previously omitted, so a
  // "biggest expense in my receipts" answer with zero reads sailed to green.)
  const isGrounded =
    auto.sources.length > 0 ||
    (auto.apps ?? []).length > 0 ||
    (auto.files?.reads?.length ?? 0) > 0 ||
    (auto.knowledge ?? []).length > 0;
  if (
    auto.delivers === "answer" &&
    isGrounded &&
    loop.corpus.trim().length === 0 &&
    loop.appsRead === 0
  ) {
    const what =
      (auto.knowledge ?? []).length > 0
        ? "your documents"
        : (auto.files?.reads?.length ?? 0) > 0
          ? "its files"
          : (auto.apps ?? []).length > 0 && auto.sources.length === 0
            ? "its apps"
            : "its sources";
    const sentence = `Held back — it couldn't read anything from ${what}, so there's nothing real to answer with.`;
    event("on_purpose", "Nothing read", sentence);
    return finish("held", sentence);
  }

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
  // Keep-time indexing: a document run that files into a knowledge base only
  // indexes what was actually Kept — a discarded OCR run indexes nothing. The
  // target rides on the run record, so an UNSAVED automation indexes too.
  if (run.indexInto) {
    try {
      const extra = await indexKeptDocuments(run.indexInto, sandbox, run.diff);
      if (extra) sentence += ` ${extra}`;
    } catch {
      // indexing is a courtesy after Keep — never fails the Keep itself
    }
  }
  return sentence;
}

// Read the OCR text outputs that were just Kept and add them to the KB.
async function indexKeptDocuments(
  kbName: string,
  sandbox: Sandbox,
  diff: RunRecord["diff"]
): Promise<string | null> {
  if (!diff) return null;
  const { readTextFile, exists } = await import("@tauri-apps/plugin-fs");
  const { toRealPath } = await import("./sandbox");
  const { indexDocuments } = await import("../rag/index");
  const docs: { name: string; text: string; sourcePath: string }[] = [];
  for (const e of diff.entries) {
    if (!e.kept || !/\.txt$/i.test(e.relPath)) continue;
    // Skip OCR internal artifacts: the page-list (raw PNG paths) and any
    // .ocr.json sidecar are machinery, not documents — indexing them poisons
    // the KB with path junk that the keyword retriever then surfaces.
    if (/\.pagelist\.txt$/i.test(e.relPath) || /\.ocr\.json$/i.test(e.relPath)) continue;
    // Map the kept sandbox .txt back to its real path; read the text there.
    const display = e.relPath;
    const real = toRealPath(sandbox, display) ?? "";
    if (!real || !(await exists(real))) continue;
    const text = await readTextFile(real);
    if (!text.trim()) continue;
    const name = display.split(/[\\/]/).pop()?.replace(/\.txt$/i, "") ?? "document";
    const pdf = real.replace(/\.txt$/i, ".searchable.pdf");
    docs.push({ name, text, sourcePath: (await exists(pdf)) ? pdf : real });
  }
  if (docs.length === 0) return null;
  const res = await indexDocuments(kbName, docs);
  return res.added > 0
    ? `Indexed ${res.added} document${res.added === 1 ? "" : "s"} (${res.chunks} passage${res.chunks === 1 ? "" : "s"}) into ${kbName}.`
    : null;
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
