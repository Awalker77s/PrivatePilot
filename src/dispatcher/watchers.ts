// Watchers: an ordinary automation with {"trigger":"watch","everyMinutes":N}
// — a heartbeat while the app is open (floor 5 min). Crossings are LATCHED:
// last value + armed flag per link; fire once on the crossing; re-arm only
// after it crosses back (~1% slack). Every miss and every unreadable value
// is an event, never a silent skip.
import type { ChainCondition, RunRecord } from "../storage/types";
import { appendRun, getAutomation, getState, newId, updateRun } from "../storage/stores";
import { getSettings, updateSettings } from "../storage/settings";
import { runAutomation } from "../runner/run";
import { holdModelInMemory } from "../providers/ollama";
import { chainOrder, evalCondition } from "./index";

const TICK_MS = 60_000;
const FLOOR_MINUTES = 5;
const REARM_SLACK = 0.01;

export interface LatchState {
  lastValue: number | null;
  armed: boolean;
  askedAlreadyTrue: boolean;
}

// chainId:linkIndex → latch, persisted in settings so a restart remembers.
function latchKey(chainId: string, linkIdx: number): string {
  return `${chainId}:${linkIdx}`;
}

let timer: ReturnType<typeof setInterval> | null = null;
let releaseHold: (() => void) | null = null;
let ticking = false;

export function initWatchers(): void {
  if (timer) return;
  timer = setInterval(() => void watcherTick(), TICK_MS);
  // First look shortly after launch — the missed-while-closed check.
  setTimeout(() => void watcherTick(), 4_000);
}

export async function watcherTick(force = false): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const { automations } = getState();
    const watchers = automations.records.filter(
      (a) => a.schedule.trigger === "watch"
    );

    // keep_alive ≥ heartbeat: hold the model while any watcher is armed so
    // heartbeats never pay a cold load.
    if (watchers.length > 0 && !releaseHold) {
      releaseHold = holdModelInMemory();
    } else if (watchers.length === 0 && releaseHold) {
      releaseHold();
      releaseHold = null;
    }

    // Daily schedules ride the same heartbeat: run once when the hour has
    // passed; a fully-missed day is said out loud, never skipped silently.
    const dailies = getState().automations.records.filter(
      (a) => a.schedule.trigger === "daily"
    );
    for (const auto of dailies) {
      if (auto.schedule.trigger !== "daily") continue;
      const last = getSettings().lastWatchTick?.[auto.id] ?? 0;
      const now = new Date();
      const todaySlot = new Date(now);
      todaySlot.setHours(auto.schedule.hour, 0, 0, 0);
      if (now < todaySlot || last >= todaySlot.getTime()) continue;
      const missedDays = last
        ? Math.floor((todaySlot.getTime() - last) / 86_400_000)
        : 0;
      await updateSettings((s) => {
        s.lastWatchTick = { ...(s.lastWatchTick ?? {}), [auto.id]: Date.now() };
      });
      if (missedDays > 1) {
        const missed = new Date(todaySlot.getTime() - 86_400_000);
        await heldNote(
          "",
          auto.id,
          `Skipped ${missed.toLocaleDateString(undefined, { weekday: "long" })} — this computer was asleep.`
        );
      }
      try {
        const run = await runAutomation(auto, {
          cause: `it's ${auto.schedule.hour}:00`,
        });
        void run;
      } catch {
        // the run records its own designed failure
      }
    }

    for (const auto of watchers) {
      const every = Math.max(
        auto.schedule.trigger === "watch" ? auto.schedule.everyMinutes : 15,
        FLOOR_MINUTES
      );
      const last = getSettings().lastWatchTick?.[auto.id] ?? 0;
      if (!force && Date.now() - last < every * 60_000) continue;
      await updateSettings((s) => {
        s.lastWatchTick = { ...(s.lastWatchTick ?? {}), [auto.id]: Date.now() };
      });
      try {
        const run = await runAutomation(auto, {
          cause: "the watcher checked",
          viaChain: true, // the latch decides what fires, not the plain dispatcher
        });
        if (run.status === "broke") {
          // Value unreadable → loud, never a silent skip. lastRun already
          // carries the red state; make the sentence specific.
          await updateRun(run.id, (r) => {
            r.summary = "I can't read the price any more — fix ›";
          });
          const saved = getAutomation(auto.id);
          if (saved?.lastRun) {
            saved.lastRun.summary = "I can't read the price any more — fix ›";
          }
          continue;
        }
        await evaluateWatcherLinks(auto.id, run);
      } catch {
        // runAutomation records its own designed failure
      }
    }
  } finally {
    ticking = false;
  }
}

