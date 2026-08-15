// The dispatcher: one function runs whenever any run finishes ok — it checks
// links from that automation, evaluates onlyWhen in plain JS on the baton
// value (never a model call at fire time), and starts the next member with
// mapped values. Hop cap 3; A→B→A refused at save; runs.json is the resume
// checkpoint that never re-runs a completed step.
import type {
  AutomationRecord,
  ChainCondition,
  ChainRecord,
  ChainStep,
  RunRecord,
} from "../storage/types";
import {
  appendRun,
  getAutomation,
  getAutomationRevision,
  getState,
  newId,
} from "../storage/stores";
import { registerRunFinishedHook, runAutomation } from "../runner/run";

// Wire the dispatcher to the runner once, at app start.
let initialized = false;
export function initDispatcher(): void {
  if (initialized) return;
  initialized = true;
  registerRunFinishedHook((run) => {
    void dispatchAfterRun(run).catch(() => {
      // dispatchAfterRun appends its own designed records; a throw here means
      // storage failed, which the storage layer already surfaced.
    });
  });
}

const HOP_CAP = 3;

export class ChainCycleError extends Error {
  constructor(public sentence: string) {
    super(sentence);
  }
}

// A→B→A refused at save, with the circle drawn in words.
export function assertNoCycle(
  chain: ChainRecord,
  nameOf: (id: string) => string
): void {
  if (chain.steps?.length) {
    assertStepsValid(chain.steps, nameOf);
    return;
  }
  const seen = new Set<string>();
  let head =
    chain.links.map((l) => l.from).find(
      (f) => !chain.links.some((l) => l.to === f)
    ) ?? chain.links[0]?.from;
  const path: string[] = [];
  while (head) {
    path.push(nameOf(head));
    if (seen.has(head)) {
      throw new ChainCycleError(
        `This chain circles back (${path.join(" → ")}) — chains flow one way.`
      );
    }
    seen.add(head);
    head = chain.links.find((l) => l.from === head)?.to ?? "";
  }
  if (chain.links.length > HOP_CAP) {
    throw new ChainCycleError(
      `This chain has ${chain.links.length} hops — the cap is ${HOP_CAP}.`
    );
  }
}

const STEP_CAP = 8;

// Branching chains: unknown refs, cycles (Kahn's toposort), caps — all
// refused at save with the problem named in words.
export function assertStepsValid(
  steps: ChainStep[],
  nameOf: (id: string) => string
): void {
  if (steps.length > STEP_CAP) {
    throw new ChainCycleError(
      `This chain has ${steps.length} steps — the cap is ${STEP_CAP}.`
    );
  }
  const ids = new Set(steps.map((s) => s.id));
  if (ids.size !== steps.length) {
    throw new ChainCycleError("Two steps share an id — every step needs its own.");
  }
  for (const s of steps) {
    for (const dep of s.after) {
      if (!ids.has(dep)) {
        throw new ChainCycleError(
          `Step ${s.id} waits for "${dep}", which isn't a step in this chain.`
        );
      }
      if (dep === s.id) {
        throw new ChainCycleError(`Step ${s.id} waits for itself.`);
      }
    }
  }
  if (!steps.some((s) => s.after.length === 0)) {
    throw new ChainCycleError(
      "Every step waits for another — a chain needs a first step."
    );
  }
  // Kahn's: if anything remains after peeling roots, there's a circle.
  const indeg = new Map(steps.map((s) => [s.id, s.after.length]));
  const queue = steps.filter((s) => s.after.length === 0).map((s) => s.id);
  let settled = 0;
  while (queue.length) {
    const id = queue.shift()!;
    settled++;
    for (const s of steps) {
      if (!s.after.includes(id)) continue;
      const d = (indeg.get(s.id) ?? 0) - 1;
      indeg.set(s.id, d);
      if (d === 0) queue.push(s.id);
    }
  }
  if (settled !== steps.length) {
    const stuck = steps
      .filter((s) => (indeg.get(s.id) ?? 0) > 0)
      .map((s) => nameOf(s.automationId));
    throw new ChainCycleError(
      `This chain circles back (${stuck.join(" → ")}) — chains flow one way.`
    );
  }
}

