// Surface 4 · Activity — what needs you pinned first, then everything that
// happened, grouped by day, footer telling the truth about where compute
// ran. A red strip pins the newest broken thing; clicking opens the Errors
// drawer.
import { useState } from "react";
import type { TabId } from "../App";
import { getState } from "../../storage/stores";
import { useStoreVersion } from "../../storage/useStore";
import type { RunRecord } from "../../storage/types";
import { clockTime, dayLabel } from "../fmt";
import { RunDetail } from "../RunDetail";
import { LinkIcon } from "../icons";

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
        <div className="empty">
          <div className="empty-what">
            Run something and what happened lands here.
          </div>
          <button className="btn" onClick={() => _props.goTo("automations")}>
            See automations
          </button>
        </div>
      </div>
    );
  }

  // Day groups over the non-pinned rows.
  const groups: { label: string; rows: RunRecord[] }[] = [];
  for (const r of rest) {
    const label = dayLabel(r.startedAt);
    const g = groups.find((g) => g.label === label);
    if (g) g.rows.push(r);
    else groups.push({ label, rows: [r] });
  }

  const allLocal = runs.records.every((r) => r.ranOn === "local");
  const cloudCount = runs.records.filter((r) => r.ranOn !== "local").length;

  return (
    <div className="activity" data-testid="activity">
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
            {g.rows.map((r) => (
              <div key={r.id}>
                <button
                  className="activity-row"
                  onClick={() => setOpenRun(openRun === r.id ? null : r.id)}
                  data-testid="activity-row"
                >
                  <span
                    className={`dot ${
                      r.status === "ok"
                        ? "dot-green"
                        : r.status === "broke"
                          ? "dot-red"
                          : r.status === "needs_you"
                            ? "dot-amber"
                            : r.status === "running"
                              ? "dot-gray"
                              : "dot-gray"
                    }`}
                  />
                  {r.chainId && <LinkIcon size={12} />}
                  <span className="activity-name">{nameOf(r)}</span>
                  <span className="activity-summary">
                    {r.status === "running" ? "running…" : (r.summary ?? "")}
                  </span>
                  <span className="caption">{clockTime(r.startedAt)}</span>
                </button>
                {openRun === r.id && (
                  <div className="activity-detail">
                    <RunDetail runId={r.id} />
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="activity-footer caption" data-testid="activity-footer">
        {allLocal
          ? "✓ Everything ran on this computer"
          : `${cloudCount} run${cloudCount === 1 ? "" : "s"} borrowed cloud compute (Featherless) — the rest ran on this computer`}
      </div>
    </div>
  );
}
