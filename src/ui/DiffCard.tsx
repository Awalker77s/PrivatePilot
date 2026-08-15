// The diff card — VS Code Refactor Preview pattern: header sentence with
// counts, per-file accordion grouped Added / Changed / Deleted, before/after
// hunks inside, and a per-file keep-checkbox — partial acceptance, like
// staging.
import { useState } from "react";
import type { RunDiff } from "../storage/types";

export function DiffCard({
  diff,
  disabled,
  onToggle,
  onKeep,
  onPutBack,
  onNotNow,
  keepSentence,
}: {
  diff: RunDiff;
  disabled?: boolean;
  onToggle: (relPath: string) => void;
  onKeep: () => void;
  onPutBack: () => void;
  onNotNow?: () => void;
  keepSentence?: string | null;
}) {
  const [openFile, setOpenFile] = useState<string | null>(
    diff.entries.length === 1 ? diff.entries[0].relPath : null
  );
  const groups: ("added" | "changed" | "deleted")[] = [
    "added",
    "changed",
    "deleted",
  ];
  return (
    <div className="diff-card" data-testid="diff-card">
      <div className="diff-headline">{diff.headline}</div>
      {groups.map((kind) => {
        const entries = diff.entries.filter((e) => e.kind === kind);
        if (entries.length === 0) return null;
        return (
          <div key={kind} className="diff-group">
            <div className="caption" style={{ textTransform: "capitalize" }}>
              {kind}
            </div>
            {entries.map((e) => (
              <div key={e.relPath} className="diff-file">
                <div className="diff-file-row">
                  <input
                    type="checkbox"
                    checked={e.kept}
                    disabled={diff.applied || disabled}
                    onChange={() => onToggle(e.relPath)}
                  />
                  <button
                    className="diff-file-name"
                    onClick={() =>
                      setOpenFile(openFile === e.relPath ? null : e.relPath)
                    }
                  >
                    {e.relPath}
                  </button>
                  {e.note && <span className="caption">{e.note}</span>}
                </div>
                {openFile === e.relPath && e.hunks && (
                  <pre className="diff-hunks">
                    {e.hunks.split("\n").map((l, i) => (
                      <div
                        key={i}
                        className={
                          l.startsWith("+")
                            ? "hunk-add"
                            : l.startsWith("-")
                              ? "hunk-del"
                              : "hunk-ctx"
                        }
                      >
                        {l}
                      </div>
                    ))}
                  </pre>
                )}
              </div>
            ))}
          </div>
        );
      })}
      {!diff.applied ? (
        <div className="built-actions">
          <button
            className="btn btn-primary"
            onClick={onKeep}
            disabled={disabled}
            data-testid="keep"
          >
            Keep
          </button>
          <button
            className="btn btn-ghost"
            data-testid="not-now"
            disabled={disabled}
            onClick={onNotNow}
          >
            Not now
          </button>
        </div>
      ) : (
        <button
          className="btn btn-ghost btn-sm"
          onClick={onPutBack}
          data-testid="put-back"
        >
          {keepSentence ?? "Put it back the way it was ›"}
        </button>
      )}
    </div>
  );
}
