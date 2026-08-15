// The empty state IS the starter gallery: curated records, one click =
// saved + running, the first result lands in seconds. "See how" opens the
// same sheet every automation uses — teaching the record by example.
import { useState } from "react";
import { STARTERS, Starter, instantiateStarter } from "../pipeline/starters";
import { saveAutomation } from "../storage/stores";
import { runAutomation } from "../runner/run";
import { CategoryGlyph } from "./glyphs";
import { AutomationSheet } from "./AutomationSheet";
import type { AutomationRecord } from "../storage/types";

export function StarterGallery({ goToChat }: { goToChat: () => void }) {
  const [busyName, setBusyName] = useState<string | null>(null);
  const [preview, setPreview] = useState<AutomationRecord | null>(null);
  const rows: Starter["row"][] = ["Instant answers", "Every morning"];

  async function tryStarter(s: Starter) {
    if (busyName) return;
    setBusyName(s.record.name);
    try {
      const record = instantiateStarter(s);
      await saveAutomation(record);
      if (record.inputs.length === 0) {
        await runAutomation(record, { cause: "you tried a starter" });
      } else {
        setPreview(record); // fill-ins live on the sheet
      }
    } finally {
      setBusyName(null);
    }
  }

  return (
    <div className="starter-gallery" data-testid="starter-gallery">
      <div className="empty-status">Nothing built yet.</div>
      <div className="empty-what">
        Try one — it runs the moment you click, and the answer lands right
        here.
      </div>
      {rows.map((row) => (
        <div key={row}>
          <div className="caption day-label">{row.toUpperCase()}</div>
          <div className="starter-row">
            {STARTERS.filter((s) => s.row === row).map((s) => (
              <div key={s.record.name} className="starter-card card">
                <div className="result-name">
                  <CategoryGlyph category={s.record.category} size={20} />
                  <span>{s.record.name}</span>
                </div>
                <div className="caption">{s.record.sentence}</div>
                <div className="built-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={busyName !== null}
                    onClick={() => tryStarter(s)}
                  >
                    {busyName === s.record.name ? "Running…" : "Try it"}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setPreview(instantiateStarter(s))}
                  >
                    See how
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="caption" style={{ marginTop: 6 }}>
        Or describe your own job in Chat.
      </div>
      {preview && (
        <AutomationSheet
          auto={preview}
          close={() => setPreview(null)}
          goToChat={goToChat}
        />
      )}
    </div>
  );
}
