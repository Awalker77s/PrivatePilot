// Settings › Connected apps. Every row is a local sense with one Allow —
// no sign-in, nothing leaves the computer. Reading is the default; the only
// writes are drafts the person sends themselves and a pause/skip they can
// undo. Nothing sends itself.
import { useEffect, useState } from "react";
import { CONNECTORS, connectorStatuses, ConnectorSnapshot } from "../connectors/registry";
import type { ConnectorId } from "../connectors/types";
import { getSettings, updateSettings } from "../storage/settings";

const ALLOW_KEY: Record<ConnectorId, "computerAllowed" | "outlookClassicAllowed" | "spotifyAllowed"> = {
  computer: "computerAllowed",
  outlook: "outlookClassicAllowed",
  spotify: "spotifyAllowed",
};

const CONSENT: Record<ConnectorId, string> = {
  outlook:
    "Reads your inbox and calendar from the classic Outlook app on this computer. Saves drafts into your Drafts folder — never sends. If Outlook shows its own permission dialog, click Allow there.",
  spotify:
    "Reads what Spotify on this computer is playing, and can pause or skip. No Spotify account is involved.",
  computer:
    "Reads what an open app window shows — the same text a screen reader gets — one window at a time, only when an automation names it. Never password managers. It looks; it never clicks or types.",
};

export function ConnectedAppsCard() {
  const [snap, setSnap] = useState<ConnectorSnapshot[] | null>(null);
  const [tick, setTick] = useState(0);
  const cloudOn = getSettings().featherless.enabled;

  useEffect(() => {
    let live = true;
    connectorStatuses().then((s) => {
      if (live) setSnap(s);
    });
    return () => {
      live = false;
    };
  }, [tick]);

  async function setAllowed(id: ConnectorId, on: boolean) {
    await updateSettings((s) => {
      s.apps = { ...(s.apps ?? {}), [ALLOW_KEY[id]]: on };
    });
    setTick((t) => t + 1);
  }

  return (
    <div className="settings-card" data-testid="connected-apps">
      <div className="settings-card-title">Connected apps</div>
      <div className="caption">
        Let automations look into apps on this computer. Reading is the
        default; the only writes are drafts you send yourself and a pause or
        skip you can undo. Nothing sends itself. Nothing leaves this computer.
        {cloudOn
          ? " With Borrow cloud compute on, what these apps show goes to the borrowed computer too."
          : ""}
      </div>
      {CONNECTORS.map((c) => {
        const s = snap?.find((x) => x.id === c.id)?.status;
        const allowed = getSettings().apps?.[ALLOW_KEY[c.id]] === true;
        const unavailable = s?.state === "unavailable";
        return (
          <div
            key={c.id}
            className="settings-row"
            data-testid={`app-row-${c.id}`}
            style={{
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
              padding: "10px 0",
              borderTop: "1px solid var(--line)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{c.label}</div>
              <div className="caption">{c.blurb}</div>
              <div
                className="status-line"
                data-testid={`app-status-${c.id}`}
                style={{
                  color: allowed
                    ? "var(--green)"
                    : unavailable
                      ? "var(--muted)"
                      : "var(--text)",
                }}
              >
                {!snap ? "Checking…" : (s?.detail ?? "")}
              </div>
              {!allowed && !unavailable && snap && (
                <div className="caption" style={{ marginTop: 4 }}>
                  {CONSENT[c.id]}
                </div>
              )}
            </div>
            {!unavailable && snap && (
              <button
                className={allowed ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"}
                onClick={() => void setAllowed(c.id, !allowed)}
                data-testid={`app-toggle-${c.id}`}
              >
                {allowed ? "Turn off" : "Allow"}
              </button>
            )}
          </div>
        );
      })}
      <div className="caption" style={{ marginTop: 8 }}>
        Coming next: a Microsoft-account connection so Outlook works from any
        device (including the new Outlook), and more apps.
      </div>
    </div>
  );
}
