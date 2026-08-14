import { useState } from "react";
import { XIcon } from "./icons";
import { runStorageSelfTest, SelfTestResult } from "../storage/selftest";
import { useStore } from "../storage/useStore";

export function SettingsSheet({ close }: { close: () => void }) {
  const { loadError } = useStore();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SelfTestResult | null>(null);

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await runStorageSelfTest());
    } catch (e) {
      setResult({ passed: false, lines: [`Broke: ${String(e)}`] });
    } finally {
      setTesting(false);
    }
  }

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

        <div className="settings-card">
          <div className="settings-card-title">
            Storage
            <button
              className="btn btn-sm"
              onClick={test}
              disabled={testing}
              data-testid="storage-selftest"
            >
              {testing ? "Testing…" : "Test it"}
            </button>
          </div>
          <div className="caption">
            Three JSON files, written whole and renamed into place — a save
            either lands or it doesn't.
          </div>
          {loadError && (
            <div className="status-line" style={{ color: "var(--red)" }}>
              {loadError}
            </div>
          )}
          {result && (
            <div data-testid="storage-selftest-result">
              <div
                className="status-line"
                style={{
                  color: result.passed ? "var(--green)" : "var(--red)",
                }}
              >
                {result.passed ? "Ran" : "Broke"}
              </div>
              {result.lines.map((l, i) => (
                <div key={i} className="caption">
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ flex: 1 }} />
        <div className="caption">Private Pilot 0.1.0</div>
      </div>
    </div>
  );
}
