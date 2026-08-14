import { useEffect, useState } from "react";
import { XIcon } from "./icons";
import { runStorageSelfTest, SelfTestResult } from "../storage/selftest";
import { useStore } from "../storage/useStore";
import { DoctorReport, runModelDoctor } from "../providers/ollama";
import { chat } from "../providers";
import { NUM_CTX_DRAFT } from "../providers";

export function SettingsSheet({ close }: { close: () => void }) {
  const { loadError } = useStore();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SelfTestResult | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [waking, setWaking] = useState(false);
  const [wakeLine, setWakeLine] = useState<string | null>(null);

  useEffect(() => {
    runModelDoctor().then(setDoctor);
  }, []);

  async function wake() {
    if (!doctor?.installedTag) return;
    setWaking(true);
    setWakeLine(null);
    try {
      // A real chat round trip — explicit num_ctx like every call.
      const res = await chat({
        model: doctor.installedTag,
        messages: [
          { role: "user", content: "Answer with the single word: ready" },
        ],
        options: { num_ctx: NUM_CTX_DRAFT, temperature: 0, seed: 7 },
      });
      const word = res.content.trim().slice(0, 40) || "(empty)";
      setWakeLine(
        `Answered "${word}" in ${(res.totalMs / 1000).toFixed(1)}s.`
      );
      setDoctor(await runModelDoctor()); // now /api/ps has real values
    } catch (e) {
      const sentence =
        e instanceof Error && "sentence" in e
          ? (e as { sentence: string }).sentence
          : String(e);
      setWakeLine(sentence);
    } finally {
      setWaking(false);
    }
  }

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

        <div className="settings-card" data-testid="model-doctor">
          <div className="settings-card-title">
            Local AI
            <button
              className="btn btn-sm"
              onClick={wake}
              disabled={waking || !doctor?.installedTag}
              data-testid="wake-model"
            >
              {waking ? "Waking…" : "Wake it"}
            </button>
          </div>
          {!doctor ? (
            <div className="status-line">Checking…</div>
          ) : (
            <div
              className="status-line"
              style={{
                color:
                  doctor.up && doctor.installedTag
                    ? "var(--text)"
                    : "var(--red)",
              }}
              data-testid="doctor-sentence"
            >
              {doctor.sentence}
            </div>
          )}
          {doctor?.toolsCapable != null && (
            <div className="caption">
              {doctor.toolsCapable
                ? "Knows how to call tools."
                : "Can't call tools — runs will use the drafting protocol."}
              {doctor.visionCapable ? " Can look at screenshots." : ""}
            </div>
          )}
          {wakeLine && (
            <div className="caption" data-testid="wake-line">
              {wakeLine}
            </div>
          )}
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
