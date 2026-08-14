import { useEffect, useState } from "react";
import { GearIcon } from "./icons";
import { loadAll } from "../storage/stores";
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

export default function App() {
  const [tab, setTab] = useState<TabId>("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Turns red the moment any watcher or run is broken (wired to runs in step 6).
  const [errorDot] = useState(false);

  useEffect(() => {
    loadAll();
  }, []);

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
              {t.id === "activity" && errorDot && <span className="nav-dot" />}
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
    </div>
  );
}
