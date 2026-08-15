import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TabId } from "../App";
import { MicIcon, ArrowRightIcon } from "../icons";
import { activeModelLabel } from "../../providers";
import { BrainPicker } from "../BrainPicker";
import { loadSettings } from "../../storage/settings";
import {
  ChatItem,
  chatBusy,
  chatItems,
  chatVersion,
  chooseFile,
  clearGeneralChat,
  compileFromDemo,
  compileFromTypedDemo,
  hasNarration,
  consumeComposerSeed,
  discardBuilt,
  discardWatchMe,
  dropWatchFrame,
  keepBuilt,
  keepEdit,
  notNowBuilt,
  pickOption,
  pinDemoValue,
  putBackBuilt,
  revertEdit,
  saveBuilt,
  sendText,
  startWatchMe,
  stopWatchMe,
  subscribeChat,
  toggleDiffEntry,
  tryOnce,
} from "../chatStore";
import { getRun } from "../../storage/stores";
import { useStoreVersion } from "../../storage/useStore";
import { DiffCard } from "../DiffCard";
import { SendDraftButton } from "../RunDetail";
import {
  DictationHandle,
  cancelDictation,
  dictationState,
  startDictation,
  stopDictation,
  subscribeDictation,
} from "../../watchme/dictation";
import { isWatching } from "../chatStore";
import {
  activeStudioAutomationId,
  addAutomationReference,
  closeAutomationStudio,
  composerReferences,
  openAutomationStudio,
  removeAutomationReference,
} from "../chatStore";
import { getState } from "../../storage/stores";
import { normalizeAutomation, permissionSummary } from "../../storage/revisions";
import { CategoryGlyph } from "../glyphs";
import { AUTOMATION_DRAG_TYPE, LibraryPanel } from "../LibraryPanel";
import { FormattedAnswer } from "../FormattedAnswer";

const GENERAL_CHAT_STARTERS = [
  "Show me today's top 10 tech headlines",
  "Check Bitcoin and Tesla prices",
  "Is Discord down?",
];

