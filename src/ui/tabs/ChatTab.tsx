import { useState } from "react";
import type { TabId } from "../App";
import { PlusIcon, MicIcon } from "../icons";

// The builder surface. The composer is the product's front door; Send is
// wired to the Tell-it pipeline in build step 4.
export function ChatTab(_props: { goTo: (t: TabId) => void }) {
  const [draft, setDraft] = useState("");

  return (
    <div className="chat">
      <div className="chat-thread">
        {/* Messages and cards land here from step 4 on. */}
      </div>
      <div className="composer card">
        <textarea
          className="composer-input"
          rows={1}
          placeholder="Ask, or describe a job you want doing…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
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
            <span className="chip chip-gray">Qwen 9B</span>
            <button className="btn btn-primary btn-sm" disabled>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
