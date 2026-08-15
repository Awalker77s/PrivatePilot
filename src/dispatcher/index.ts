// The dispatcher: one function runs whenever any run finishes ok — it checks
// links from that automation, evaluates onlyWhen in plain JS on the baton
// value (never a model call at fire time), and starts the next member with
// mapped values. Hop cap 3; A→B→A refused at save; runs.json is the resume
// checkpoint that never re-runs a completed step.
import type {
  AutomationRecord,
  ChainCondition,
  ChainRecord,
  RunRecord,
} from "../storage/types";
import { appendRun, getAutomation, getState, newId } from "../storage/stores";
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

export function chainOrder(chain: ChainRecord): string[] {
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
export async function runChain(
  chain: ChainRecord,
  records: AutomationRecord[],
  opts: {
    cause: string;
    onProgress?: (p: ChainProgress) => void;
    resume?: boolean;
  }
): Promise<RunRecord[]> {
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
    const auto = byId.get(order[i]) ?? getAutomation(order[i]);
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
  if (run.status !== "ok" && run.status !== "needs_you") return;
  const { chains } = getState();
  for (const chain of chains.records) {
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
      const next = getAutomation(link.to);
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
