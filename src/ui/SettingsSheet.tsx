import { XIcon } from "./icons";

export function SettingsSheet({ close }: { close: () => void }) {
  return (
    <div className="sheet-overlay" onClick={close}>
      <div className="settings-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">
          Settings
          <button className="gear" onClick={close} title="Close">
            <XIcon size={15} />
          </button>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">Local AI</div>
          <div className="status-line">Not checked yet.</div>
          <div className="caption">
            The model doctor reads what Ollama has loaded and how.
          </div>
        </div>

        <div style={{ flex: 1 }} />
        <div className="caption">Private Pilot 0.1.0</div>
      </div>
    </div>
  );
}
