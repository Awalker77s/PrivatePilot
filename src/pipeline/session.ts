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
  CHAIN_REQUEST_RE,
  formatForPath,
  matchCatalog,
} from "./catalog";
import { draftCall, draftMessages, DraftContext } from "./draft";
import type { WireAutomation } from "./draft/schema";
import { validateLoop } from "./validate";
import { tryQuickCompile } from "./quickDraft";
import { tryQuickFileCompile } from "./fileQuickDraft";
import { compactReadDraft } from "./compactDraft";
import { mirrorHostsFor } from "../runner/mirrors";
import { orderByMention, sequenceFrom } from "./sequence";
import {
  draftRevisionFor,
  mergePermissionManifests,
  normalizeAutomation,
  permissionManifestFor,
} from "../storage/revisions";

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
  cancelled?: boolean;
}

export type ProgressFn = (stage: "draft" | "validate", text: string) => void;

function anchor(runId: string, n: number): string {
  return `${runId}#${n}`;
}

export async function compile(
  context: DraftContext,
  onProgress: ProgressFn,
  signal?: AbortSignal
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

  // Stable public-data requests do not need a model to decide their shape.
  // This makes the everyday path (news, prices, service status) effectively
  // instant while preserving the full compiler for ambiguous or file work.
  let quick = tryQuickCompile(context);
  // The templates answer one job at a time. When the person asked for a
  // SEQUENCE and the templates only covered one of the jobs, taking the fast
  // path would quietly answer half the request — hand it to the model, which
  // can split the sentence into a job per item and join them.
  if (
    quick &&
    quick.kind === "draft" &&
    quick.draft.automations.length < 2 &&
    CHAIN_REQUEST_RE.test(context.userText)
  ) {
    quick = null;
  }
  if (quick) {
    onProgress("draft", "Matching a verified quick request…");
    const quickStarted = Date.now();
    const draftLog: StageLog = {
      stage: "draft",
      startedAt: quickStarted,
      finishedAt: Date.now(),
      status: "ok",
      lines: [
        {
          at: Date.now(),
          text: `Matched: ${quick.matched.join(", ")}. No model wait needed.`,
          anchor: anchor(runId, anchorN++),
        },
      ],
      sentence: "Built from verified public-data templates on this computer.",
    };
    stages.push(draftLog);

    if (quick.kind === "question") {
      run.counters.questionCard = true;
      await updateRun(runId, (r) => {
        r.status = "needs_you";
        r.finishedAt = Date.now();
        r.summary = quick.question.asking;
      });
      return {
        ok: true,
        automations: [],
        chain: null,
        question: quick.question,
        argument: ["Stopped immediately because this request needs a private service connection."],
        failSentence: null,
        runId,
        keptToOneStep: false,
      };
    }

    const assembled = quick.draft.automations.map((automation) =>
      assembleRecord(automation, "Private Pilot quick path", context)
    );
    const validateLog: StageLog = {
      stage: "validate",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      status: "ok",
      lines: [
        {
          at: Date.now(),
          text: "Hostnames and response shapes came from the verified endpoint catalog.",
          anchor: anchor(runId, anchorN++),
        },
      ],
      sentence: "Verified template — no model correction pass needed.",
    };
    stages.push(validateLog);
    // "a sequence of the price of meta and the weather of orlando" — the
    // jobs are new AND the person asked for one connected thing. The
    // templates build the jobs; the line joining them is drawn here, so a
    // sequence of brand-new automations arrives from a single sentence.
    // Order the members the way the request said them, so the card lists
    // them in the order they will run.
    const ordered = CHAIN_REQUEST_RE.test(context.userText)
      ? orderByMention(assembled, context.userText)
      : assembled;
    const quickChain = CHAIN_REQUEST_RE.test(context.userText)
      ? sequenceFrom(ordered)
      : null;
    const summary =
      assembled.length === 1
        ? `Built "${assembled[0].name}" — waiting for a watched run`
        : quickChain
          ? `Built ${assembled.length} automations joined into "${quickChain.name}" — waiting for a watched run`
          : `Built ${assembled.length} independent automations — waiting for a watched run`;
    await updateRun(runId, (r) => {
      r.status = "ok";
      r.finishedAt = Date.now();
      r.summary = summary;
      r.automationId = assembled[0]?.id ?? "draft";
    });
    return {
      ok: true,
      automations: ordered,
      chain: quickChain,
      question: null,
      argument: [
        quickChain
          ? `Matched verified templates and joined them in the order you said — ${ordered.map((a) => a.name).join(" → ")}.`
          : "Matched a verified template — skipped the local AI wait.",
      ],
      failSentence: null,
      runId,
      keptToOneStep: assembled.length === 1,
    };
  }

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

  const stopped = async (stage?: StageLog): Promise<CompileResult> => {
    const sentence = "Stopped by you. Nothing was saved.";
    if (stage) {
      stage.status = "held";
      stage.finishedAt = Date.now();
      stage.sentence = sentence;
    }
    await updateRun(runId, (r) => {
      r.status = "held";
      r.finishedAt = Date.now();
      r.summary = sentence;
    });
    return {
      ok: false,
      automations: [],
      chain: null,
      question: null,
      argument: [],
      failSentence: null,
      runId,
      keptToOneStep: false,
      cancelled: true,
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
    if (context.singleJob) catalog = { ...catalog, singleJob: true };
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

  // Common grounded file jobs are deterministic once a real catalog path is
  // known. This path also returns the ordinary file/folder question card when
  // the words are ambiguous, so Ollama never spends two minutes discovering
  // that it needs the person to choose a folder.
  const fileQuick = tryQuickFileCompile(context, catalog);
  if (fileQuick) {
    onProgress("draft", "Matching a safe file request…");
    draftLog.status = "ok";
    draftLog.finishedAt = Date.now();
    draftLog.sentence = "Built from a grounded file template on this computer.";
    draftLog.lines.push({
      at: Date.now(),
      text: `Matched: ${fileQuick.matched.join(", ")}. No drafting-model wait needed.`,
      anchor: anchor(runId, anchorN++),
    });

    if (fileQuick.kind === "question") {
      run.counters.questionCard = true;
      await updateRun(runId, (record) => {
        record.status = "needs_you";
        record.finishedAt = Date.now();
        record.summary = fileQuick.question.asking;
      });
      return {
        ok: true,
        automations: [],
        chain: null,
        question: fileQuick.question,
        argument: [
          "Matched the file action immediately and asked for a real catalog path instead of guessing.",
        ],
        failSentence: null,
        runId,
        keptToOneStep: false,
      };
    }

    const assembled = fileQuick.draft.automations.map((automation) =>
      assembleRecord(automation, "Private Pilot file quick path", context)
    );
    const validateLog: StageLog = {
      stage: "validate",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      status: "ok",
      lines: [
        {
          at: Date.now(),
          text: "Checked every read/write path against the live file catalog and closed tool fence.",
          anchor: anchor(runId, anchorN++),
        },
      ],
      sentence: "Grounded file template - no model correction pass needed.",
    };
    stages.push(validateLog);
    const summary = `Built "${assembled[0].name}" - waiting for a watched run`;
    await updateRun(runId, (record) => {
      record.status = "ok";
      record.finishedAt = Date.now();
      record.summary = summary;
      record.automationId = assembled[0].id;
    });
    return {
      ok: true,
      automations: assembled,
      chain: null,
      question: null,
      argument: [
        "Matched a grounded file template - skipped the local AI drafting wait.",
      ],
      failSentence: null,
      runId,
      keptToOneStep: true,
    };
  }

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

  // A single read-only app/web job does not need the full file + mail +
  // branching grammar. On CPU-only machines that broad grammar can take more
  // than two minutes; the compact path produces the same validated record
  // with a small schema, then the normal runner and permission fences take
  // over.
  try {
    onProgress("draft", "Drafting a lightweight read job…");
    const compact = await compactReadDraft(context, model, catalog, signal);
    if (compact) {
      run.counters.drafts++;
      draftLog.status = "ok";
      draftLog.finishedAt = Date.now();
      draftLog.sentence = "Built with the lightweight local compiler.";
      draftLog.lines.push({
        at: Date.now(),
        text: `Small draft returned in ${(compact.ms / 1000).toFixed(1)}s.`,
        anchor: anchor(runId, anchorN++),
      });

      const validateLog: StageLog = {
        stage: "validate",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        status: "ok",
        lines: [
          {
            at: Date.now(),
            text: "Checked the finished record against the same app, source, schedule, and permission fences as the full compiler.",
            anchor: anchor(runId, anchorN++),
          },
        ],
        sentence: "Compact draft passed the full record validator.",
      };
      stages.push(validateLog);

      const assembled = compact.draft.automations.map((automation) =>
        assembleRecord(automation, model, context)
      );
      const summary = `Built "${assembled[0].name}" — waiting for a watched run`;
      await updateRun(runId, (record) => {
        record.status = "ok";
        record.finishedAt = Date.now();
        record.summary = summary;
        record.automationId = assembled[0].id;
      });
      return {
        ok: true,
        automations: assembled,
        chain: null,
        question: null,
        argument: [
          "Used the lightweight local compiler for one read-only job.",
        ],
        failSentence: null,
        runId,
        keptToOneStep: true,
      };
    }
  } catch (e) {
    if (signal?.aborted) return stopped(draftLog);
    draftLog.status = "broke";
    draftLog.finishedAt = Date.now();
    draftLog.sentence =
      e instanceof ProviderError ? e.sentence : "The lightweight draft broke.";
    return fail(
      e instanceof ProviderError
        ? e.sentence
        : `Lightweight drafting broke — ${String(e)}`
    );
  }

  onProgress("draft", "Drafting…");
  const messages = draftMessages(catalog, context);
  let firstContent: string;
  try {
    const res = await draftCall(model, catalog, messages, signal);
    firstContent = res.content;
    run.counters.drafts++;
    draftLog.lines.push({
      at: Date.now(),
      text: `Draft 1 returned in ${(res.ms / 1000).toFixed(1)}s (grammar-locked to the schema).`,
      anchor: anchor(runId, anchorN++),
    });
  } catch (e) {
    if (signal?.aborted) return stopped(draftLog);
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
      (text) => onProgress("validate", text),
      signal
    );
  } catch (e) {
    if (signal?.aborted) return stopped(valLog);
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
    // Keep WHY. Without this the run records that three drafts failed and
    // throws away the only thing that says what was wrong with them, which
    // makes the same failure un-diagnosable the second time it happens.
    if (outcome.lastError) {
      valLog.lines.push({
        at: Date.now(),
        text: `Last validator complaint — ${outcome.lastError.replace(/\s+/g, " ").slice(0, 400)}`,
        anchor: anchor(runId, anchorN++),
      });
    }
    // Offering "Something in Downloads" for a job about a price or the weather
    // is the same wrong-domain guess the file compiler used to make. Only
    // offer folders when the request actually reached for files.
    const wantsFiles = catalog.readTargets.length > 0;
    const question: CompileQuestion = {
      asking: wantsFiles
        ? "What exactly should this automation work on?"
        : "I couldn't get this into one clear automation — what should it do first?",
      term: context.userText,
      kind: "other",
      options: wantsFiles
        ? catalog.folders
            .filter((f) => f.readable)
            .slice(0, 3)
            .map((f) => ({ label: `Something in ${f.label}`, value: f.display }))
        : [],
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
  if (
    draft.chain &&
    (draft.chain.links.length > 0 || (draft.chain.steps?.length ?? 0) > 0)
  ) {
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
      // Branching: the flat step list, automation names resolved to ids.
      ...((draft.chain.steps?.length ?? 0) > 0
        ? {
            steps: draft.chain.steps!.map((s) => ({
              id: s.id,
              automationId: nameToId.get(s.automation) ?? s.automation,
              after: s.after,
              needs: s.needs,
              when: s.when,
              // "" is a constrained-decoding slip for "no condition" — every
              // consumer is truthiness-guarded, so an empty string silently
              // deletes the branch. Normalize to null (absent) here.
              ifAnswerContains: s.if_answer_contains || null,
              ifAnswerLacks: s.if_answer_lacks || null,
              map: Object.fromEntries(s.map.map((p) => [p.output, p.input])),
            })),
          }
        : {}),
      timeoutMinutes: 30,
      createdAt: Date.now(),
      components: assembled.map((record) => ({
        automationId: record.id,
        revisionId: record.revision!.id,
        revisionNumber: record.revision!.number,
      })),
      permissions: mergePermissionManifests(assembled),
    };
  }

  // The person asked for a sequence and the drafter produced the jobs but no
  // line between them. Drawing that line is arithmetic, not judgement — do it
  // here rather than spending another model pass (or failing the draft) on
  // something the order of the sentence already decided.
  if (!chain && assembled.length > 1 && CHAIN_REQUEST_RE.test(context.userText)) {
    chain = sequenceFrom(orderByMention(assembled, context.userText));
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
  // Backup sources ride along in the fence, not around it: when a source has
  // a curated same-fact mirror, the record LISTS it, so the permission line
  // the person approves already says "2 websites" and a run that meets bot
  // protection can keep going without anything sneaking outside the fence.
  const sources = [...a.sources, ...mirrorHostsFor(a.sources)];
  const record: AutomationRecord = {
    id: newId("auto"),
    name: a.name,
    sentence: a.sentence,
    category: a.category,
    steps: a.steps,
    inputs: a.inputs,
    outputs: a.outputs,
    files: a.files,
    formats,
    sources,
    apps: a.apps,
    tools: a.tools,
    knowledge: a.knowledge,
    delivers: a.delivers,
    schedule: a.schedule,
    model,
    effort: a.effort,
    compiledBy: model,
    permissions: permissionManifestFor({ ...a, sources }),
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
  return {
    ...normalizeAutomation(record),
    revision: draftRevisionFor(record),
  };
}
