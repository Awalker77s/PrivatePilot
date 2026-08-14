import type { TabId } from "../App";
import { SearchIcon } from "../icons";

export function AutomationsTab({ goTo }: { goTo: (t: TabId) => void }) {
  return (
    <div className="automations">
      <div className="automations-toolbar">
        <div className="searchbox">
          <SearchIcon size={13} />
          <input placeholder="Search" />
        </div>
        <div className="toolbar-actions">
          <button className="btn" onClick={() => goTo("chat")}>
            Tell it
          </button>
          <button className="btn btn-primary" onClick={() => goTo("chat")}>
            <span className="dot dot-red" style={{ background: "#06281a" }} />
            Watch me
          </button>
        </div>
      </div>

      <div className="empty">
        <div className="empty-status">Nothing built yet.</div>
        <div className="empty-what">
          Automations are recorded tasks compiled into records you can read.
        </div>
        <button className="btn" onClick={() => goTo("chat")}>
          Describe a task
        </button>
      </div>
    </div>
  );
}
