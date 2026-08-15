// Surface 2 · The automation sheet — one viewport, zero scroll. Folding
// accordion rows; rows that don't apply don't render; each row = label ·
// current value · one faint honest sub-line. The sheet is the readable
// truth; editing lives in chat (Change seeds the composer with the row
// quoted).
import { useState } from "react";
import type { AutomationRecord } from "../storage/types";
import { getState, saveAutomation } from "../storage/stores";
import { useStoreVersion } from "../storage/useStore";
import { CategoryGlyph } from "./glyphs";
import { XIcon, PlayIcon, ChevronRight } from "./icons";
import { friendlyName } from "../providers/ollama";
import { relTime, scheduleSentence } from "./fmt";
import { runAutomation } from "../runner/run";
import { openAutomationStudio, seedComposer } from "./chatStore";
import { getSettings } from "../storage/settings";
import { approveRevision, isRevisionApproved, revokeRevision } from "../storage/permissions";
import { normalizeAutomation, permissionSummary } from "../storage/revisions";

interface Row {
  key: string;
  label: string;
  value: string;
  sub: string | null;
  changeSeed: string | null;
}

export function AutomationSheet({
  auto,
  close,
  goToChat,
}: {
  auto: AutomationRecord;
  close: () => void;
  goToChat: () => void;
}) {
  useStoreVersion();
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [, refreshPermissions] = useState(0);
  // Fill-ins: declared inputs are asked at run time, example shown.
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const { runs, chains } = getState();
  const myRuns = runs.records.filter(
    (r) => r.automationId === auto.id && r.cause !== "you described a task"
  );
  const cloud = getSettings().featherless.enabled;
  const normalized = normalizeAutomation(auto);
  const approved = isRevisionApproved(normalized);
  const fullAccess = getSettings().permissions?.fullAccess ?? false;

  const memberChains = chains.records.filter((c) =>
    c.links.some((l) => l.from === auto.id || l.to === auto.id)
  );

  const rows: Row[] = [];
  rows.push({
    key: "when",
    label: "When",
    value: scheduleSentence(auto.schedule),
    sub:
      auto.schedule.trigger === "daily"
        ? "while this computer is awake — skipped mornings are listed here, honestly"
        : auto.schedule.trigger === "watch"
          ? "while this computer is awake"
          : null,
    changeSeed: `Change when it runs — right now: ${scheduleSentence(auto.schedule)}.`,
  });

  const fileBits = [
    ...new Set(
      [...auto.files.reads, ...auto.files.writes].map(
        (p) => p.split("/").filter(Boolean).pop() ?? p
      )
    ),
  ];
  if (fileBits.length > 0) {
    rows.push({
      key: "files",
      label: "Your files",
      value: fileBits.join(" · "),
      sub: "works on a copy — nothing changes until you look and say Keep",
      changeSeed: `Change which files it touches — right now: ${fileBits.join(", ")}.`,
    });
  }

  if (auto.outputs.length > 0) {
    rows.push({
      key: "hands",
      label: "Hands back",
      value: auto.outputs.map((o) => o.name.replace(/_/g, " ")).join(" · "),
      sub: "what a chain can pass to the next step",
      changeSeed: null,
    });
  }

  if (auto.inputs.length > 0) {
    rows.push({
      key: "fillins",
      label: "Fill-ins",
      value: auto.inputs.map((i) => `${i.label} (e.g. ${i.example})`).join(" · "),
      sub: "asked when it runs",
      changeSeed: null,
    });
  }

  if (auto.sources.length > 0) {
    rows.push({
      key: "sources",
      label: "Websites",
      value: auto.sources.join(" · "),
      sub: "the only sites it may fetch — a fence, not a suggestion",
      changeSeed: `Change which websites it may fetch — right now: ${auto.sources.join(", ")}.`,
    });
  }

  rows.push({
    key: "get",
    label: "You get",
    value:
      auto.delivers === "answer"
        ? "An answer, here in the app"
        : "Files changed — after your Keep",
    sub: null,
    changeSeed: null,
  });

  for (const chain of memberChains) {
    const order = chainOrder(chain.links);
    const idx = order.indexOf(auto.id);
    rows.push({
      key: `chain-${chain.id}`,
      label: "Part of",
      value: `${chain.name} — step ${idx + 1} of ${order.length} ›`,
      sub: chain.components
        ? `This sequence pins revision ${chain.components.find((component) => component.automationId === auto.id)?.revisionNumber ?? "?"}.`
        : "Legacy sequence — it follows the current automation version.",
      changeSeed: null,
    });
  }

  if (auto.lastRun) {
    rows.push({
      key: "runs",
      label: "Past runs",
      value: `${auto.lastRun.status === "ok" ? "✓" : auto.lastRun.status === "broke" ? "✕" : "●"} ${relTime(auto.lastRun.at)} · ${myRuns.length} run${myRuns.length === 1 ? "" : "s"}`,
      sub: auto.lastRun.summary,
      changeSeed: null,
    });
  }

  async function run(cause: string) {
    setRunning(true);
    setProgress("Starting…");
    try {
      await runAutomation(auto, {
        cause,
        inputValues: Object.fromEntries(
          Object.entries(inputValues).filter(([, v]) => v.trim())
        ),
        onProgress: setProgress,
      });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  function change(seed: string | null) {
    if (!seed) return;
    openAutomationStudio(auto.id);
    seedComposer(`${seed} `);
    close();
    goToChat();
  }

  return (
    <div className="sheet-overlay" onClick={close}>
      <div
        className="auto-sheet card"
        onClick={(e) => e.stopPropagation()}
        data-testid="auto-sheet"
      >
        <div className="auto-sheet-head">
          <CategoryGlyph category={auto.category} size={34} />
          <div className="auto-sheet-title">
            <div className="auto-sheet-name">{auto.name}</div>
            <div className="auto-sheet-sentence">{auto.sentence}</div>
            {auto.origin && (
              <div className="caption" data-testid="origin-line">
                {auto.origin.kind === "watched"
                  ? `Compiled from a recording on ${new Date(auto.origin.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} — ${auto.origin.frames ? `${auto.origin.frames} frames + ` : ""}your words. Frames deleted.`
                  : auto.origin.kind === "edited"
                    ? `Last edited ${new Date(auto.origin.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.`
                    : null}
              </div>
            )}
          </div>
          <span
            className={`chip ${cloud ? "chip-blue" : "chip-green"}`}
            data-testid="runs-on"
          >
            {cloud ? "borrows cloud compute" : "runs on this computer"}
          </span>
          <button className="gear" onClick={close} title="Close">
            <XIcon size={15} />
          </button>
        </div>

        <div className="auto-sheet-actions">
          <button
            className="btn btn-primary"
            disabled={running}
            onClick={() => run("you pressed Run")}
            data-testid="sheet-run"
          >
            <PlayIcon size={12} /> {running ? "Running…" : "Run"}
          </button>
          <span className="chip chip-gray">{friendlyName(auto.model)}</span>
          <button
            className="chip effort-toggle"
            onClick={async () => {
              await saveAutomation({
                ...auto,
                effort: auto.effort === "quick" ? "thorough" : "quick",
              });
            }}
            title="Thorough re-reads its own answer against the source"
          >
            {auto.effort === "quick" ? (
              <>
                <b>Quick</b> | Thorough
              </>
            ) : (
              <>
                Quick | <b>Thorough</b>
              </>
            )}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={running}
            onClick={() => run("you pressed Test run")}
          >
            Test run
          </button>
          <button
            className={`btn btn-sm ${approved ? "btn-ghost" : "btn-primary"}`}
            disabled={fullAccess}
            title={`${permissionSummary(normalized)}. Approval is pinned to revision ${normalized.revision!.number}.`}
            onClick={async () => {
              if (approved) await revokeRevision(normalized);
              else await approveRevision(normalized);
              refreshPermissions((value) => value + 1);
            }}
          >
            {fullAccess
              ? "Covered by full access"
              : approved
                ? "Revoke approval"
                : `Approve v${normalized.revision!.number}`}
          </button>
        </div>
        {auto.inputs.length > 0 && (
          <div className="fillins">
            {auto.inputs.map((inp) => (
              <label key={inp.name} className="fillin">
                <span className="caption">{inp.label}</span>
                <input
                  placeholder={`e.g. ${inp.example}`}
                  value={inputValues[inp.name] ?? ""}
                  onChange={(e) =>
                    setInputValues((v) => ({
                      ...v,
                      [inp.name]: e.target.value,
                    }))
                  }
                />
              </label>
            ))}
          </div>
        )}
        {progress && (
          <div className="pipeline-card" style={{ border: "none", padding: 0 }}>
            <span className="spinner" />
            <span className="stage-text">{progress}</span>
          </div>
        )}

        <div className="sheet-rows">
          {rows.map((row) => (
            <div key={row.key} className="sheet-row">
              <button
                className="sheet-row-head"
                onClick={() => setOpenRow(openRow === row.key ? null : row.key)}
              >
                <span className="sheet-row-label">{row.label}</span>
                <span className="sheet-row-value">{row.value}</span>
                {row.changeSeed && openRow === row.key ? (
                  <span
                    className="sheet-change"
                    onClick={(e) => {
                      e.stopPropagation();
                      change(row.changeSeed);
                    }}
                  >
                    Change ›
                  </span>
                ) : (
                  <ChevronRight size={12} />
                )}
              </button>
              {openRow === row.key && row.sub && (
                <div className="sheet-row-sub">{row.sub}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Order the chain's members by following the links.
export function chainOrder(
  links: { from: string; to: string }[]
): string[] {
  const order: string[] = [];
  const froms = new Set(links.map((l) => l.from));
  const tos = new Set(links.map((l) => l.to));
  let head = [...froms].find((f) => !tos.has(f)) ?? links[0]?.from;
  while (head && !order.includes(head)) {
    order.push(head);
    head = links.find((l) => l.from === head)?.to ?? "";
  }
  return order;
}
