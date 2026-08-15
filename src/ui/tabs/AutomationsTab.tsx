// Surface 1 · Tiles on a shelf. Gradient glyph, 2–4 word name, ONE live
// status line — always live state, never a description. Hover shows ▶ and
// "…" (the confirm names the thing). Click opens the sheet.
import React, { useState } from "react";
import type { TabId } from "../App";
import { SearchIcon, PlayIcon, LinkIcon, ArrowRightIcon } from "../icons";
import { getState, deleteAutomation, saveAutomation } from "../../storage/stores";
import { useStoreVersion } from "../../storage/useStore";
import type { AutomationRecord, ChainRecord } from "../../storage/types";
import { CategoryGlyph } from "../glyphs";
import { relTime, nextRunSentence, scheduleSentence } from "../fmt";
import { AutomationSheet } from "../AutomationSheet";
import { runAutomation } from "../../runner/run";
import { hostnameOf } from "../../runner/fetchPage";
import { chainOrder, latestExecution, runChain } from "../../dispatcher";

export function AutomationsTab({ goTo }: { goTo: (t: TabId) => void }) {
  useStoreVersion();
  const [query, setQuery] = useState("");
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const { automations, runs } = getState();

  const q = query.trim().toLowerCase();
  const records = automations.records.filter(
    (a) =>
      !q ||
      a.name.toLowerCase().includes(q) ||
      a.sentence.toLowerCase().includes(q)
  );

  const runningIds = new Set(
    runs.records.filter((r) => r.status === "running").map((r) => r.automationId)
  );

  const sheetAuto = sheetFor
    ? automations.records.find((a) => a.id === sheetFor)
    : null;

  return (
    <div className="automations">
      <div className="automations-toolbar">
        <div className="searchbox">
          <SearchIcon size={13} />
          <input
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="toolbar-actions">
          <button className="btn" onClick={() => goTo("chat")}>
            Tell it
          </button>
          <button className="btn btn-primary" onClick={() => goTo("chat")}>
            <span className="dot" style={{ background: "#06281a" }} />
            Watch me
          </button>
        </div>
      </div>

      {automations.records.length === 0 ? (
        <div className="empty">
          <div className="empty-status">Nothing built yet.</div>
          <div className="empty-what">
            Automations are recorded tasks compiled into records you can read.
          </div>
          <button className="btn" onClick={() => goTo("chat")}>
            Describe a task
          </button>
        </div>
      ) : (
        <>
          {getState().chains.records.map((c) => (
            <ChainStrip
              key={c.id}
              chain={c}
              openSheet={(id) => setSheetFor(id)}
            />
          ))}
          <div className="tile-grid" data-testid="tile-grid">
            {records
              .filter(
                (a) =>
                  !getState().chains.records.some((c) =>
                    chainOrder(c).includes(a.id)
                  )
              )
              .map((a) => (
                <Tile
                  key={a.id}
                  auto={a}
                  running={runningIds.has(a.id)}
                  open={() => setSheetFor(a.id)}
                />
              ))}
          </div>
        </>
      )}

      {sheetAuto && (
        <AutomationSheet
          auto={sheetAuto}
          close={() => setSheetFor(null)}
          goToChat={() => goTo("chat")}
        />
      )}
    </div>
  );
}

