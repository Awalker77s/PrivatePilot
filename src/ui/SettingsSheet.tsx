import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { XIcon } from "./icons";
import { runStorageSelfTest, SelfTestResult } from "../storage/selftest";
import { useStore } from "../storage/useStore";
import {
  DoctorReport,
  RECOMMENDED_MODELS,
  friendlyName,
  runModelDoctor,
} from "../providers/ollama";
import { localModels, NUM_CTX_DRAFT, ollama } from "../providers";
import type { ModelInfo } from "../providers/types";
import {
  CLOUD_MODELS,
  onCloudMeter,
  prewarm,
  verifyKey,
} from "../providers/featherless";
import { getSettings, updateSettings } from "../storage/settings";
import { ensureParakeet, parakeetReady } from "../watchme/transcribe";
import { ConnectedAppsCard, HeavyTasksCard } from "./ConnectedAppsCard";
import {
  permissionCounts,
  revokeAllRevisionApprovals,
  revokeRevision,
  revokeWorkflowRevision,
  setFullAccess,
} from "../storage/permissions";
import type { AutomationRecord, ChainRecord } from "../storage/types";

export function SettingsSheet({ close }: { close: () => void }) {
  const { loadError, automations, chains } = useStore();
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
          <ModelChooser
            installed={localChoices}
            active={doctor?.installedTag ?? null}
            choice={localChoice}
            onChoose={async (value) => {
              setLocalChoice(value);
              await updateSettings((settings) => {
                settings.localModel = value || null;
              });
              setDoctor(await runModelDoctor());
            }}
          />
          {wakeLine && (
            <div className="caption" data-testid="wake-line">
              {wakeLine}
            </div>
          )}
        </div>

        <ConnectedAppsCard />

        <HeavyTasksCard />

        <ListeningCard />

        <BorrowCloudCard />

        <PermissionsCard
          records={automations.records}
          workflows={chains.records}
        />

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

// The brain picker: role cards from the bench (Fast default, Careful for
// screen-reading), each installed one selectable, plus an Automatic option.
// A recommended model that isn't downloaded shows how to get it — the app
// never pulls a multi-GB model behind the person's back.
function ModelChooser({
  installed,
  active,
  choice,
  onChoose,
}: {
  installed: ModelInfo[];
  active: string | null;
  choice: string;
  onChoose: (value: string) => void | Promise<void>;
}) {
  const installedTags = new Set(installed.map((m) => m.id));
  // Recommended first (in role order), then any other installed CHAT models
  // (embedding models like nomic-embed can't draft — never offer them).
  const known = new Set(RECOMMENDED_MODELS.map((r) => r.tag));
  const extras = installed.filter(
    (m) => !known.has(m.id) && !/embed/i.test(m.id)
  );
  if (installed.length === 0) return null;

  const Row = ({
    value,
    title,
    sub,
    disabled,
    tail,
  }: {
    value: string;
    title: string;
    sub: string;
    disabled?: boolean;
    tail?: string;
  }) => {
    const selected = !disabled && choice === value;
    const isActive = !disabled && active === value && (choice === value || (choice === "" && value === active));
    return (
      <button
        className="model-row"
        data-testid={`model-${value || "auto"}`}
        disabled={disabled}
        onClick={() => !disabled && void onChoose(value)}
        style={{
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          width: "100%",
          textAlign: "left",
          padding: "8px 10px",
          borderRadius: 8,
          border: `1px solid ${selected ? "var(--accent, #4a8)" : "var(--line)"}`,
          background: selected ? "var(--accent-weak, rgba(74,136,136,0.12))" : "transparent",
          color: disabled ? "var(--muted)" : "var(--text)",
          cursor: disabled ? "default" : "pointer",
          marginTop: 6,
        }}
      >
        <span style={{ marginTop: 2, width: 14, flexShrink: 0, color: "var(--accent, #4a8)" }}>
          {selected ? "●" : "○"}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>
            {title}
            {isActive && <span className="caption" style={{ marginLeft: 6, color: "var(--green)" }}>· in use</span>}
            {tail && <span className="caption" style={{ marginLeft: 6 }}>{tail}</span>}
          </span>
          <span className="caption" style={{ display: "block" }}>{sub}</span>
        </span>
      </button>
    );
  };

  return (
    <div style={{ marginTop: 6 }} data-testid="model-chooser">
      <Row
        value=""
        title="Automatic"
        sub={`Picks the best you have — right now ${active ? friendlyName(active) : "none installed"}.`}
      />
      {RECOMMENDED_MODELS.map((r) =>
        installedTags.has(r.tag) ? (
          <Row
            key={r.tag}
            value={r.tag}
            title={`${r.name} · ${r.role}`}
            sub={r.blurb}
          />
        ) : (
          <Row
            key={r.tag}
            value={r.tag}
            title={`${r.name} · ${r.role}`}
            sub={`Not downloaded. Get it with:  ollama pull ${r.tag}  (${r.downloadGB} GB)`}
            disabled
          />
        )
      )}
      {extras.map((m) => (
        <Row key={m.id} value={m.id} title={friendlyName(m.id)} sub="Also installed on this computer." />
      ))}
    </div>
  );
}

function PermissionsCard({
  records,
  workflows,
}: {
  records: AutomationRecord[];
  workflows: ChainRecord[];
}) {
  const [, refresh] = useState(0);
  const counts = permissionCounts();
  const settings = getSettings().permissions;
  const approved = records.filter((record) => {
    const revision = record.revision;
    return !!revision && !!settings?.approvedRevisions[revision.id];
  });
  const approvedWorkflows = workflows.filter((workflow) => {
    const revision = workflow.revision;
    return !!revision && !!settings?.approvedWorkflowRevisions?.[revision.id];
  });

  return (
    <div className="settings-card" data-testid="permission-settings">
      <div className="settings-card-title">
        Permissions
        <span className={`chip ${counts.fullAccess ? "chip-red" : "chip-gray"}`}>
          {counts.fullAccess ? "Full access" : "Ask as needed"}
        </span>
      </div>
      <div className="caption">
        Approvals are pinned to an exact automation revision. Changing what it
        touches makes it ask again.
      </div>
      <button
        className={`btn btn-sm ${counts.fullAccess ? "btn-danger" : "btn-ghost"}`}
        onClick={async () => {
          if (
            !counts.fullAccess &&
            !window.confirm(
              "Full access lets approved future terminal and app actions run without per-revision prompts. Enable it?"
            )
          )
            return;
          await setFullAccess(!counts.fullAccess);
          refresh((value) => value + 1);
        }}
      >
        {counts.fullAccess ? "Turn off full access" : "Enable full access…"}
      </button>
      {counts.fullAccess && (
        <div className="status-line" style={{ color: "var(--red)" }}>
          Advanced: future app and terminal actions will not ask per revision.
        </div>
      )}
      <div className="permission-ledger">
        <div className="caption">
          {counts.revisions} approved revision{counts.revisions === 1 ? "" : "s"} · {getSettings().pickedFolders.length} picked folder{getSettings().pickedFolders.length === 1 ? "" : "s"}
        </div>
        {approved.map((record) => (
          <div className="permission-ledger-row" key={record.id}>
            <span>{record.name} · v{record.revision?.number}</span>
            <button
              className="btn btn-sm btn-ghost"
              onClick={async () => {
                await revokeRevision(record);
                refresh((value) => value + 1);
              }}
            >
              Revoke
            </button>
          </div>
        ))}
        {approvedWorkflows.map((workflow) => (
          <div className="permission-ledger-row" key={workflow.id}>
            <span>{workflow.name} · sequence v{workflow.revision?.number}</span>
            <button
              className="btn btn-sm btn-ghost"
              onClick={async () => {
                await revokeWorkflowRevision(workflow);
                refresh((value) => value + 1);
              }}
            >
              Revoke
            </button>
          </div>
        ))}
        {getSettings().pickedFolders.map((folder) => (
          <div className="permission-ledger-row" key={folder}>
            <span title={folder}>{folder.split(/[\\/]/).filter(Boolean).pop() ?? folder}</span>
            <button
              className="btn btn-sm btn-ghost"
              onClick={async () => {
                await updateSettings((appSettings) => {
                  appSettings.pickedFolders = appSettings.pickedFolders.filter(
                    (candidate) => candidate !== folder
                  );
                  if (appSettings.permissions) {
                    appSettings.permissions.approvedDirectories =
                      appSettings.permissions.approvedDirectories.filter(
                        (candidate) => candidate !== folder
                      );
                  }
                });
                refresh((value) => value + 1);
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          className="btn btn-sm btn-ghost"
          onClick={async () => {
            const picked = await openDialog({ directory: true, multiple: false });
            if (!picked || typeof picked !== "string") return;
            await invoke("allow_folder", { path: picked });
            await updateSettings((appSettings) => {
              if (!appSettings.pickedFolders.includes(picked))
                appSettings.pickedFolders.push(picked);
              appSettings.permissions ??= {
                fullAccess: false,
                approvedRevisions: {},
                approvedWorkflowRevisions: {},
                approvedDirectories: [],
              };
              if (!appSettings.permissions.approvedDirectories.includes(picked))
                appSettings.permissions.approvedDirectories.push(picked);
            });
            refresh((value) => value + 1);
          }}
        >
          Add approved folder…
        </button>
        {counts.revisions > 0 && (
          <button
            className="btn btn-sm btn-ghost"
            onClick={async () => {
              await revokeAllRevisionApprovals();
              refresh((value) => value + 1);
            }}
          >
            Revoke all automation approvals
          </button>
        )}
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
  // The key's last-checked truth: null = never checked, "checking", or the
  // verdict. A dead key looked identical to a good one before — the person
  // pasted a key, a run 401'd a day later, and the card never said a word.
  const [keyState, setKeyState] = useState<
    { kind: "checking" | "good" | "bad"; line: string } | null
  >(null);
  const [meter, setMeter] = useState(0);

  useEffect(() => onCloudMeter(setMeter), []);
  useEffect(() => {
    // On open with a stored key: re-verify quietly so the card is honest
    // about TODAY, not about the day the key was pasted.
    if (f.key) {
      setKeyState({ kind: "checking", line: "Checking the saved key…" });
      verifyKey(f.key, getSettings().featherless.model).then((v) =>
        setKeyState({ kind: v.ok ? "good" : "bad", line: v.line })
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (!key) {
      setKeyState(null);
      return;
    }
    // Verify with a REAL test call, not just the plan endpoint — and say so.
    setKeyState({ kind: "checking", line: "Checking the key with a real test call…" });
    const v = await verifyKey(key, getSettings().featherless.model);
    setKeyState({ kind: v.ok ? "good" : "bad", line: v.line });
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
      {keyState && (
        <div
          className="status-line"
          data-testid="cloud-key-state"
          style={{
            color:
              keyState.kind === "good"
                ? "var(--green)"
                : keyState.kind === "bad"
                  ? "var(--red)"
                  : "var(--text-dim)",
          }}
        >
          {keyState.line}
        </div>
      )}
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
