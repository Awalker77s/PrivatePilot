// Run detail — GitHub Actions' four proven behaviors mapped to the five
// pipeline stages: collapsible rows with their own elapsed time, the failed
// stage auto-expands with its designed sentence, stable anchor ids, and a
// searchable log. Ends with the "What I did not do" line.
import { useState } from "react";
import { getRun } from "../storage/stores";
import { useStoreVersion } from "../storage/useStore";
import type { StageLog } from "../storage/types";
import { elapsedShort } from "./fmt";
import { DiffCard } from "./DiffCard";
import { keepRun, putBackRun, sandboxFor } from "../runner/run";
import { updateRun } from "../storage/stores";

const STAGE_TITLES: Record<StageLog["stage"], string> = {
  draft: "1 · Schema-constrained drafting",
  validate: "2 · Validator loop",
  tools: "3 · Agentic tool loop",
  thorough: "4 · Thorough mode",
  verify: "5 · Grounded verification",
};

const STATUS_WORD: Record<StageLog["status"], { word: string; cls: string }> = {
  ok: { word: "Ran", cls: "chip-green" },
  broke: { word: "Broke", cls: "chip-red" },
  held: { word: "Held back", cls: "chip-gray" },
  running: { word: "Running", cls: "chip-blue" },
  skipped: { word: "Skipped", cls: "chip-gray" },
};

export function RunDetail({ runId }: { runId: string }) {
  useStoreVersion();
  const run = getRun(runId);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [keepNote, setKeepNote] = useState<string | null>(null);

  if (!run) return <div className="caption">This run's record is missing.</div>;

  const q = search.trim().toLowerCase();
  const sandboxAlive = !!sandboxFor(runId);

  return (
    <div className="run-detail" data-testid="run-detail">
      <input
        className="run-search"
        placeholder="Search this run's log"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {run.stages.map((s) => {
        const st = STATUS_WORD[s.status];
        const expanded =
          open === s.stage || (open === null && s.status === "broke");
        const lines = q
          ? s.lines.filter((l) => l.text.toLowerCase().includes(q))
          : s.lines;
        if (q && lines.length === 0 && !s.sentence?.toLowerCase().includes(q))
          return null;
        return (
          <div key={s.stage} className="stage-row" id={`${runId}-${s.stage}`}>
            <button
              className="stage-head"
              onClick={() => setOpen(expanded ? "" : s.stage)}
            >
              <span className={`chip ${st.cls}`}>{st.word}</span>
              <span className="stage-title">{STAGE_TITLES[s.stage]}</span>
              <span className="caption">
                {s.finishedAt ? elapsedShort(s.finishedAt - s.startedAt) : "…"}
              </span>
            </button>
            {expanded && (
              <div className="stage-body">
                {s.sentence && (
                  <div
                    className="status-line"
                    style={{
                      color:
                        s.status === "broke" ? "var(--red)" : "var(--muted)",
                    }}
                  >
                    {s.sentence}
                  </div>
                )}
                {lines.map((l) => (
                  <div key={l.anchor} className="log-line" id={l.anchor} title={l.anchor}>
                    {l.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {run.events.length > 0 && (
        <div className="stage-body">
          {run.events.map((e) => (
            <div key={e.anchor} className="log-line" id={e.anchor}>
              <span
                className={`chip ${
                  e.family === "broke"
                    ? "chip-red"
                    : e.family === "needs_you"
                      ? "chip-amber"
                      : "chip-gray"
                }`}
              >
                {e.family === "broke"
                  ? "Broke"
                  : e.family === "needs_you"
                    ? "Needs you"
                    : "On purpose"}
              </span>{" "}
              {e.sentence}
            </div>
          ))}
        </div>
      )}

      {run.baton && (
        <div className="baton-line">
          Handing off:{" "}
          {Object.entries(run.baton)
            .map(([k, v]) => `${k} = ${v}`)
            .join(" · ")}
        </div>
      )}

      {run.diff && run.diff.entries.length > 0 && (
        <>
          {!sandboxAlive && !run.diff.applied && (
            <div className="caption">
              This run's sandbox is gone — run it again to apply changes.
            </div>
          )}
          <DiffCard
            diff={run.diff}
            disabled={!sandboxAlive && !run.diff.applied}
            keepSentence={keepNote}
            onToggle={(rel) => {
              const entry = run.diff!.entries.find((e) => e.relPath === rel);
              if (entry && !run.diff!.applied) {
                entry.kept = !entry.kept;
                updateRun(runId, () => {}, false);
              }
            }}
            onKeep={async () => setKeepNote(await keepRun(runId))}
            onPutBack={async () => {
              await putBackRun(runId);
              setKeepNote(null);
            }}
            onNotNow={() =>
              updateRun(runId, (r) => {
                if (r.status === "needs_you") {
                  r.status = "held";
                  r.summary = "Left in the copy — nothing applied.";
                }
              })
            }
          />
        </>
      )}

      <div className="caption" data-testid="did-not-do">
        {run.didNotDo.join(" · ")}
      </div>
    </div>
  );
}