// The latched crossing evaluation for every chain link leaving a watcher.
async function evaluateWatcherLinks(
  automationId: string,
  run: RunRecord
): Promise<void> {
  const { chains } = getState();
  for (const chain of chains.records) {
    const order = chainOrder(chain);
    const idx = order.indexOf(automationId);
    if (idx < 0 || idx >= order.length - 1) continue;
    const linkIdx = chain.links.findIndex((l) => l.from === automationId);
    const link = chain.links[linkIdx];
    if (!link) continue;

    const cond = link.onlyWhen;
    if (!cond || (cond.op !== "crosses_above" && cond.op !== "crosses_below")) {
      // Non-crossing conditions evaluate statefully-enough in plain JS.
      const verdict = evalCondition(cond, run.baton, null);
      if (verdict.fire) await fireNext(chain.id, link.to, run, linkIdx);
      else if (verdict.sentence) await heldNote(chain.id, link.to, verdict.sentence);
      continue;
    }

    const raw = run.baton?.[cond.field];
    const value = Number(String(raw ?? "").replace(/[$,]/g, ""));
    if (raw === undefined || Number.isNaN(value) || value <= 0) {
      // An unreadable value is an event, never a silent skip — and never
      // data: a rate-limited fetch must not read as "the price is 0".
      await heldNote(
        chain.id,
        link.to,
        `I can't read the ${cond.field.replace(/_/g, " ")} any more — fix ›`
      );
      continue;
    }
    const threshold = Number(cond.value);
    const key = latchKey(chain.id, linkIdx);
    const latches = getSettings().watchLatches ?? {};
    const latch: LatchState = latches[key] ?? {
      lastValue: null,
      armed: false,
      askedAlreadyTrue: false,
    };
    const beyond =
      cond.op === "crosses_above" ? value > threshold : value < threshold;

    let fired = false;
    let sentence: string | null = null;

    if (latch.lastValue === null) {
      if (beyond && !latch.askedAlreadyTrue) {
        // Already true at save — ask, don't guess.
        latch.askedAlreadyTrue = true;
        latch.armed = false;
        await askAlreadyTrue(chain.id, link.to, cond, value, run, linkIdx);
      } else {
        latch.armed = !beyond;
      }
    } else if (latch.armed && beyond) {
      // THE crossing — fire exactly once.
      fired = true;
      latch.armed = false;
    } else if (!latch.armed && !beyond) {
      // Crossed back over the line (with ~1% slack) — re-arm.
      const slackLine =
        cond.op === "crosses_above"
          ? threshold * (1 - REARM_SLACK)
          : threshold * (1 + REARM_SLACK);
      const clearlyBack =
        cond.op === "crosses_above" ? value < slackLine : value > slackLine;
      if (clearlyBack) latch.armed = true;
    } else if (!latch.armed && beyond && latch.lastValue !== null) {
      const wasBeyond =
        cond.op === "crosses_above"
          ? latch.lastValue > threshold
          : latch.lastValue < threshold;
      if (!wasBeyond && !latch.askedAlreadyTrue) {
        // It crossed while we couldn't see it (app closed between ticks).
        sentence = `It ${cond.op === "crosses_below" ? "dipped" : "climbed"} to ${fmtVal(value, cond)} while you were away.`;
      }
    }

    latch.lastValue = value;
    await updateSettings((s) => {
      s.watchLatches = { ...(s.watchLatches ?? {}), [key]: latch };
    });

    if (fired) {
      await fireNext(chain.id, link.to, run, linkIdx);
    } else if (sentence) {
      await heldNote(chain.id, link.to, sentence);
    }
  }
}

