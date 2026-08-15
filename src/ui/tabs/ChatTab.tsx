import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TabId } from "../App";
import { PlusIcon, MicIcon, ArrowRightIcon } from "../icons";
import { activeModelLabel } from "../../providers";
import {
  ChatItem,
  chatBusy,
  chatItems,
  chatVersion,
  chooseFile,
  consumeComposerSeed,
  discardBuilt,
  keepBuilt,
  keepEdit,
  notNowBuilt,
  pickOption,
  putBackBuilt,
  revertEdit,
  saveBuilt,
  sendText,
  subscribeChat,
  toggleDiffEntry,
  tryOnce,
} from "../chatStore";
import { getRun } from "../../storage/stores";
import { useStoreVersion } from "../../storage/useStore";
import { DiffCard } from "../DiffCard";
import { SendDraftButton } from "../RunDetail";

export function ChatTab(_props: { goTo: (t: TabId) => void }) {
  useSyncExternalStore(subscribeChat, chatVersion);
  const [draft, setDraft] = useState("");
  const [modelLabel, setModelLabel] = useState("…");
  const threadRef = useRef<HTMLDivElement>(null);
  const items = chatItems();
  const busy = chatBusy();

  useEffect(() => {
    activeModelLabel()
      .then(setModelLabel)
      .catch(() => setModelLabel("Ollama off"));
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [items.length]);

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
    <div className="chat">
      <div className="chat-thread" ref={threadRef} data-testid="chat-thread">
        {items.map((item) => (
          <ChatItemView key={item.id} item={item} />
        ))}
      </div>
      <div className="composer card">
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
            <button className="btn btn-sm btn-ghost" title="Watch me / Tell it">
              <PlusIcon size={13} />
            </button>
            <button className="btn btn-sm btn-ghost" title="Watch me">
              <MicIcon size={13} />
            </button>
          </div>
          <div className="composer-right">
            <span className="chip chip-gray">{modelLabel}</span>
            <button
              className="btn btn-primary btn-sm"
              disabled={busy || !draft.trim()}
              onClick={submit}
              data-testid="send"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg-row user">
          <div className="msg-user">{item.text}</div>
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
    case "note":
      return (
        <div className={`note-card note-${item.tone}`} data-testid="note">
          {item.text}
        </div>
      );
  }
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
        <button
          className="btn btn-sm btn-ghost"
          disabled={item.answered !== null}
          onClick={() => chooseFile(item.id)}
        >
          Choose…
        </button>
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
          : `Built it — ${result.automations.length === 2 ? "two" : result.automations.length} automations, ${result.chain ? "one hand-off" : "no hand-off"}. Same sheet you'll see on their tiles:`}
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
          {i < result.automations.length - 1 && <div className="built-sep" />}
        </div>
      ))}
      {result.keptToOneStep && (
        <div className="caption">Kept this to one step — that's all it needs.</div>
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
                    {auto ? `${auto.name} — ` : ""}
                    {run.summary}
                  </div>
                ) : run.status === "held" ? (
                  <div className="run-answer" style={{ color: "var(--muted)" }}>
                    <span className="dot dot-gray" />
                    {auto ? `${auto.name} — ` : ""}
                    {run.summary}
                  </div>
                ) : (
                  <div className="run-answer">
                    <span className="dot dot-green" />
                    {stepRuns.length > 1 && auto ? <b>{auto.name}&nbsp;— </b> : null}
                    {run.answer ?? run.summary}
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
