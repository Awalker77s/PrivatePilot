import { useEffect, useState } from "react";
import { GearIcon } from "./icons";
import { loadAll, getState } from "../storage/stores";
import { useStoreVersion } from "../storage/useStore";
import { loadSettings } from "../storage/settings";
import { initDispatcher } from "../dispatcher";
import { ChatTab } from "./tabs/ChatTab";
import { AutomationsTab } from "./tabs/AutomationsTab";
import { ActivityTab } from "./tabs/ActivityTab";
import { SettingsSheet } from "./SettingsSheet";

export type TabId = "chat" | "automations" | "activity";

const TABS: { id: TabId; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "automations", label: "Automations" },
  { id: "activity", label: "Activity" },
];

interface CurrentProblem {
  name: string;
  sentence: string;
}

// The Tailscale pattern: a red dot on the nav whenever any watcher or run is
// broken; the newest error pinned as a one-line strip; clicking opens an
// Errors drawer with every current problem verbatim.
function currentProblems(): CurrentProblem[] {
  const { automations } = getState();
  const problems: CurrentProblem[] = [];
  for (const a of automations.records) {
    if (a.lastRun?.status === "broke") {
      problems.push({ name: a.name, sentence: a.lastRun.summary });
    }
  }
  return problems;
}

export default function App() {
  useStoreVersion();
  const [tab, setTab] = useState<TabId>("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [errorsOpen, setErrorsOpen] = useState(false);

  useEffect(() => {
    loadAll();
    loadSettings();
    initDispatcher();
  }, []);

  const problems = currentProblems();

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-glyph">P</span>
          Private Pilot
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === "activity" && problems.length > 0 && (
                <span className="nav-dot" data-testid="nav-dot" />
              )}
            </button>
          ))}
        </nav>
        <button
          className="gear"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <GearIcon size={17} />
        </button>
      </header>

      {problems.length > 0 && (
        <button
          className="error-strip"
          onClick={() => setErrorsOpen(true)}
          data-testid="error-strip"
        >
          <span className="dot dot-red" />
          {problems[0].name} — {problems[0].sentence}
          {problems.length > 1 && (
            <span className="caption"> · {problems.length - 1} more</span>
          )}
        </button>
      )}

      <main className="tabpanel" hidden={tab !== "chat"}>
        <ChatTab goTo={setTab} />
      </main>
      <main className="tabpanel" hidden={tab !== "automations"}>
        <AutomationsTab goTo={setTab} />
      </main>
      <main className="tabpanel" hidden={tab !== "activity"}>
        <ActivityTab goTo={setTab} />
      </main>

      {settingsOpen && <SettingsSheet close={() => setSettingsOpen(false)} />}
      {errorsOpen && (
        <div className="sheet-overlay" onClick={() => setErrorsOpen(false)}>
          <div
            className="settings-sheet"
            onClick={(e) => e.stopPropagation()}
            data-testid="errors-drawer"
          >
            <div className="sheet-title">Everything currently broken</div>
            {problems.length === 0 && (
              <div className="caption">Nothing is broken right now.</div>
            )}
            {problems.map((p, i) => (
              <div key={i} className="settings-card">
                <div className="settings-card-title">{p.name}</div>
                <div
                  className="status-line"
                  style={{ color: "var(--red)" }}
                >
                  {p.sentence}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