// Execution order for a steps chain: Kahn's toposort with ARRAY-ORDER
// tie-breaking — deterministic, and every dep settles before its dependents.
export function stepOrder(steps: ChainStep[]): ChainStep[] {
  const done = new Set<string>();
  const order: ChainStep[] = [];
  while (order.length < steps.length) {
    const ready = steps.find(
      (s) => !done.has(s.id) && s.after.every((d) => done.has(d))
    );
    if (!ready) break; // cyclic remainder — assertStepsValid refuses this at save
    done.add(ready.id);
    order.push(ready);
  }
  return order;
}

export function chainOrder(chain: ChainRecord): string[] {
  if (chain.steps?.length) {
    return stepOrder(chain.steps).map((s) => s.automationId);
  }
  const order: string[] = [];
  const tos = new Set(chain.links.map((l) => l.to));
  let head =
    chain.links.map((l) => l.from).find((f) => !tos.has(f)) ??
    chain.links[0]?.from;
  while (head && !order.includes(head)) {
    order.push(head);
    head = chain.links.find((l) => l.from === head)?.to ?? "";
  }
  return order;
}

// Plain JS on the baton value — the whole condition system.
export function evalCondition(
  cond: ChainCondition | null,
  baton: Record<string, string | number> | null,
  previousBaton: Record<string, string | number> | null
): { fire: boolean; sentence: string | null } {
  if (!cond) return { fire: true, sentence: null };
  const v = baton?.[cond.field];
  if (v === undefined) {
    return {
      fire: false,
      sentence: `Held back — the hand-off had no "${cond.field}" to check.`,
    };
  }
  const num = Number(String(v).replace(/[$,]/g, ""));
  const threshold = Number(cond.value);
  switch (cond.op) {
    case "crosses_above":
      return num > threshold
        ? { fire: true, sentence: null }
        : {
            fire: false,
            sentence: `Held back — ${cond.field} (${v}) didn't cross above ${cond.value}.`,
          };
    case "crosses_below":
      return num < threshold
        ? { fire: true, sentence: null }
        : {
            fire: false,
            sentence: `Held back — ${cond.field} (${v}) didn't dip below ${cond.value}.`,
          };
    case "moves_more_than_pct": {
      const prev = Number(String(previousBaton?.[cond.field] ?? "").replace(/[$,]/g, ""));
      if (!prev || Number.isNaN(prev)) {
        return {
          fire: false,
          sentence: `Held back — no earlier ${cond.field} to compare against yet.`,
        };
      }
      const pct = Math.abs((num - prev) / prev) * 100;
      return pct > threshold
        ? { fire: true, sentence: null }
        : {
            fire: false,
            sentence: `Held back — ${cond.field} moved ${pct.toFixed(1)}%, under the ${cond.value}% line.`,
          };
    }
    case "now_contains":
      return String(v).toLowerCase().includes(String(cond.value).toLowerCase())
        ? { fire: true, sentence: null }
        : {
            fire: false,
            sentence: `Held back — ${cond.field} doesn't mention "${cond.value}".`,
          };
    case "changed_at_all": {
      const prev = previousBaton?.[cond.field];
      return prev === undefined || String(prev) !== String(v)
        ? { fire: true, sentence: null }
        : { fire: false, sentence: `Held back — ${cond.field} hasn't changed.` };
    }
  }
}

function previousBatonOf(automationId: string): Record<string, string | number> | null {
  const runs = getState().runs.records;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].automationId === automationId && runs[i].baton) {
      return runs[i].baton;
    }
  }
  return null;
}

export interface ChainProgress {
  stepIndex: number;
  autoName: string;
  text: string;
}

// Run a chain over records — saved ones or drafts straight from a built
// card. Sequential; the baton maps outputs → inputs by name; a step that
// breaks stops the chain (runs.json lets a re-run resume past completed
// steps and never re-run them).
// One settled step of a branching chain: what happened, and why if skipped.
interface StepState {
  kind: "ran" | "held" | "broke" | "skipped";
  run: RunRecord | null;
  sentence: string | null;
}