function DictationTimer({ startedAt }: { startedAt: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((Date.now() - startedAt) / 1000);
  return (
    <span className="caption">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

export function ChatTab(_props: { goTo: (t: TabId) => void }) {
  useSyncExternalStore(subscribeChat, chatVersion);
  useStoreVersion();
  const [draft, setDraft] = useState("");
  const [clearArmed, setClearArmed] = useState(false);
  const [modelLabel, setModelLabel] = useState("…");
  const [dict, setDict] = useState<DictationHandle>({
    state: "idle",
    level: 0,
    startedAt: 0,
    hint: null,
    error: null,
  });
  const threadRef = useRef<HTMLDivElement>(null);
  const micHeldAt = useRef(0);
  const items = chatItems();
  const busy = chatBusy();
  const watching = isWatching();
  const references = composerReferences();
  const studioId = activeStudioAutomationId();
  const studioRecord = studioId
    ? getState().automations.records.find((record) => record.id === studioId)
    : null;
  const studio = studioRecord ? normalizeAutomation(studioRecord) : null;

  useEffect(() => subscribeDictation(setDict), []);

  async function toggleDictation() {
    if (dictationState().state === "listening") {
      const text = await stopDictation();
      if (text) {
        setDraft((d) => (d.trim() ? `${d.trim()} ${text}` : text));
      }
    } else if (dictationState().state === "idle") {
      await startDictation();
    }
  }

  useEffect(() => {
    loadSettings()
      .then(() => activeModelLabel())
      .then(setModelLabel)
      .catch(() => setModelLabel("Ollama off"));
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [items.length]);

  useEffect(() => {
    setClearArmed(false);
  }, [studioId]);

  // A sheet's Change link may have seeded the composer.
  const seed = consumeComposerSeed();
  useEffect(() => {
    if (seed) setDraft(seed);
  }, [seed]);

  async function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    await sendText(text);
  }

  return (
    <div
      className="chat-workspace"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(AUTOMATION_DRAG_TYPE)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => {
        const automationId = event.dataTransfer.getData(AUTOMATION_DRAG_TYPE);
        if (automationId) {
          event.preventDefault();
          addAutomationReference(automationId);
        }
      }}
    >
      <div className="chat-column">
        {studio && (
          <div className="studio-header card" data-testid="studio-header">
            <CategoryGlyph category={studio.category} size={26} />
            <div className="studio-heading-copy">
              <div className="library-item-name">{studio.name}</div>
              <div className="caption">
                Automation Studio · revision {studio.revision!.number} · {permissionSummary(studio)}
              </div>
            </div>
            <button className="btn btn-sm btn-ghost" onClick={closeAutomationStudio}>
              General chat
            </button>
          </div>
        )}
        <div className="chat">
          {!studio && (
            <div className="chat-toolbar">
              <div className="chat-toolbar-copy">
                <div className="chat-toolbar-title">General chat</div>
                <div className="caption">Live answers and new automations</div>
              </div>
              {clearArmed ? (
                <div className="chat-clear-confirm" role="group" aria-label="Confirm clear chat">
                  <span className="caption">Clear messages and unsaved cards?</span>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => {
                      clearGeneralChat();
                      setDraft("");
                      setClearArmed(false);
                    }}
                    data-testid="confirm-clear-chat"
                  >
                    Clear
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setClearArmed(false)}
                    data-testid="cancel-clear-chat"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="btn btn-ghost btn-sm chat-clear"
                  disabled={items.length === 0 || busy || watching}
                  title="Remove this conversation. Saved automations and Activity stay."
                  onClick={() => setClearArmed(true)}
                  data-testid="clear-chat"
                >
                  Clear chat
                </button>
              )}
            </div>
          )}
          <div className="chat-thread" ref={threadRef} data-testid="chat-thread">
            {items.map((item) => (
              <ChatItemView key={item.id} item={item} />
            ))}
            {items.length === 0 && !studio && (
              <div className="chat-welcome" data-testid="chat-welcome">
                <span className="brand-glyph chat-welcome-glyph">P</span>
                <div className="empty-status">What would you like to automate?</div>
                <div className="empty-what">
                  Ask for a live answer, a schedule, or something to watch.
                </div>
                <div className="chat-starters" aria-label="Example requests">
                  {GENERAL_CHAT_STARTERS.map((starter) => (
                    <button
                      key={starter}
                      className="chat-starter"
                      onClick={() => setDraft(starter)}
                    >
                      {starter}
                      <ArrowRightIcon size={12} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {items.length === 0 && studio && (
              <div className="studio-empty">
                <div className="empty-status">Perfect this automation</div>
                <div className="empty-what">
                  Every message in this Studio edits {studio.name}. Test and reprompt as many times as you need.
                </div>
              </div>
            )}
          </div>
          <div className="composer card">
            {references.length > 0 && (
              <div className="composer-references" data-testid="composer-references">
                {references.map((reference) => (
                  <button
                    key={reference.automationId}
                    className="reference-chip"
                    title="Remove reference"
                    onClick={() => removeAutomationReference(reference.automationId)}
                  >
                    @{reference.name} <span>×</span>
                  </button>
                ))}
              </div>
            )}
        <textarea
          className="composer-input"
          rows={1}
          placeholder="Ask, or describe a job you want doing…"
          value={draft}
          data-testid="composer-input"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-row">
          <div className="composer-left">
            {/* Watch me: a labeled SESSION control, nothing like the mic. */}
            <button
              className={`btn btn-sm ${watching ? "mic-live" : "btn-ghost"}`}
              title={
                watching
                  ? "Stop watching"
                  : "Watch me — Do it once. It learns by watching. No video is kept."
              }
              onClick={() => (watching ? stopWatchMe() : startWatchMe())}
              data-testid="watch-me-start"
            >
              <span
                className={`dot dot-red${watching ? " rec-pulse" : ""}`}
                style={{ width: 8, height: 8 }}
              />
              &nbsp;{watching ? "Stop" : "Watch me"}
            </button>
            {dict.error && <span className="caption">{dict.error}</span>}
            {dict.hint && <span className="caption">{dict.hint}</span>}
          </div>
          <div className="composer-right">
            {dict.state === "listening" ? (
              /* The listening contract replaces the right rail in place:
                 waveform · elapsed · ✕ · ✓ — your words land in the box. */
              <>
                <span className="wave" data-testid="dictate-wave">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <span
                      key={i}
                      className="wave-bar"
                      style={{
                        height: `${3 + dict.level * 11 * ((i % 3) + 1)}px`,
                      }}
                    />
                  ))}
                </span>
                <DictationTimer startedAt={dict.startedAt} />
                <button
                  className="btn btn-sm btn-ghost"
                  title="Throw the audio away"
                  onClick={() => cancelDictation()}
                  data-testid="dictate-cancel"
                >
                  ✕
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  title="Done — put my words in the box"
                  onClick={toggleDictation}
                  data-testid="dictate-confirm"
                >
                  ✓
                </button>
              </>
            ) : (
              <>
                <BrainPicker
                  label={modelLabel}
                  onChanged={() =>
                    void activeModelLabel()
                      .then(setModelLabel)
                      .catch(() => setModelLabel("Ollama off"))
                  }
                />
                <button
                  className={`btn btn-sm btn-ghost${dict.state === "transcribing" ? " mic-busy" : ""}`}
                  title="Speak instead of typing — tap, or hold to talk"
                  onPointerDown={() => {
                    micHeldAt.current = Date.now();
                    if (dict.state === "idle") void startDictation();
                  }}
                  onPointerUp={() => {
                    // Hold >300ms = push-to-talk: release is the confirm.
                    if (
                      dict.state === "listening" &&
                      Date.now() - micHeldAt.current > 300
                    ) {
                      void toggleDictation();
                    }
                  }}
                  disabled={dict.state === "transcribing"}
                  data-testid="mic-dictate"
                >
                  {dict.state === "transcribing" ? (
                    <span
                      className="spinner"
                      style={{
                        width: 11,
                        height: 11,
                        borderTopColor: "var(--blue)",
                      }}
                    />
                  ) : (
                    <MicIcon size={13} />
                  )}
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busy || !draft.trim()}
                  onClick={submit}
                  data-testid="send"
                >
                  Send
                </button>
              </>
            )}
          </div>
        </div>
          </div>
        </div>
      </div>
      <LibraryPanel />
    </div>
  );
}

function ChatItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg-row user">
          <div className="msg-user">
            {item.references && item.references.length > 0 && (
              <div className="message-references">
                {item.references.map((reference) => (
                  <button
                    key={reference.automationId}
                    className="reference-chip"
                    onClick={() => openAutomationStudio(reference.automationId)}
                  >
                    @{reference.name}
                  </button>
                ))}
              </div>
            )}
            {item.text}
          </div>
        </div>
      );
    case "progress":
      return <ProgressCard item={item} />;
    case "question":
      return <QuestionCard item={item} />;
    case "built":
      return <BuiltCard item={item} />;
    case "edit":
      return <EditCard item={item} />;
    case "watchme":
      return <WatchMeCard item={item} />;
    case "note":
      return (
        <div className={`note-card note-${item.tone}`} data-testid="note">
          {item.text}
        </div>
      );
    case "explain":
      return (
        <div className="note-card note-gray" data-testid="explain">
          <div className="caption" style={{ marginBottom: 4 }}>
            About “{item.autoName}”
          </div>
          <FormattedAnswer text={item.text} />
        </div>
      );
    case "answer": {
      // The run's reply, as its own assistant bubble — rendered from the run
      // record so the thread never drifts from what actually ran.
      const answerRun = getRun(item.runId);
      if (!answerRun || !(answerRun.answer ?? "").trim()) return null;
      return (
        <div className="answer-bubble" data-testid="answer-bubble">
          <div className="answer-bubble-head">
            <span className="dot dot-green" />
            <span className="answer-bubble-name">Answer · {item.autoName}</span>
          </div>
          <FormattedAnswer text={answerRun.answer!} />
        </div>
      );
    }
  }
}

