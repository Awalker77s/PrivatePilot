import { useEffect, useState } from "react";
import { XIcon } from "./icons";
import { runStorageSelfTest, SelfTestResult } from "../storage/selftest";
import { useStore } from "../storage/useStore";
import { DoctorReport, runModelDoctor } from "../providers/ollama";
import { localModels, NUM_CTX_DRAFT, ollama } from "../providers";
import type { ModelInfo } from "../providers/types";
import {
  CLOUD_MODELS,
  fetchPlan,
  onCloudMeter,
  prewarm,
} from "../providers/featherless";
import { getSettings, updateSettings } from "../storage/settings";
import { ensureParakeet, parakeetReady } from "../watchme/transcribe";

export function SettingsSheet({ close }: { close: () => void }) {
  const { loadError } = useStore();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SelfTestResult | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [localChoices, setLocalChoices] = useState<ModelInfo[]>([]);
  const [localChoice, setLocalChoice] = useState(
    getSettings().localModel ?? ""
  );
  const [waking, setWaking] = useState(false);
  const [wakeLine, setWakeLine] = useState<string | null>(null);

  useEffect(() => {
    runModelDoctor().then(setDoctor);
    localModels(true).then(setLocalChoices);
  }, []);

  async function wake() {
    if (!doctor?.installedTag) return;
    setWaking(true);
    setWakeLine(null);
    try {
      // A real LOCAL chat round trip — explicit num_ctx like every call.
      const res = await ollama.chat({
        model: doctor.installedTag,
        messages: [
          { role: "user", content: "Answer with the single word: ready" },
        ],
        options: {
          num_ctx: NUM_CTX_DRAFT,
          max_tokens: 8,
          temperature: 0,
          seed: 7,
        },
        think: false,
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
          {localChoices.length > 1 && (
            <>
              <select
                className="run-search"
                style={{ width: "100%" }}
                value={localChoice}
                onChange={async (e) => {
                  const value = e.target.value;
                  setLocalChoice(value);
                  await updateSettings((settings) => {
                    settings.localModel = value || null;
                  });
                  setDoctor(await runModelDoctor());
                }}
                data-testid="local-model"
              >
                <option value="">Automatic — prefer Qwen 9B</option>
                {localChoices.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
              <div className="caption">
                Qwen 4B is faster on CPU-only computers; Qwen 9B usually makes
                stronger drafts.
              </div>
            </>
          )}
          {wakeLine && (
            <div className="caption" data-testid="wake-line">
              {wakeLine}
            </div>
          )}
        </div>

        <ListeningCard />

        <BorrowCloudCard />

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

// The listening engine behind the mic and Watch me — all local. Parakeet
// (NVIDIA, CC-BY-4.0) halves the word errors of the starter model.
function ListeningCard() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [line, setLine] = useState<string | null>(null);

  useEffect(() => {
    parakeetReady().then(setReady);
  }, []);

  async function download() {
    setDownloading(true);
    setLine("Downloading — 638 MB, one time…");
    try {
      await ensureParakeet(() => {});
      setReady(true);
      setLine(null);
    } catch (e) {
      setLine(
        e instanceof Error ? e.message : "The download broke — try again."
      );
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="settings-card" data-testid="listening-card">
      <div className="settings-card-title">
        Listening
        {ready === false && (
          <button
            className="btn btn-sm"
            onClick={download}
            disabled={downloading}
          >
            {downloading ? "Downloading…" : "Upgrade it"}
          </button>
        )}
      </div>
      <div className="status-line">
        {ready === null
          ? "Checking…"
          : ready
            ? "High-accuracy listening — NVIDIA Parakeet, on this computer."
            : "Starter listening — Whisper base, on this computer."}
      </div>
      <div className="caption">
        {ready
          ? "Speech recognition: NVIDIA Parakeet TDT 0.6b v3 (CC-BY-4.0) via whisper.cpp."
          : "The upgrade halves listening mistakes (638 MB download, still fully local)."}
      </div>
      {line && <div className="caption">{line}</div>}
    </div>
  );
}

// "Borrow cloud compute (Featherless) — this leaves your computer."
// Default OFF; the moment it's on, every runs-on line in the app changes.
function BorrowCloudCard() {
  const [, force] = useState(0);
  const f = getSettings().featherless;
  const [keyDraft, setKeyDraft] = useState(f.key ?? "");
  const [planLine, setPlanLine] = useState<string | null>(null);
  const [meter, setMeter] = useState(0);

  useEffect(() => onCloudMeter(setMeter), []);
  useEffect(() => {
    if (f.key) fetchPlan(f.key).then((p) => setPlanLine(p.line));
  }, [f.key]);

  async function toggle() {
    if (!f.enabled && !f.key) return;
    await updateSettings((s) => {
      s.featherless.enabled = !s.featherless.enabled;
    });
    force((n) => n + 1);
    if (getSettings().featherless.enabled) {
      // warming up the borrowed computer — cold models add seconds
      void prewarm(getSettings().featherless.model);
    }
  }

  async function saveKey() {
    await updateSettings((s) => {
      s.featherless.key = keyDraft.trim() || null;
      if (!s.featherless.key) s.featherless.enabled = false;
    });
    force((n) => n + 1);
    const key = getSettings().featherless.key;
    if (key) setPlanLine((await fetchPlan(key)).line);
  }

  return (
    <div className="settings-card" data-testid="borrow-cloud">
      <div className="settings-card-title">
        Borrow cloud compute (Featherless)
        <button
          className={`chip ${f.enabled ? "chip-blue" : "chip-gray"}`}
          onClick={toggle}
          disabled={!f.key}
          title={f.key ? undefined : "Paste a key first"}
          data-testid="cloud-toggle"
          style={{ cursor: f.key ? "pointer" : "default" }}
        >
          {f.enabled ? "On — borrowing" : "Off"}
        </button>
      </div>
      <div className="status-line">— this leaves your computer.</div>
      <div className="caption">
        Featherless's FAQ, verbatim: "We do not log any of the prompts or
        completions sent to our API."
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="run-search"
          style={{ flex: 1, width: "auto" }}
          type="password"
          placeholder="Featherless API key (stays on this computer)"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          data-testid="cloud-key"
        />
        <button className="btn btn-sm" onClick={saveKey}>
          Save key
        </button>
      </div>
      {planLine && <div className="caption">Your plan: {planLine}</div>}
      <select
        className="run-search"
        style={{ width: "100%" }}
        value={f.model}
        onChange={async (e) => {
          await updateSettings((s) => {
            s.featherless.model = e.target.value;
          });
          force((n) => n + 1);
        }}
      >
        {CLOUD_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id} — {m.role}
          </option>
        ))}
      </select>
      {f.enabled && (
        <div className="status-line" data-testid="cloud-meter">
          <span className={`dot ${meter > 0 ? "dot-green" : "dot-gray"}`} />
          {meter > 0
            ? `borrowed compute in use — ${meter} call in flight`
            : "idle — nothing borrowed right now"}
        </div>
      )}
    </div>
  );
}
