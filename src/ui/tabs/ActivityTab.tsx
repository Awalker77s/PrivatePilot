// Activity is an outcomes surface. Completed answers are the default view;
// paused work is grouped into one clearly labelled panel, and pipeline logs
// stay behind an explicit "View run details" action.
import { useState } from "react";
import type { TabId } from "../App";
import { getAutomation, getState } from "../../storage/stores";
import { useStoreVersion } from "../../storage/useStore";
import type { RunRecord } from "../../storage/types";
import { clockTime, dayLabel, relTime } from "../fmt";
import { RunDetail, SendDraftButton } from "../RunDetail";
import { LinkIcon } from "../icons";
import { CategoryGlyph } from "../glyphs";
import { StarterGallery } from "../StarterGallery";
import { answerAlreadyTrue, isAlreadyTrueAsk } from "../../dispatcher/watchers";
import { Sparkline, numberSeries } from "../Sparkline";
import { FormattedAnswer } from "../FormattedAnswer";

function headlineValue(run: RunRecord): string {
  const answer = run.answer ?? run.summary ?? "";
  const money = answer.match(/\$[\d,]+(?:\.\d+)?/);
  if (money) return money[0];
  const firstLine = answer.split("\n")[0];
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

type FeedItem =
  | { kind: "run"; run: RunRecord }
  | { kind: "chain"; runs: RunRecord[] };

export function ActivityTab(props: { goTo: (tab: TabId) => void }) {
  useStoreVersion();
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [showNeeds, setShowNeeds] = useState(false);
  const { runs, automations } = getState();
  const all = [...runs.records].reverse();

  const needsYou = all.filter(
    (run) => run.status === "needs_you" && !(run.diff?.applied ?? false)
  );
  const completed = all.filter(
    (run) =>
      run.status === "ok" &&
      !!run.answer?.trim() &&
      run.automationId !== "draft"
  );

  const nameOf = (run: RunRecord): string => {
    const automation = automations.records.find(
      (candidate) => candidate.id === run.automationId
    );
    if (automation) return automation.name;
    return run.automationId === "draft" ? "Automation setup" : "Result";
  };

  if (all.length === 0) {
    return (
      <div className="activity">
        <StarterGallery goToChat={() => props.goTo("chat")} />
      </div>
    );
  }

  const feed: FeedItem[] = [];
  for (const run of completed) {
    const previous = feed[feed.length - 1];
    if (
      run.chainId &&
      previous?.kind === "chain" &&
      previous.runs[0].chainId === run.chainId
    ) {
      previous.runs.push(run);
    } else if (run.chainId) {
      feed.push({ kind: "chain", runs: [run] });
    } else {
      feed.push({ kind: "run", run });
    }
  }

  const groups: { label: string; items: FeedItem[] }[] = [];
  for (const item of feed) {
    const at = item.kind === "run" ? item.run.startedAt : item.runs[0].startedAt;
    const label = dayLabel(at);
    const group = groups.find((candidate) => candidate.label === label);
    if (group) group.items.push(item);
    else groups.push({ label, items: [item] });
  }

  const latestResults: RunRecord[] = [];
  for (const run of completed) {
    if (latestResults.some((item) => item.automationId === run.automationId)) continue;
    latestResults.push(run);
    if (latestResults.length >= 4) break;
  }

  const allLocal = runs.records.every((run) => run.ranOn === "local");
  const cloudCount = runs.records.filter((run) => run.ranOn !== "local").length;

  return (
    <div className="activity" data-testid="activity">
      <div className="activity-section-head">
        <div>
          <div className="activity-title">Latest results</div>
          <div className="activity-subtitle">
            Finished answers only. Run steps stay hidden unless you ask for them.
          </div>
        </div>
        <span className="chip chip-gray">
          {completed.length} result{completed.length === 1 ? "" : "s"}
        </span>
      </div>

      {latestResults.length > 0 ? (
        <div className="results-shelf" data-testid="results-shelf">
          {latestResults.map((run) => {
            const automation = automations.records.find(
              (candidate) => candidate.id === run.automationId
            );
            const resultKey = `result:${run.id}`;
            return (
              <button
                key={run.id}
                className="result-card card"
                onClick={() => setOpenRun(openRun === resultKey ? null : resultKey)}
                aria-expanded={openRun === resultKey}
              >
                <div className="result-name">
                  {automation && (
                    <CategoryGlyph category={automation.category} size={20} />
                  )}
                  <span>{automation?.name ?? nameOf(run)}</span>
                  <span className="caption">{relTime(run.finishedAt ?? run.startedAt)}</span>
                </div>
                <div className="result-value-row">
                  <span className="result-value">{headlineValue(run)}</span>
                  <DeltaChip run={run} all={all} />
                  <Sparkline values={numberSeries(runs.records, run.automationId)} />
                </div>
                {automation?.sources[0] && (
                  <span className="caption">{automation.sources[0]}</span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="empty-results card">
          No completed results yet. Run an automation and its answer will appear here.
        </div>
      )}

      {latestResults.some((run) => openRun === `result:${run.id}`) && (
        <div className="activity-detail card result-detail-card">
          <OutcomeDetail runId={openRun!.slice("result:".length)} />
        </div>
      )}

      {needsYou.length > 0 && (
        <NeedsPanel
          runs={needsYou}
          expanded={showNeeds}
          setExpanded={setShowNeeds}
          nameOf={nameOf}
          openRun={openRun}
          setOpenRun={setOpenRun}
          openChat={() => props.goTo("chat")}
        />
      )}

      {groups.length > 0 && (
        <div className="activity-feed">
          <div className="activity-section-head history-head">
            <div>
              <div className="activity-title">Result history</div>
              <div className="activity-subtitle">Every delivered answer, newest first.</div>
            </div>
          </div>
          {groups.map((group) => (
            <div key={group.label}>
              <div className="caption day-label">{group.label.toUpperCase()}</div>
              {group.items.map((item) =>
                item.kind === "run" ? (
                  <ResultRow
                    key={item.run.id}
                    run={item.run}
                    name={nameOf(item.run)}
                    open={openRun}
                    setOpen={setOpenRun}
                  />
                ) : (
                  <ResultChainRow
                    key={item.runs[0].id}
                    runs={item.runs}
                    nameOf={nameOf}
                    open={openRun}
                    setOpen={setOpenRun}
                  />
                )
              )}
            </div>
          ))}
        </div>
      )}

      <FooterMark allLocal={allLocal} cloudCount={cloudCount} />
    </div>
  );
}

function NeedsPanel({
  runs,
  expanded,
  setExpanded,
  nameOf,
  openRun,
  setOpenRun,
  openChat,
}: {
  runs: RunRecord[];
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  nameOf: (run: RunRecord) => string;
  openRun: string | null;
  setOpenRun: (id: string | null) => void;
  openChat: () => void;
}) {
  return (
    <section className="needs-panel card" data-testid="needs-panel">
      <button className="needs-panel-toggle" onClick={() => setExpanded(!expanded)}>
        <span className="needs-icon">!</span>
        <span className="needs-copy">
          <b>
            Needs your input <span className="chip chip-amber">{runs.length}</span>
          </b>
          <span>
            These jobs paused before producing a result. Nothing was changed or sent.
          </span>
        </span>
        <span className="btn btn-sm">{expanded ? "Hide" : "Review"}</span>
      </button>

      {expanded && (
        <div className="needs-list">
          {runs.map((run) => {
            const key = `need:${run.id}`;
            const hasChanges = !!run.diff?.entries.length;
            return (
              <div className="needs-item" key={run.id}>
                <div className="needs-item-main">
                  <div>
                    <b>{nameOf(run)}</b>
                    <div className="status-line">{run.summary ?? "Waiting for your choice."}</div>
                  </div>
                  <span className="caption">{relTime(run.startedAt)}</span>
                </div>
                <div className="needs-actions">
                  {isAlreadyTrueAsk(run) ? (
                    <>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => answerAlreadyTrue(run.id, true)}
                      >
                        Fire once
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => answerAlreadyTrue(run.id, false)}
                      >
                        Wait for next crossing
                      </button>
                    </>
                  ) : hasChanges ? (
                    <button
                      className="btn btn-sm"
                      onClick={() => setOpenRun(openRun === key ? null : key)}
                    >
                      {openRun === key ? "Close review" : "Review changes"}
                    </button>
                  ) : (
                    <button className="btn btn-sm" onClick={openChat}>
                      Continue in Chat
                    </button>
                  )}
                </div>
                {openRun === key && (
                  <div className="needs-detail">
                    <RunDetail runId={run.id} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function OutcomeDetail({ runId }: { runId: string }) {
  useStoreVersion();
  const [showTechnical, setShowTechnical] = useState(false);
  const run = getState().runs.records.find((candidate) => candidate.id === runId);
  if (!run) return <div className="caption">This result is no longer available.</div>;
  const automation = getAutomation(run.automationId);
  const completedAt = run.finishedAt ?? run.startedAt;
  return (
    <div className="outcome-detail" data-testid="outcome-detail">
      <div className="outcome-answer">
        <FormattedAnswer text={run.answer ?? run.summary ?? "Completed."} />
      </div>
      <div className="outcome-meta">
        <span>{new Date(completedAt).toLocaleString()}</span>
        {automation?.sources.length ? (
          <span>Source: {automation.sources.join(", ")}</span>
        ) : null}
        <span>{run.ranOn === "local" ? "Ran on this computer" : `Ran on ${run.ranOn}`}</span>
      </div>
      <SendDraftButton run={run} />
      <button
        className="btn btn-sm outcome-technical-toggle"
        onClick={() => setShowTechnical(!showTechnical)}
      >
        {showTechnical ? "Hide run details" : "View run details"}
      </button>
      {showTechnical && (
        <div className="outcome-technical">
          <RunDetail runId={run.id} />
        </div>
      )}
    </div>
  );
}

function ResultRow({
  run,
  name,
  open,
  setOpen,
}: {
  run: RunRecord;
  name: string;
  open: string | null;
  setOpen: (id: string | null) => void;
}) {
  return (
    <div>
      <button
        className="activity-row result-history-row"
        onClick={() => setOpen(open === run.id ? null : run.id)}
        data-testid="activity-result-row"
        aria-expanded={open === run.id}
      >
        <span className="dot dot-green" />
        <span className="activity-name">{name}</span>
        <span className="activity-summary">{headlineValue(run)}</span>
        <span className="caption">{clockTime(run.finishedAt ?? run.startedAt)}</span>
      </button>
      {open === run.id && (
        <div className="activity-detail">
          <OutcomeDetail runId={run.id} />
        </div>
      )}
    </div>
  );
}

function ResultChainRow({
  runs,
  nameOf,
  open,
  setOpen,
}: {
  runs: RunRecord[];
  nameOf: (run: RunRecord) => string;
  open: string | null;
  setOpen: (id: string | null) => void;
}) {
  const key = `chain:${runs[0].chainId ?? runs[0].id}`;
  const chain = getState().chains.records.find(
    (candidate) => candidate.id === runs[0].chainId
  );
  const latest = runs[0];
  return (
    <div>
      <button
        className="activity-row result-history-row"
        onClick={() => setOpen(open === key ? null : key)}
        data-testid="activity-result-chain-row"
        aria-expanded={open === key}
      >
        <span className="dot dot-green" />
        <LinkIcon size={12} />
        <span className="activity-name">{chain?.name ?? "Automation chain"}</span>
        <span className="activity-summary">{headlineValue(latest)}</span>
        <span className="caption">{clockTime(latest.finishedAt ?? latest.startedAt)}</span>
      </button>
      {open === key && (
        <div className="activity-detail chain-outcomes">
          {runs.map((run) => (
            <div className="chain-outcome" key={run.id}>
              <div className="activity-name">{nameOf(run)}</div>
              <OutcomeDetail runId={run.id} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DeltaChip({ run, all }: { run: RunRecord; all: RunRecord[] }) {
  const firstNumber = (text: string | null): number | null => {
    const match = text?.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  };
  const current = firstNumber(run.answer);
  if (current === null) return null;
  const previous = all.find(
    (candidate) =>
      candidate.automationId === run.automationId &&
      candidate.id !== run.id &&
      candidate.startedAt < run.startedAt &&
      candidate.status === "ok" &&
      candidate.answer
  );
  const previousNumber = previous ? firstNumber(previous.answer) : null;
  if (previousNumber === null || previousNumber === 0) return null;
  const percent = ((current - previousNumber) / previousNumber) * 100;
  if (!Number.isFinite(percent) || Math.abs(percent) < 0.005) return null;
  const up = percent > 0;
  return (
    <span className={`chip ${up ? "chip-green" : "chip-red"}`}>
      {up ? "▲" : "▼"} {Math.abs(percent).toFixed(1)}%
    </span>
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
