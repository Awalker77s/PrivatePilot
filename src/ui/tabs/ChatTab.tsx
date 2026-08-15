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
  discardBuilt,
  pickOption,
  sendText,
  subscribeChat,
} from "../chatStore";

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
    case "note":
      return (
        <div className={`note-card note-${item.tone}`} data-testid="note">
          {item.text}
        </div>
      );
  }
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
  const { result, state } = item;
  const discarded = state === "discarded";
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
      {!discarded && (
        <div className="built-actions">
          <button
            className="btn btn-primary"
            disabled
            title="The runner arrives in the next build step"
            data-testid="try-once"
          >
            Try it once
          </button>
          <button
            className="btn"
            disabled
            title="Save is earned — it unlocks after one watched run showed real values"
            data-testid="save-built"
          >
            Save
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => discardBuilt(item.id)}
            data-testid="throw-away"
          >
            Throw it away
          </button>
        </div>
      )}
      {discarded && <div className="caption">Thrown away.</div>}
    </div>
  );
}