// Watch me: recording pill → consent strip → the same compile pipe.
// The frames-held counter is real, and deletion is a visible event.
function WatchMeCard({ item }: { item: ChatItem & { kind: "watchme" } }) {
  const [, tick] = useState(0);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (item.state !== "recording") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [item.state]);
  const elapsed = Math.floor((Date.now() - item.startedAt) / 1000);

  if (item.state === "recording") {
    return (
      <div className="built-card card" data-testid="watchme-recording">
        <div className="watchme-bar">
          <span className="dot dot-red rec-pulse" />
          <b>Watching</b>
          <span className="caption">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
          <span className="chip chip-gray" data-testid="frames-held">
            frames held: {item.framesHeld}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-primary btn-sm" onClick={() => stopWatchMe()}>
            Stop
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => discardWatchMe(item.id)}
          >
            Throw it away
          </button>
        </div>
        <div className="caption">
          Do the task and say what you're doing out loud. No video is kept —
          only these frames, and they're deleted the moment it compiles.
        </div>
        {item.reason && (
          <div className="status-line" style={{ color: "var(--amber)" }}>
            {item.reason}
          </div>
        )}
      </div>
    );
  }

  if (item.state === "review") {
    return (
      <div className="built-card card" data-testid="watchme-review">
        <div className="caption">
          Compile from these? Drop any frame you'd rather I never saw.
        </div>
        <div className="consent-strip" data-testid="consent-strip">
          {item.thumbs
            .filter((t) => !t.dropped)
            .map((t) => (
              <div key={t.tMs} className="consent-thumb">
                <img src={t.url} alt="" />
                <button
                  className="thumb-drop"
                  title="Drop this frame"
                  onClick={() => dropWatchFrame(item.id, t.tMs)}
                >
                  ✕
                </button>
              </div>
            ))}
          {item.framesHeld === 0 && (
            <span className="caption">No frames held.</span>
          )}
        </div>
        <div className="built-actions">
          <button
            className="btn btn-primary"
            onClick={() => compileFromDemo(item.id, false)}
            data-testid="compile-demo"
          >
            Compile from these
          </button>
          <button
            className="btn"
            onClick={() => compileFromDemo(item.id, true)}
          >
            Words only
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => discardWatchMe(item.id)}
          >
            Throw it away
          </button>
        </div>
        {!item.micOk && item.reason && (
          <div className="status-line" style={{ color: "var(--amber)" }}>
            {item.reason}
          </div>
        )}
      </div>
    );
  }

  if (item.state === "listening" || item.state === "reading") {
    return (
      <div className="pipeline-card card">
        <span className="spinner" />
        <span className="stage-text">
          {item.state === "listening"
            ? "Listening back…"
            : "Reading the frames…"}
        </span>
      </div>
    );
  }

  // failed: the session survives — retry listening, or type what you did;
  // never lose an expensive recording to a processing error.
  return (
    <div className="built-card card" data-testid="watchme-failed">
      <div className="status-line" style={{ color: "var(--amber)" }}>
        {item.reason}
      </div>
      {hasNarration(item.id) && (
        <button
          className="btn btn-sm"
          onClick={() => compileFromDemo(item.id, false)}
          data-testid="retry-listen"
        >
          Listen again
        </button>
      )}
      <textarea
        className="composer-input"
        style={{
          background: "var(--nested)",
          borderRadius: 8,
          padding: "8px 10px",
        }}
        rows={2}
        placeholder="What did you do? e.g. I checked the Solana price on CoinGecko…"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />
      <div className="built-actions">
        <button
          className="btn btn-primary btn-sm"
          disabled={!typed.trim()}
          onClick={() => compileFromTypedDemo(item.id, typed)}
        >
          Compile it
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => discardWatchMe(item.id)}
        >
          Throw it away
        </button>
      </div>
    </div>
  );
}

