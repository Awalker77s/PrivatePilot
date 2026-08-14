import type { TabId } from "../App";

export function ActivityTab({ goTo }: { goTo: (t: TabId) => void }) {
  return (
    <div className="activity">
      <div className="empty">
        <div className="empty-what">
          Run something and what happened lands here.
        </div>
        <button className="btn" onClick={() => goTo("automations")}>
          See automations
        </button>
      </div>
    </div>
  );
}