// Should this step fire, given how its dependencies settled? Status first
// (skip-cascade: a skipped dep never matches, unless when is "always"), then
// the answer predicate on the FIRST dep's written answer.
function stepVerdict(
  s: ChainStep,
  state: Map<string, StepState>,
  nameOf: (id: string) => string
): { fire: boolean; sentence: string | null } {
  if (s.after.length === 0) return { fire: true, sentence: null };
  const deps = s.after.map((id) => ({ id, st: state.get(id) }));
  if (s.when !== "always") {
    const matches = deps.map(({ st }) => {
      if (!st || st.kind === "skipped") return false;
      if (s.when === "ran") return st.kind === "ran";
      if (s.when === "held") return st.kind === "held";
      return st.kind === "broke";
    });
    const ok = s.needs === "any" ? matches.some(Boolean) : matches.every(Boolean);
    if (!ok) {
      const verb =
        s.when === "ran" ? "didn't finish" : s.when === "held" ? "wasn't held back" : "didn't break";
      const who = deps
        .filter((_, i) => !matches[i])
        .map(({ id }) => nameOf(id))
        .join(", ");
      return { fire: false, sentence: `Held back — ${who} ${verb}.` };
    }
  }
  const first = deps.find(({ st }) => st?.run)?.st;
  const answer = (first?.run?.answer ?? first?.run?.summary ?? "").toLowerCase();
  if (s.ifAnswerContains && !answer.includes(s.ifAnswerContains.toLowerCase())) {
    return {
      fire: false,
      sentence: `Held back — the result didn't mention "${s.ifAnswerContains}".`,
    };
  }
  if (s.ifAnswerLacks && answer.includes(s.ifAnswerLacks.toLowerCase())) {
    return {
      fire: false,
      sentence: `Held back — the result mentioned "${s.ifAnswerLacks}".`,
    };
  }
  return { fire: true, sentence: null };
}

// Run a BRANCHING chain: steps settle in dependency order (array order breaks
// ties); each step fires only if its verdict says so; a skipped step leaves a
// held record naming why. Sequential — one local model, one step at a time.
// `preset` marks root steps that already ran (the dispatcher hands the
// triggering run in so it isn't run twice).
export async function runChainSteps(
  chain: ChainRecord,
  records: AutomationRecord[],
  opts: {
    cause: string;
    onProgress?: (p: ChainProgress) => void;
    resume?: boolean;
    preset?: Map<string, RunRecord>;
  }
): Promise<RunRecord[]> {
  const steps = chain.steps ?? [];
  const byId = new Map(records.map((r) => [r.id, r]));
  const autoOf = (s: ChainStep): AutomationRecord | undefined => {
    const component = chain.components?.find(
      (candidate) => candidate.automationId === s.automationId
    );
    return (
      (component
        ? getAutomationRevision(component.automationId, component.revisionId)
        : undefined) ??
      byId.get(s.automationId) ??
      getAutomation(s.automationId)
    );
  };
  const nameOf = (stepId: string): string => {
    const s = steps.find((x) => x.id === stepId);
    const auto = s ? autoOf(s) : undefined;
    return auto?.name ?? stepId;
  };

  const state = new Map<string, StepState>();
  const results: RunRecord[] = [];
  const order = stepOrder(steps);

  // Resume checkpoint (never re-run a completed step) + dispatcher presets.
  const completed = new Map<number, RunRecord>();
  if (opts.resume) {
    for (const r of latestExecution(chain.id)) {
      if (r.status === "ok" || r.status === "needs_you") {
        completed.set(r.stepIndex ?? -1, r);
      }
    }
  }

  for (const s of order) {
    const index = steps.indexOf(s);
    const auto = autoOf(s);
    if (!auto) {
      state.set(s.id, { kind: "skipped", run: null, sentence: "Its automation is gone." });
      continue;
    }

    const preset = opts.preset?.get(s.id);
    const already = preset ?? completed.get(index);
    if (already) {
      state.set(s.id, {
        kind:
          already.status === "ok"
            ? "ran"
            : already.status === "broke"
              ? "broke"
              : "held",
        run: already,
        sentence: null,
      });
      results.push(already);
      if (!preset) {
        opts.onProgress?.({
          stepIndex: index,
          autoName: auto.name,
          text: "already done — not running it twice",
        });
      }
      continue;
    }

    const verdict = stepVerdict(s, state, nameOf);
    if (!verdict.fire) {
      const held = heldRecord(auto, chain, index, verdict.sentence!, opts.cause);
      await appendRun(held);
      state.set(s.id, { kind: "skipped", run: held, sentence: verdict.sentence });
      results.push(held);
      opts.onProgress?.({
        stepIndex: index,
        autoName: auto.name,
        text: verdict.sentence!,
      });
      continue;
    }

    // Inputs from the first settled dep's baton, mapped by name.
    const inputValues: Record<string, string> = {};
    const firstDep = s.after.map((id) => state.get(id)).find((st) => st?.run);
    for (const [output, input] of Object.entries(s.map)) {
      const v = firstDep?.run?.baton?.[output];
      if (v !== undefined) inputValues[input] = String(v);
    }

    opts.onProgress?.({ stepIndex: index, autoName: auto.name, text: "running" });
    const run = await runAutomation(auto, {
      cause: opts.cause,
      chainId: chain.id,
      stepIndex: index,
      inputValues,
      onProgress: (text) =>
        opts.onProgress?.({ stepIndex: index, autoName: auto.name, text }),
      viaChain: true,
    });
    results.push(run);
    state.set(s.id, {
      kind:
        run.status === "ok" ? "ran" : run.status === "broke" ? "broke" : "held",
      run,
      sentence: null,
    });
  }
  return results;
}