// The before→after card: field-level diffs against the current version,
// Keep it / Put it back.
function EditCard({ item }: { item: ChatItem & { kind: "edit" } }) {
  const { result, state } = item;
  return (
    <div className="built-card card" data-testid="edit-card">
      <div className="caption">Changing "{result.before.name}":</div>
      {result.changed.map((c) => (
        <div key={c.key} className="edit-row">
          <span className="sheet-row-label">{c.key === "schedule" ? "When" : c.key}</span>
          <span className="edit-from">{c.from}</span>
          <span className="edit-arrow">→</span>
          <span className="edit-to">{c.to}</span>
        </div>
      ))}
      {state === "fresh" && (
        <div className="built-actions">
          <button
            className="btn btn-primary"
            onClick={() => keepEdit(item.id)}
            data-testid="keep-edit"
          >
            Keep it
          </button>
          <button className="btn btn-ghost" data-testid="drop-edit">
            Put it back
          </button>
        </div>
      )}
      {state === "kept" && (
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => revertEdit(item.id)}
          data-testid="revert-edit"
        >
          Put it back the way it was ›
        </button>
      )}
      {state === "reverted" && <div className="caption">Put back.</div>}
    </div>
  );
}

function ProgressCard({
  item,
}: {
  item: ChatItem & { kind: "progress" };
}) {
  // Feedback limits: 1–10s the stage name as live text; over 10s a counting-up
  // elapsed timer plus work-done text. Spinner, not skeletons.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.floor((Date.now() - item.startedAt) / 1000);
  return (
    <div className="pipeline-card card" data-testid="progress">
      <span className="spinner" />
      <span className="stage-text">{item.text}</span>
      {elapsed > 10 && <span className="caption">{elapsed}s</span>}
    </div>
  );
}

