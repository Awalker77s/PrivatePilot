// The brain switcher in the composer: the model chip is a button, and picking
// a brain IS the switch — local models on top, the borrowed cloud roster
// below (only when a key is saved). Choosing a cloud row is the explicit
// consent the toggle used to be: it says so in the section header, and the
// chip turns blue with a cloud mark so the app never lies about where words
// go. Choosing any local row turns borrowing off.
import { useEffect, useRef, useState } from "react";
import { localModels } from "../providers";
import { RECOMMENDED_MODELS, friendlyName } from "../providers/ollama";
import { CLOUD_MODELS, prewarm } from "../providers/featherless";
import type { ModelInfo } from "../providers/types";
import { getSettings, updateSettings } from "../storage/settings";

export function BrainPicker({
  label,
  onChanged,
}: {
  label: string; // the local label ChatTab already resolves (friendly name)
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState<ModelInfo[]>([]);
  const popRef = useRef<HTMLDivElement>(null);

  const f = getSettings().featherless;
  const cloudOn = f.enabled && !!f.key;
  const localChoice = getSettings().localModel ?? "";

  useEffect(() => {
    if (!open) return;
    localModels(true)
      .then(setInstalled)
      .catch(() => setInstalled([]));
  }, [open]);

  // Click-away closes; Escape too.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  async function pickLocal(tag: string) {
    await updateSettings((s) => {
      s.localModel = tag || null;
      s.featherless.enabled = false;
    });
    setOpen(false);
    onChanged();
  }

  async function pickCloud(id: string) {
    await updateSettings((s) => {
      s.featherless.model = id;
      s.featherless.enabled = true;
    });
    setOpen(false);
    onChanged();
    void prewarm(id); // cold cloud models add seconds — warm on switch
  }

  const installedTags = new Set(installed.map((m) => m.id));
  const localRows: { tag: string; title: string; sub: string }[] = [
    { tag: "", title: "Automatic", sub: "Picks the best you have installed." },
    ...RECOMMENDED_MODELS.filter((r) => installedTags.has(r.tag)).map((r) => ({
      tag: r.tag,
      title: `${r.name} · ${r.role}`,
      sub: r.blurb,
    })),
  ];

  const chipLabel = cloudOn
    ? `☁ ${f.model.split("/").pop()}`
    : label;

  return (
    <div style={{ position: "relative" }} ref={popRef}>
      <button
        className={`chip ${cloudOn ? "chip-blue" : "chip-gray"}`}
        style={{ cursor: "pointer" }}
        onClick={() => setOpen((o) => !o)}
        title="Pick which brain answers — local, or borrowed cloud"
        data-testid="brain-picker"
      >
        {chipLabel} ▾
      </button>
      {open && (
        <div className="brain-pop" data-testid="brain-pop">
          <div className="brain-sec">On this computer — private, free</div>
          {localRows.map((r) => (
            <button
              key={r.tag || "auto"}
              className="brain-row"
              onClick={() => void pickLocal(r.tag)}
              data-testid={`brain-local-${r.tag || "auto"}`}
            >
              <span className="brain-dot">
                {!cloudOn && localChoice === r.tag ? "●" : ""}
              </span>
              <span>
                <span className="brain-title">{r.title}</span>
                <span className="brain-sub">{r.sub}</span>
              </span>
            </button>
          ))}
          {f.key ? (
            <>
              <div className="brain-sec">
                Borrowed — Featherless · leaves your computer · billed per call
              </div>
              {CLOUD_MODELS.map((m) => (
                <button
                  key={m.id}
                  className="brain-row"
                  onClick={() => void pickCloud(m.id)}
                  data-testid={`brain-cloud-${m.id}`}
                >
                  <span className="brain-dot">
                    {cloudOn && f.model === m.id ? "●" : ""}
                  </span>
                  <span>
                    <span className="brain-title">☁ {m.id.split("/").pop()}</span>
                    <span className="brain-sub">{m.role}</span>
                  </span>
                </button>
              ))}
            </>
          ) : (
            <div className="brain-sec">
              Borrowed cloud — paste a Featherless key in Settings to unlock.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Re-exported so ChatTab's label refresh can also friendly-name local tags.
export { friendlyName };
