// Settings › Connected apps. Every row is a local sense with one Allow —
// no sign-in, nothing leaves the computer — except Gmail, where the person
// pastes an app password once (sealed with DPAPI; only Rust ever reads it
// back, to log in). Reading is the default; the only writes are drafts the
// person sends themselves and a pause/skip they can undo. Nothing sends
// itself.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CONNECTORS, connectorStatuses, ConnectorSnapshot } from "../connectors/registry";
import type { ConnectorId } from "../connectors/types";
import { GMAIL_SECRET, gmailCheck } from "../connectors/gmail";
import { getSettings, updateSettings } from "../storage/settings";

const ALLOW_KEY: Partial<Record<ConnectorId, "computerAllowed" | "outlookClassicAllowed" | "spotifyAllowed">> = {
  computer: "computerAllowed",
};

const CONSENT: Partial<Record<ConnectorId, string>> = {
  gmail:
    "Reads your Gmail over IMAP using an app password (Google Account → Security → 2-Step Verification → App passwords → generate one and paste it here). Personal Gmail only — Google no longer allows app passwords on Workspace accounts. Saves drafts into Gmail's Drafts; never sends; never marks mail as read.",
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
    const key = ALLOW_KEY[id];
    if (!key) return;
    await updateSettings((s) => {
      s.apps = { ...(s.apps ?? {}), [key]: on };
    });
    setTick((t) => t + 1);
  }

  return (
    <div className="settings-card" data-testid="connected-apps">
      <div className="settings-card-title">Connected apps</div>
      <div className="caption">
        Let automations look into apps you use. Reading is the default; the
        only writes are drafts you send yourself and a pause or skip you can
        undo. Nothing sends itself.
        {cloudOn
          ? " With Borrow cloud compute on, what these apps show goes to the borrowed computer too."
          : ""}
      </div>
      {CONNECTORS.map((c) => {
        const s = snap?.find((x) => x.id === c.id)?.status;
        if (c.id === "gmail") {
          return <GmailRow key={c.id} status={s} onChange={() => setTick((t) => t + 1)} />;
        }
        const key = ALLOW_KEY[c.id];
        const allowed = key ? getSettings().apps?.[key] === true : false;
        const unavailable = s?.state === "unavailable";
        return (
          <div
            key={c.id}
            className="settings-row"
            data-testid={`app-row-${c.id}`}
            style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "10px 0", borderTop: "1px solid var(--line)" }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{c.label}</div>
              <div className="caption">{c.blurb}</div>
              <div
                className="status-line"
                data-testid={`app-status-${c.id}`}
                style={{ color: allowed ? "var(--green)" : unavailable ? "var(--muted)" : "var(--text)" }}
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
        Reading is the default, and the only writes are drafts you send
        yourself.
      </div>
    </div>
  );
}

// Heavy tasks — real file work through vetted tools. The model never types a
// command; the app builds it, and everything runs in a copy → you keep the
// results. One Allow.
export function HeavyTasksCard() {
  const [, setTick] = useState(0);
  const allowed = getSettings().heavy?.filesAllowed === true;
  async function setAllowed(on: boolean) {
    await updateSettings((s) => {
      s.heavy = { ...(s.heavy ?? {}), filesAllowed: on };
    });
    setTick((t) => t + 1);
  }
  return (
    <div className="settings-card" data-testid="heavy-tasks">
      <div className="settings-card-title">
        Heavy tasks
        <button
          className={allowed ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"}
          onClick={() => void setAllowed(!allowed)}
          data-testid="heavy-toggle"
        >
          {allowed ? "Turn off" : "Allow"}
        </button>
      </div>
      <div className="caption">
        Let automations do real work on your files — rename in bulk, pack
        archives, and read scanned or photographed documents (OCR) so you can
        search and ask questions about them. Everything runs on this computer,
        in a copy of your folders, with no internet. The model fills in the
        blanks — which files, what format; it never types commands. Nothing
        changes until you press Keep.
      </div>
      <div
        className="status-line"
        data-testid="heavy-status"
        style={{ color: allowed ? "var(--green)" : "var(--text)" }}
      >
        {allowed
          ? "Allowed — automations can rename, archive, and read documents in a copy."
          : "Off — automations can't run file tools until you allow it."}
      </div>
    </div>
  );
}

// Gmail: address + app password → one live IMAP login proves it, then the
// password is sealed and the field is emptied. Disconnect deletes it.
function GmailRow({
  status,
  onChange,
}: {
  status: ConnectorSnapshot["status"] | undefined;
  onChange: () => void;
}) {
  const connected = getSettings().apps?.gmail ?? null;
  const [address, setAddress] = useState(connected?.address ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function connect() {
    const addr = address.trim();
    const pw = password.replace(/\s+/g, ""); // Google shows app passwords in 4-char groups
    if (!addr || !pw) {
      setLine("Type the Gmail address and paste the 16-character app password.");
      return;
    }
    setBusy(true);
    setLine("Signing in to imap.gmail.com…");
    try {
      await updateSettings((s) => {
        s.apps = { ...(s.apps ?? {}), gmail: { address: addr, connectedAt: Date.now() } };
      });
      await invoke("secret_set", { name: GMAIL_SECRET, value: pw });
      setPassword("");
      const r = await gmailCheck();
      if (r.ok) {
        setLine(`Connected as ${r.account}. Reads over IMAP; drafts only; nothing marks mail read.`);
        setOpen(false);
      } else {
        // A failed login must not leave a half-connection behind.
        await invoke("secret_clear", { name: GMAIL_SECRET });
        await updateSettings((s) => {
          s.apps = { ...(s.apps ?? {}), gmail: null };
        });
        setLine(r.sentence);
      }
    } catch (e) {
      setLine(`Broke: ${String(e).slice(0, 120)}`);
    } finally {
      setBusy(false);
      onChange();
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await invoke("gmail_disconnect_pool").catch(() => {});
      await invoke("secret_clear", { name: GMAIL_SECRET });
      await updateSettings((s) => {
        s.apps = { ...(s.apps ?? {}), gmail: null };
      });
      setLine("Disconnected — the app password is deleted from this computer. Google still lists it under App passwords until you remove it there.");
      setPassword("");
    } finally {
      setBusy(false);
      onChange();
    }
  }

  return (
    <div
      className="settings-row"
      data-testid="app-row-gmail"
      style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "10px 0", borderTop: "1px solid var(--line)" }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>Gmail</div>
        <div className="caption">
          Reads your Gmail inbox over IMAP with an app password you paste once —
          no Google sign-in screens, no developer setup. Saves drafts into
          Gmail's Drafts; never sends; never marks mail as read.
        </div>
        <div
          className="status-line"
          data-testid="app-status-gmail"
          style={{ color: status?.state === "ready" ? "var(--green)" : "var(--text)" }}
        >
          {status?.detail ?? "Checking…"}
        </div>
        {line && (
          <div className="caption" data-testid="gmail-line" style={{ marginTop: 4 }}>
            {line}
          </div>
        )}
        {(open || !connected) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            <div className="caption">{CONSENT.gmail}</div>
            <input
              className="run-search"
              placeholder="you@gmail.com"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              data-testid="gmail-address"
              autoComplete="off"
              style={{ maxWidth: 320 }}
            />
            <input
              className="run-search"
              type="password"
              placeholder="16-character app password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="gmail-password"
              autoComplete="off"
              style={{ maxWidth: 320 }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={() => void connect()} disabled={busy} data-testid="gmail-connect">
                {busy ? "Signing in…" : "Connect"}
              </button>
              {connected && (
                <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} disabled={busy}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {connected && !open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)} disabled={busy}>
            Change
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => void disconnect()} disabled={busy} data-testid="gmail-disconnect">
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