function Tile({
  auto,
  running,
  open,
}: {
  auto: AutomationRecord;
  running: boolean;
  open: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(auto.name);

  const status = tileStatus(auto, running);
  const chip = cornerChip(auto);

  return (
    <div
      className={`tile card${running ? " tile-running" : ""}`}
      onClick={() => !menu && !renaming && open()}
      data-testid="tile"
    >
      <div className="tile-top">
        <CategoryGlyph category={auto.category} />
        {chip && <span className="chip chip-gray tile-chip">{chip}</span>}
        <div className="tile-hover-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="btn btn-sm btn-ghost"
            title="Run with last settings"
            onClick={() =>
              runAutomation(auto, { cause: "you pressed Run" })
            }
          >
            <PlayIcon size={11} />
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => setMenu(!menu)}
          >
            …
          </button>
        </div>
      </div>
      {renaming ? (
        <input
          className="tile-rename"
          value={name}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === "Enter") {
              await saveAutomation({ ...auto, name: name.trim() || auto.name });
              setRenaming(false);
            }
            if (e.key === "Escape") {
              setName(auto.name);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <div className="tile-name">{auto.name}</div>
      )}
      <div className="status-line" data-testid="tile-status">
        {status}
      </div>

      {menu && (
        <div className="tile-menu" onClick={(e) => e.stopPropagation()}>
          {!confirmDelete ? (
            <>
              <button
                className="tile-menu-item"
                onClick={() => {
                  setMenu(false);
                  runAutomation(auto, { cause: "you pressed Run" });
                }}
              >
                Run
              </button>
              <button
                className="tile-menu-item"
                onClick={() => {
                  setMenu(false);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
              <button
                className="tile-menu-item tile-menu-danger"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            </>
          ) : (
            <>
              <div className="caption" style={{ padding: "4px 10px" }}>
                Delete "{auto.name}"?
              </div>
              <button
                className="tile-menu-item tile-menu-danger"
                onClick={() => deleteAutomation(auto.id)}
              >
                Delete it
              </button>
              <button
                className="tile-menu-item"
                onClick={() => {
                  setConfirmDelete(false);
                  setMenu(false);
                }}
              >
                Leave it
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// A chain renders as a full-width strip: name bar (status dot · last ran ·
// next · Run) + member mini-tiles joined by arrows carrying their conditions.
function ChainStrip({
  chain,
  openSheet,
}: {
  chain: ChainRecord;
  openSheet: (autoId: string) => void;
}) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const { automations } = getState();
  const order = chainOrder(chain);
  const members = order
    .map((id) => automations.records.find((a) => a.id === id))
    .filter((a): a is AutomationRecord => !!a);
  if (members.length === 0) return null;

  const exec = latestExecution(chain.id);
  const lastAt = exec.length ? exec[exec.length - 1].startedAt : null;
  const anyBroke = exec.some((r) => r.status === "broke");
  const first = members[0];
  const next = nextRunSentence(first.schedule);

  async function run() {
    setRunning(true);
    try {
      await runChain(chain, members, {
        cause: "you pressed Run",
        resume: anyBroke,
        onProgress: (p) => setProgress(`${p.autoName} — ${p.text}`),
      });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  return (
    <div className="chain-strip card" data-testid="chain-strip">
      <div className="strip-bar">
        <LinkIcon size={13} />
        <b>{chain.name}</b>
        <span className="chip chip-gray">{members.length} steps</span>
        {first.schedule.trigger !== "manual" && (
          <span className="chip chip-gray">
            {scheduleSentence(first.schedule).toLowerCase()}
          </span>
        )}
        <span className="status-line" style={{ flex: 1 }}>
          {running ? (
            <>
              <span className="spinner" style={{ width: 10, height: 10 }} />
              {progress ?? "running…"}
            </>
          ) : (
            <>
              <span
                className={`dot ${anyBroke ? "dot-red" : exec.length ? "dot-green" : "dot-gray"}`}
              />
              {lastAt ? `ran ${relTime(lastAt)}` : "never run"}
              {next ? ` · ${next}` : ""}
            </>
          )}
        </span>
        <button
          className="btn btn-primary btn-sm"
          disabled={running}
          onClick={run}
          data-testid="chain-run"
        >
          <PlayIcon size={11} /> Run
        </button>
      </div>
      <div className="strip-members">
        {members.map((m, i) => {
          const link = chain.links.find((l) => l.to === m.id);
          return (
            <div key={m.id} className="strip-member">
              {i > 0 && (
                <div className="strip-arrow">
                  <ArrowRightIcon size={13} />
                  {link?.onlyWhen && (
                    <span className="caption">
                      {conditionLabel(link.onlyWhen)}
                    </span>
                  )}
                </div>
              )}
              <button className="mini-tile" onClick={() => openSheet(m.id)}>
                <CategoryGlyph category={m.category} size={22} />
                <div>
                  <div className="tile-name">{m.name}</div>
                  <div className="status-line">
                    {m.lastRun
                      ? `${m.lastRun.status === "ok" ? "✓" : m.lastRun.status === "broke" ? "✕" : "●"} ${m.lastRun.summary.slice(0, 34)}`
                      : m.outputs.length
                        ? `hands back ${m.outputs.map((o) => o.name.replace(/_/g, " ")).join(", ")}`
                        : "never run"}
                  </div>
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function conditionLabel(c: {
  field: string;
  op: string;
  value: string | number | null;
}): string {
  switch (c.op) {
    case "crosses_above":
      return `only over ${typeof c.value === "number" && c.value >= 100 ? "$" : ""}${c.value}`;
    case "crosses_below":
      return `only under ${c.value}`;
    case "moves_more_than_pct":
      return `moves >${c.value}%`;
    case "now_contains":
      return `mentions "${c.value}"`;
    default:
      return `${c.field} changed`;
  }
}

function tileStatus(auto: AutomationRecord, running: boolean): React.ReactNode {
  if (running)
    return (
      <>
        <span className="spinner" style={{ width: 10, height: 10 }} />
        running…
      </>
    );
  const last = auto.lastRun;
  if (!last) {
    const next = nextRunSentence(auto.schedule);
    return <>{next ?? "never run"}</>;
  }
  if (last.status === "broke")
    return (
      <span style={{ color: "var(--red)" }}>
        {last.summary.length > 42 ? last.summary.slice(0, 42) + "…" : last.summary} — fix ›
      </span>
    );
  if (last.status === "needs_you")
    return (
      <span style={{ color: "var(--amber)" }}>
        <span className="dot dot-amber" /> 1 needs you
      </span>
    );
  const next = nextRunSentence(auto.schedule);
  const summary =
    last.summary.length > 34 ? last.summary.slice(0, 34) + "…" : last.summary;
  return (
    <>
      <span style={{ color: "var(--green)" }}>✓</span> {relTime(last.at)} ·{" "}
      {summary}
      {next ? ` · ${next}` : ""}
    </>
  );
}

function cornerChip(auto: AutomationRecord): string | null {
  if (auto.schedule.trigger === "watch")
    return `👁 every ${auto.schedule.everyMinutes} min`;
  if (auto.sources.length > 0) {
    const host = hostnameOf(auto.sources[0]) ?? auto.sources[0];
    return `checks ${host.replace(/^www\./, "").replace(/^api\./, "")}`;
  }
  if (auto.category === "Email") return "drafts to you";
  return null;
}
