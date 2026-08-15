// Surface 1 · Tiles on a shelf. Gradient glyph, 2–4 word name, ONE live
// status line — always live state, never a description. Hover shows ▶ and
// "…" (the confirm names the thing). Click opens the sheet.
import React, { useState } from "react";
import type { TabId } from "../App";
import { SearchIcon, PlayIcon } from "../icons";
import { getState, deleteAutomation, saveAutomation } from "../../storage/stores";
import { useStoreVersion } from "../../storage/useStore";
import type { AutomationRecord } from "../../storage/types";
import { CategoryGlyph } from "../glyphs";
import { relTime, nextRunSentence } from "../fmt";
import { AutomationSheet } from "../AutomationSheet";
import { runAutomation } from "../../runner/run";
import { hostnameOf } from "../../runner/fetchPage";

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
        <div className="tile-grid" data-testid="tile-grid">
          {records.map((a) => (
            <Tile
              key={a.id}
              auto={a}
              running={runningIds.has(a.id)}
              open={() => setSheetFor(a.id)}
            />
          ))}
        </div>
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