function QuestionCard({
  item,
}: {
  item: ChatItem & { kind: "question" };
}) {
  return (
    <div className="q-card card" data-testid="question-card">
      <div className="q-asking">{item.q.asking}</div>
      <div className="q-options">
        {item.q.options.map((o) => (
          <button
            key={o.value}
            className="btn btn-sm"
            disabled={item.answered !== null}
            onClick={() => pickOption(item.id, o.value)}
          >
            {o.label}
          </button>
        ))}
        {(item.q.kind === "file" || item.q.kind === "folder") && (
          <button
            className="btn btn-sm btn-ghost"
            disabled={item.answered !== null}
            onClick={() => chooseFile(item.id)}
          >
            Choose…
          </button>
        )}
      </div>
      {item.answered && (
        <div className="caption">You picked: {item.answered}</div>
      )}
    </div>
  );
}

function BuiltCard({ item }: { item: ChatItem & { kind: "built" } }) {
  useStoreVersion();
  const { result, state } = item;
  const discarded = state === "discarded";
  const singleAuto = result.automations.length === 1;
  const stepRunIds = item.chainRunIds ?? (item.runId ? [item.runId] : []);
  const stepRuns = stepRunIds
    .map((id) => getRun(id))
    .filter((r): r is NonNullable<typeof r> => !!r);
  // Fill-ins: declared inputs are asked at run time, example shown.
  const askInputs =
    singleAuto && result.automations[0].inputs.length > 0 && !result.chain;
  const [inputValues, setInputValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      result.automations[0]?.inputs.map((i) => [i.name, ""]) ?? []
    )
  );
  return (
    <div
      className={`built-card card${discarded ? " discarded" : ""}`}
      data-testid="built-card"
    >
      <div className="caption">
        {result.automations.length === 1
          ? "Built it — one automation:"
          : `Built it — ${result.automations.length === 2 ? "two" : result.automations.length} automations, ${result.chain?.steps?.length ? "routed on results" : result.chain ? "one hand-off" : "no hand-off"}. Same sheet you'll see on their tiles:`}
      </div>
      {result.automations.map((a, i) => (
        <div key={a.id} className="built-auto">
          <div className="built-name">{a.name}</div>
          <div className="built-sentence">{a.sentence}</div>
          {result.chain &&
            result.chain.links.map((l) =>
              l.from === a.id ? (
                <div key={l.to} className="handoff">
                  <ArrowRightIcon size={12} /> Then run{" "}
                  <b>
                    {result.automations.find((x) => x.id === l.to)?.name ?? l.to}
                  </b>{" "}
                  with {Object.keys(l.map).join(", ") || "nothing"}
                  {l.onlyWhen
                    ? ` — only when ${l.onlyWhen.field} ${l.onlyWhen.op.replace(/_/g, " ")} ${l.onlyWhen.value ?? ""}`
                    : ""}
                </div>
              ) : null
            )}
          {result.chain?.steps?.length
            ? (() => {
                const steps = result.chain!.steps!;
                const mine = steps.find((s) => s.automationId === a.id);
                if (!mine) return null;
                return steps
                  .filter((s) => s.after.includes(mine.id))
                  .map((s) => (
                    <div key={s.id} className="handoff">
                      <ArrowRightIcon size={12} /> Then run{" "}
                      <b>
                        {result.automations.find((x) => x.id === s.automationId)
                          ?.name ?? s.automationId}
                      </b>
                      {s.when === "broke"
                        ? " if this one breaks"
                        : s.when === "failed"
                          ? " if this one doesn't work"
                          : s.when === "held"
                            ? " if this one is held back"
                            : s.when === "always"
                              ? " either way"
                              : ""}
                      {s.ifAnswerContains
                        ? ` — when the result mentions “${s.ifAnswerContains}”`
                        : ""}
                      {s.ifAnswerLacks
                        ? ` — when the result doesn't mention “${s.ifAnswerLacks}”`
                        : ""}
                      {s.after.length > 1
                        ? s.needs === "any"
                          ? " (after whichever comes through)"
                          : " (after all of its steps)"
                        : ""}
                    </div>
                  ));
              })()
            : null}
          {i < result.automations.length - 1 && <div className="built-sep" />}
        </div>
      ))}
      {result.keptToOneStep && (
        <div className="caption">Kept this to one step — that's all it needs.</div>
      )}
      {result.automations[0]?.origin?.kind === "watched" && (
        <>
          <div className="caption" data-testid="provenance">
            Compiled from your recording —{" "}
            {result.automations[0].origin.frames
              ? `${result.automations[0].origin.frames} frame${result.automations[0].origin.frames === 1 ? "" : "s"} + your words.`
              : "your words alone."}{" "}
            Frames deleted.
          </div>
          {result.automations.some((a) => a.inputs.length > 0) &&
            state !== "saved" && (
              <div className="param-strip" data-testid="param-strip">
                {result.automations.flatMap((a) =>
                  a.inputs.map((inp) => (
                    <span key={a.id + inp.name} className="param-chip">
                      <span className="caption">{inp.label}</span>
                      <b>"{inp.example}"</b>
                      <button
                        className="btn btn-sm btn-ghost"
                        title="It will ask you each time (keeps the blank)"
                        disabled
                      >
                        Asks each time
                      </button>
                      <button
                        className="btn btn-sm"
                        title="Always use the demonstrated value"
                        onClick={() => pinDemoValue(item.id, a.id, inp.name)}
                      >
                        Always this
                      </button>
                    </span>
                  ))
                )}
              </div>
            )}
        </>
      )}
      <div className="argument">
        {result.argument.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
      {state === "running" && item.progress && (
        <div className="pipeline-card" style={{ border: "none", padding: "4px 0" }}>
          <span className="spinner" />
          <span className="stage-text" data-testid="run-progress">
            {item.progress}
          </span>
        </div>
      )}

      {stepRuns.length > 0 && state !== "running" && (
        <div className="run-result" data-testid="run-result">
          {stepRuns.map((run, i) => {
            const auto = result.automations.find(
              (a) => a.id === run.automationId
            );
            return (
              <div key={run.id} className="step-result">
                {run.status === "broke" ? (
                  <div className="run-answer" style={{ color: "var(--red)" }}>
                    <span className="dot dot-red" />
                    <FormattedAnswer
                      compact
                      text={`${auto ? `${auto.name} — ` : ""}${run.summary ?? "This run broke."}`}
                    />
                  </div>
                ) : run.status === "held" ? (
                  <div className="run-answer" style={{ color: "var(--muted)" }}>
                    <span className="dot dot-gray" />
                    <FormattedAnswer
                      compact
                      text={`${auto ? `${auto.name} — ` : ""}${run.summary ?? "Held back."}`}
                    />
                  </div>
                ) : run.status === "needs_you" && !run.diff ? (
                  // An app needs the person (allow / connect) — amber, not
                  // a green answer.
                  <div className="run-answer" style={{ color: "var(--amber)" }}>
                    <span className="dot dot-amber" />
                    {auto ? `${auto.name} — ` : ""}
                    {run.summary}
                  </div>
                ) : chatItems().some(
                    (x) => x.kind === "answer" && x.runId === run.id
                  ) ? (
                  // The answer lives in its own bubble below — the card keeps
                  // a one-line receipt so it stays the record of what ran.
                  <div className="run-answer">
                    <span className="dot dot-green" />
                    <span className="caption">
                      {stepRuns.length > 1 && auto ? `${auto.name} — ` : ""}
                      Ran — the answer is below.
                    </span>
                  </div>
                ) : (
                  <div className="run-answer">
                    <span className="dot dot-green" />
                    <div className="run-answer-content">
                      {stepRuns.length > 1 && auto ? (
                        <div className="run-answer-name">{auto.name}</div>
                      ) : null}
                      <FormattedAnswer text={run.answer ?? run.summary ?? "Completed."} />
                    </div>
                  </div>
                )}
                {run.baton && i < stepRuns.length - 1 && (
                  <div className="baton-line" data-testid="baton">
                    Handing off:{" "}
                    {Object.entries(run.baton)
                      .map(([k, v]) => `${k} = ${v}`)
                      .join(" · ")}
                  </div>
                )}
                {run.diff && run.diff.entries.length > 0 && (
                  <DiffCard
                    diff={run.diff}
                    keepSentence={item.keepSentence}
                    onToggle={(rel) => toggleDiffEntry(item.id, rel, run.id)}
                    onKeep={() => keepBuilt(item.id, run.id)}
                    onPutBack={() => putBackBuilt(item.id, run.id)}
                    onNotNow={() => notNowBuilt(item.id, run.id)}
                  />
                )}
                <SendDraftButton
                  run={run}
                  category={auto?.category}
                  name={auto?.name}
                />
              </div>
            );
          })}
          <div className="caption">
            {[...new Set(stepRuns.flatMap((r) => r.didNotDo))].join(" · ")}
          </div>
        </div>
      )}

      {askInputs && state !== "saved" && state !== "ran" && (
        <div className="fillins">
          {result.automations[0].inputs.map((inp) => (
            <label key={inp.name} className="fillin">
              <span className="caption">{inp.label}</span>
              <input
                placeholder={`e.g. ${inp.example}`}
                value={inputValues[inp.name] ?? ""}
                onChange={(e) =>
                  setInputValues((v) => ({ ...v, [inp.name]: e.target.value }))
                }
              />
            </label>
          ))}
        </div>
      )}

      {!discarded && (
        <div className="built-actions">
          {state !== "ran" && state !== "saved" && (
            <button
              className="btn btn-primary"
              disabled={state === "running"}
              onClick={() =>
                tryOnce(
                  item.id,
                  askInputs
                    ? Object.fromEntries(
                        Object.entries(inputValues).filter(([, v]) => v.trim())
                      )
                    : undefined
                )
              }
              data-testid="try-once"
            >
              {state === "running" ? "Running…" : "Try it once"}
            </button>
          )}
          <button
            className="btn"
            disabled={state !== "ran"}
            title={
              state === "ran"
                ? undefined
                : "Save is earned — it unlocks after one watched run showed real values"
            }
            onClick={() => saveBuilt(item.id)}
            data-testid="save-built"
          >
            {state === "saved"
              ? "Saved"
              : result.automations.length === 2
                ? "Save both"
                : result.automations.length > 2
                  ? "Save all"
                  : "Save"}
          </button>
          {state !== "saved" && (
            <button
              className="btn btn-ghost"
              onClick={() => discardBuilt(item.id)}
              data-testid="throw-away"
            >
              Throw it away
            </button>
          )}
        </div>
      )}
      {discarded && <div className="caption">Thrown away.</div>}
    </div>
  );
}