export async function runChain(
  chain: ChainRecord,
  records: AutomationRecord[],
  opts: {
    cause: string;
    onProgress?: (p: ChainProgress) => void;
    resume?: boolean;
  }
): Promise<RunRecord[]> {
  if (chain.steps?.length) return runChainSteps(chain, records, opts);
  const order = chainOrder(chain);
  const byId = new Map(records.map((r) => [r.id, r]));
  const results: RunRecord[] = [];

  // Resume checkpoint: the latest execution's completed steps are never
  // re-run (step 1 may have already emailed someone).
  const completed = new Map<number, RunRecord>();
  if (opts.resume) {
    for (const r of latestExecution(chain.id)) {
      if (r.status === "ok" || r.status === "needs_you") {
        completed.set(r.stepIndex ?? -1, r);
      }
    }
  }

  let baton: Record<string, string | number> | null = null;

  for (let i = 0; i < order.length; i++) {
    const component = chain.components?.find(
      (candidate) => candidate.automationId === order[i]
    );
    const auto =
      (component
        ? getAutomationRevision(component.automationId, component.revisionId)
        : undefined) ??
      byId.get(order[i]) ??
      getAutomation(order[i]);
    if (!auto) break;

    const already = completed.get(i);
    if (already) {
      baton = already.baton ?? baton;
      results.push(already);
      opts.onProgress?.({
        stepIndex: i,
        autoName: auto.name,
        text: "already done — not running it twice",
      });
      continue;
    }

    // The incoming link's condition gates this step; its map carries values.
    const link = chain.links.find((l) => l.to === auto.id);
    const inputValues: Record<string, string> = {};
    if (link && i > 0) {
      const verdict = evalCondition(
        link.onlyWhen,
        baton,
        previousBatonOf(link.from)
      );
      if (!verdict.fire) {
        // A purposeful stop is not a failure — a held record says why.
        const held: RunRecord = heldRecord(auto, chain, i, verdict.sentence!, opts.cause);
        await appendRun(held);
        results.push(held);
        continue;
      }
      for (const [output, input] of Object.entries(link.map)) {
        const v = baton?.[output];
        if (v !== undefined) inputValues[input] = String(v);
      }
    }

    opts.onProgress?.({ stepIndex: i, autoName: auto.name, text: "running" });
    const run = await runAutomation(auto, {
      cause: opts.cause,
      chainId: chain.id,
      stepIndex: i,
      inputValues,
      onProgress: (text) =>
        opts.onProgress?.({ stepIndex: i, autoName: auto.name, text }),
      viaChain: true,
    });
    results.push(run);
    if (run.status === "broke") break;
    baton = run.baton ?? baton;
  }
  return results;
}

