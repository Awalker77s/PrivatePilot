// Surface 4 · Activity — what needs you pinned first, then everything that
// happened, grouped by day, footer telling the truth about where compute
// ran. A red strip pins the newest broken thing; clicking opens the Errors
// drawer.
import { useState } from "react";
import type { TabId } from "../App";
import { getState } from "../../storage/stores";
import { useStoreVersion } from "../../storage/useStore";
import type { RunRecord } from "../../storage/types";
import { clockTime, dayLabel, relTime } from "../fmt";
import { RunDetail } from "../RunDetail";
import { LinkIcon } from "../icons";
import { CategoryGlyph } from "../glyphs";
import { StarterGallery } from "../StarterGallery";

// The one value worth showing big: a money amount, a number, or the first
// line of the answer — from the record, never recomputed.
function headlineValue(r: RunRecord): string {
  const answer = r.answer ?? r.summary ?? "";
  const money = answer.match(/\$[\d,]+(?:\.\d+)?/);
  if (money) return money[0];
  const firstLine = answer.split("\n")[0];
  return firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
}

export function ActivityTab(_props: { goTo: (t: TabId) => void }) {
  useStoreVersion();
  const [openRun, setOpenRun] = useState<string | null>(null);
  const { runs, automations } = getState();

  const all = [...runs.records].reverse(); // newest first
  const needsYou = all.filter(
    (r) => r.status === "needs_you" && !(r.diff?.applied ?? false)
  );
  const rest = all.filter((r) => !needsYou.includes(r));

  const nameOf = (r: RunRecord): string => {
    const auto = automations.records.find((a) => a.id === r.automationId);
    if (auto) return auto.name;
    if (r.cause === "you described a task") return "Built a draft";
    return "A draft";
  };

  if (all.length === 0) {
    return (
      <div className="activity">
        <StarterGallery goToChat={() => _props.goTo("chat")} />
      </div>
    );
  }

  // A chain run is ONE row that folds open into per-step lines: collapse
  // consecutive runs sharing a chainId.
  type FeedItem = { kind: "run"; run: RunRecord } | { kind: "chain"; runs: RunRecord[] };
  const feed: FeedItem[] = [];
  for (const r of rest) {
    const last = feed[feed.length - 1];
    if (
      r.chainId &&
      last?.kind === "chain" &&
      last.runs[0].chainId === r.chainId
    ) {
      last.runs.push(r);
    } else if (r.chainId) {
      feed.push({ kind: "chain", runs: [r] });
    } else {
      feed.push({ kind: "run", run: r });
    }
  }

  // Day groups over the feed.
  const groups: { label: string; items: FeedItem[] }[] = [];
  for (const it of feed) {
    const at = it.kind === "run" ? it.run.startedAt : it.runs[0].startedAt;
    const label = dayLabel(at);
    const g = groups.find((g) => g.label === label);
    if (g) g.items.push(it);
    else groups.push({ label, items: [it] });
  }

  const allLocal = runs.records.every((r) => r.ranOn === "local");
  const cloudCount = runs.records.filter((r) => r.ranOn !== "local").length;

  // The results shelf: the newest delivered answers, one per automation —
  // a price, a summary, a status — read straight from run records.
  const results: RunRecord[] = [];
  for (const r of all) {
    if (r.status !== "ok" || !r.answer) continue;
    if (results.some((x) => x.automationId === r.automationId)) continue;
    results.push(r);
    if (results.length >= 4) break;
  }

  return (
    <div className="activity" data-testid="activity">
      {results.length > 0 && (
        <div className="results-shelf" data-testid="results-shelf">
          {results.map((r) => {
            const auto = automations.records.find(
              (a) => a.id === r.automationId
            );
            return (
              <button
                key={r.id}
                className="result-card card"
                onClick={() => setOpenRun(openRun === r.id ? null : r.id)}
              >
                <div className="result-name">
                  {auto && <CategoryGlyph category={auto.category} size={20} />}
                  <span>{auto?.name ?? nameOf(r)}</span>
                  <span className="caption">{relTime(r.startedAt)}</span>
                </div>
                <div className="result-value-row">
                  <span className="result-value">{headlineValue(r)}</span>
                  <DeltaChip run={r} all={all} />
                </div>
                {auto && auto.sources.length > 0 && (
                  <span className="caption">{auto.sources[0]}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {results.some((r) => openRun === r.id) && (
        <div className="activity-detail card" style={{ padding: "0 14px" }}>
          <RunDetail runId={openRun!} />
        </div>
      )}
      {needsYou.map((r) => (
        <div key={r.id} className="pinned-card card" data-testid="pinned">
          <div className="pinned-head">
            <b>{nameOf(r)}</b>
            <span className="status-line" style={{ color: "var(--amber)" }}>
              {r.summary ?? "Needs you."}
            </span>
            <button
              className="btn btn-sm"
              onClick={() => setOpenRun(openRun === r.id ? null : r.id)}
            >
              Look first
            </button>
          </div>
          {openRun === r.id && <RunDetail runId={r.id} />}
        </div>
      ))}

      <div className="activity-feed">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="caption day-label">{g.label.toUpperCase()}</div>
            {g.items.map((it) =>
              it.kind === "run" ? (
                <PlainRow
                  key={it.run.id}
                  r={it.run}
                  name={nameOf(it.run)}
                  open={openRun}
                  setOpen={setOpenRun}
                />
              ) : (
                <ChainRow
                  key={it.runs[0].id}
                  runs={it.runs}
                  nameOf={nameOf}
                  open={openRun}
                  setOpen={setOpenRun}
                />
              )
            )}
          </div>
        ))}
      </div>

      <FooterMark allLocal={allLocal} cloudCount={cloudCount} />
    </div>
  );
}

// ▲/▼ vs the previous answer of the same automation — the ticker feel
// without a ticker, computed from persisted run records only.
function DeltaChip({ run, all }: { run: RunRecord; all: RunRecord[] }) {
  const firstNum = (s: string | null): number | null => {
    const m = s?.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const current = firstNum(run.answer);
  if (current === null) return null;
  const prev = all.find(
    (r) =>
      r.automationId === run.automationId &&
      r.id !== run.id &&
      r.startedAt < run.startedAt &&
      r.status === "ok" &&
      r.answer
  );
  const prevNum = prev ? firstNum(prev.answer) : null;
  if (prevNum === null || prevNum === 0) return null;
  const pct = ((current - prevNum) / prevNum) * 100;
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.005) return null;
  const up = pct > 0;
  return (
    <span className={`chip ${up ? "chip-green" : "chip-red"}`}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

function statusDot(status: RunRecord["status"]): string {
  return status === "ok"
    ? "dot-green"
    : status === "broke"
      ? "dot-red"
      : status === "needs_you"
        ? "dot-amber"
        : "dot-gray";
}

function PlainRow({
  r,
  name,
  open,
  setOpen,
}: {
  r: RunRecord;
  name: string;
  open: string | null;
  setOpen: (id: string | null) => void;
}) {
  return (
    <div>
      <button
        className="activity-row"
        onClick={() => setOpen(open === r.id ? null : r.id)}
        data-testid="activity-row"
      >
        <span className={`dot ${statusDot(r.status)}`} />
        <span className="activity-name">{name}</span>
        <span className="activity-summary">
          {r.status === "running" ? "running…" : (r.summary ?? "")}
        </span>
        <span className="caption">{clockTime(r.startedAt)}</span>
      </button>
      {open === r.id && (
        <div className="activity-detail">
          <RunDetail runId={r.id} />
        </div>
      )}
    </div>
  );
}

// One row per chain run; folds open into per-step lines, numbers inline.
function ChainRow({
  runs,
  nameOf,
  open,
  setOpen,
}: {
  runs: RunRecord[];
  nameOf: (r: RunRecord) => string;
  open: string | null;
  setOpen: (id: string | null) => void;
}) {
  const key = `chain-${runs[0].id}`;
  const { chains } = getState();
  const chain = chains.records.find((c) => c.id === runs[0].chainId);
  const okCount = runs.filter((r) => r.status === "ok" || r.status === "needs_you").length;
  const anyBroke = runs.some((r) => r.status === "broke");
  const running = runs.some((r) => r.status === "running");
  const batons = runs
    .filter((r) => r.baton)
    .flatMap((r) => Object.keys(r.baton!));
  const last = runs[runs.length - 1];
  const stalledMin = running
    ? Math.floor((Date.now() - (runs.find((r) => r.status === "running")?.startedAt ?? Date.now())) / 60000)
    : 0;

  const summary = running
    ? `Waiting for ${nameOf(runs.find((r) => r.status === "running")!)} — ${stalledMin} min`
    : anyBroke
      ? (runs.find((r) => r.status === "broke")?.summary ?? "broke")
      : `${okCount} steps ✓${batons.length ? ` — handed ${[...new Set(batons)].map((b) => b.replace(/_/g, " ")).join(", ")}` : ""} → ${last.summary ?? ""}`;

  return (
    <div>
      <button
        className="activity-row"
        onClick={() => setOpen(open === key ? null : key)}
        data-testid="activity-chain-row"
      >
        <span
          className={`dot ${anyBroke ? "dot-red" : running ? "dot-gray" : "dot-green"}`}
        />
        <LinkIcon size={12} />
        <span className="activity-name">{chain?.name ?? "Chain"}</span>
        <span className="activity-summary">{summary}</span>
        <span className="caption">{clockTime(runs[0].startedAt)}</span>
      </button>
      {open === key && (
        <div className="activity-detail">
          <ChainSteps runs={runs} nameOf={nameOf} />
        </div>
      )}
    </div>
  );
}

// Per-step lines, each with its own expandable run detail.
function ChainSteps({
  runs,
  nameOf,
}: {
  runs: RunRecord[];
  nameOf: (r: RunRecord) => string;
}) {
  const [openStep, setOpenStep] = useState<string | null>(null);
  return (
    <>
      {runs.map((r) => (
        <PlainRow
          key={r.id}
          r={r}
          name={`${(r.stepIndex ?? 0) + 1} · ${nameOf(r)}`}
          open={openStep}
          setOpen={setOpenStep}
        />
      ))}
    </>
  );
}

function FooterMark({
  allLocal,
  cloudCount,
}: {
  allLocal: boolean;
  cloudCount: number;
}) {
  return (
    <div className="activity-footer caption" data-testid="activity-footer">
      {allLocal
        ? "✓ Everything ran on this computer"
        : `${cloudCount} run${cloudCount === 1 ? "" : "s"} borrowed cloud compute (Featherless) — the rest ran on this computer`}
    </div>
  );
}