function fmtVal(v: number, cond: ChainCondition): string {
  const big = Math.abs(Number(cond.value)) >= 100 || Math.abs(v) >= 100;
  return big ? `$${v.toLocaleString()}` : String(v);
}

async function fireNext(
  chainId: string,
  toId: string,
  fromRun: RunRecord,
  linkIdx: number
): Promise<void> {
  const next = getAutomation(toId);
  if (!next) return;
  const { chains } = getState();
  const chain = chains.records.find((c) => c.id === chainId);
  const link = chain?.links[linkIdx];
  const inputValues: Record<string, string> = {};
  if (link) {
    for (const [output, input] of Object.entries(link.map)) {
      const v = fromRun.baton?.[output];
      if (v !== undefined) inputValues[input] = String(v);
    }
  }
  const cond = link?.onlyWhen;
  await runAutomation(next, {
    cause: "the watcher saw it cross",
    chainId,
    stepIndex: linkIdx + 1,
    inputValues,
    viaChain: true,
    contextNote: cond
      ? `the watcher confirmed ${cond.field.replace(/_/g, " ")} ${cond.op.replace(/_/g, " ")} ${cond.value} — it just happened.`
      : "the watcher's condition just fired.",
  });
}

async function heldNote(chainId: string, toId: string, sentence: string) {
  const auto = getAutomation(toId);
  if (!auto) return;
  const run: RunRecord = {
    id: newId("run"),
    automationId: auto.id,
    chainId,
    stepIndex: null,
    cause: "the watcher checked",
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
        anchor: `${newId("run")}#w`,
      },
    ],
    counters: { drafts: 0, fieldsFixed: 0, questionCard: false },
    didNotDo: [sentence],
    diff: null,
    answer: null,
  };
  await appendRun(run);
}

// "It's already below that right now — fire once now, or wait for the next
// dip?" — a needs-you record; Activity renders the two verbs.
async function askAlreadyTrue(
  chainId: string,
  toId: string,
  cond: ChainCondition,
  value: number,
  fromRun: RunRecord,
  linkIdx: number
): Promise<void> {
  const auto = getAutomation(toId);
  if (!auto) return;
  const dir = cond.op === "crosses_below" ? "below" : "above";
  const run: RunRecord = {
    id: newId("run"),
    automationId: auto.id,
    chainId,
    stepIndex: null,
    cause: "already-true ask",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    status: "needs_you",
    ranOn: "local",
    sandbox: null,
    baton: fromRun.baton,
    summary: `It's already ${dir} that right now (${fmtVal(value, cond)}) — fire once now, or wait for the next ${cond.op === "crosses_below" ? "dip" : "climb"}?`,
    stages: [],
    events: [
      {
        at: Date.now(),
        family: "needs_you",
        state: "Already-true condition",
        sentence: `It's already ${dir} that right now — fire once now, or wait?`,
        anchor: `${newId("run")}#ask`,
      },
    ],
    counters: { drafts: 0, fieldsFixed: 0, questionCard: false },
    didNotDo: [],
    diff: null,
    answer: null,
  };
  await appendRun(run);
  // Stash what firing would need.
  pendingAsks.set(run.id, { chainId, toId, fromRun, linkIdx });
}

const pendingAsks = new Map<
  string,
  { chainId: string; toId: string; fromRun: RunRecord; linkIdx: number }
>();

export async function answerAlreadyTrue(
  runId: string,
  fireNow: boolean
): Promise<void> {
  const ask = pendingAsks.get(runId);
  pendingAsks.delete(runId);
  await updateRun(runId, (r) => {
    r.status = "held";
    r.summary = fireNow
      ? "You said fire once now."
      : "You said wait for the next crossing.";
  });
  if (ask && fireNow) {
    await fireNext(ask.chainId, ask.toId, ask.fromRun, ask.linkIdx);
  }
}

export function isAlreadyTrueAsk(run: RunRecord): boolean {
  return run.cause === "already-true ask" && run.status === "needs_you";
}