function heldRecord(
  auto: AutomationRecord,
  chain: ChainRecord,
  stepIndex: number,
  sentence: string,
  cause: string
): RunRecord {
  return {
    id: newId("run"),
    automationId: auto.id,
    chainId: chain.id,
    stepIndex,
    cause,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    status: "held",
    ranOn: "local",
    sandbox: null,
    baton: null,
    summary: sentence,
    stages: [],
    events: [
      {
        at: Date.now(),
        family: "on_purpose",
        state: "Condition not met",
        sentence,
        anchor: `${newId("run")}#held`,
      },
    ],
    counters: { drafts: 0, fieldsFixed: 0, questionCard: false },
    didNotDo: [sentence],
    diff: null,
    answer: null,
  };
}

// The latest execution of a chain, derived from runs.json (newest run
// backwards until step 0) — the resume checkpoint.
export function latestExecution(chainId: string): RunRecord[] {
  const runs = getState().runs.records;
  const exec: RunRecord[] = [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r.chainId !== chainId) continue;
    exec.unshift(r);
    if (r.stepIndex === 0) break;
  }
  return exec;
}

// The dispatcher hook: runs whenever any non-chain run finishes ok, and
// follows outgoing links (a run already inside a chain is the chain's
// business — runChain drives those steps itself).
export async function dispatchAfterRun(run: RunRecord): Promise<void> {
  if (run.chainId) return;
  const { chains } = getState();

  // Branching chains: a finished root automation (ANY outcome — a "when it
  // breaks" branch is legitimate routing) starts the rest of the chain with
  // this run standing in for the root step.
  for (const chain of chains.records) {
    if (!chain.steps?.length) continue;
    const roots = chain.steps.filter(
      (s) => s.after.length === 0 && s.automationId === run.automationId
    );
    if (roots.length === 0) continue;
    const preset = new Map(roots.map((s) => [s.id, run]));
    await runChainSteps(chain, [], {
      cause: `${chain.name} handed off`,
      preset,
    });
  }

  if (run.status !== "ok" && run.status !== "needs_you") return;
  for (const chain of chains.records) {
    if (chain.steps?.length) continue; // handled above
    const outgoing = chain.links.filter((l) => l.from === run.automationId);
    if (outgoing.length === 0) continue;
    const order = chainOrder(chain);
    const startIdx = order.indexOf(run.automationId);
    let baton = run.baton;
    // Walk the remaining members of this chain from here.
    for (let i = startIdx; i < order.length - 1; i++) {
      const link = chain.links.find(
        (l) => l.from === order[i] && l.to === order[i + 1]
      );
      if (!link) break;
      const component = chain.components?.find(
        (candidate) => candidate.automationId === link.to
      );
      const next = component
        ? getAutomationRevision(component.automationId, component.revisionId)
        : getAutomation(link.to);
      if (!next) break;
      const verdict = evalCondition(
        link.onlyWhen,
        baton,
        previousBatonOf(link.from)
      );
      if (!verdict.fire) {
        await appendRun(
          heldRecord(next, chain, i + 1, verdict.sentence!, run.cause)
        );
        break;
      }
      const inputValues: Record<string, string> = {};
      for (const [output, input] of Object.entries(link.map)) {
        const v = baton?.[output];
        if (v !== undefined) inputValues[input] = String(v);
      }
      const stepRun = await runAutomation(next, {
        cause: `${chain.name} handed off`,
        chainId: chain.id,
        stepIndex: i + 1,
        inputValues,
        viaChain: true,
      });
      if (stepRun.status === "broke") break;
      baton = stepRun.baton ?? baton;
    }
  }
}
