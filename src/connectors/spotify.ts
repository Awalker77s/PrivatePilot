// Spotify on THIS computer — through the Windows media session, the same
// data the volume flyout shows. Zero accounts, zero network. The Spotify
// Web API is deliberately not here: in 2026 it allows five allow-listed
// users per app and needs a Premium owner — no honest sentence makes that
// seamless for a stranger's computer.
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { getSettings } from "../storage/settings";
import type { Connector, ToolResult, ToolSpec } from "./types";

export interface MediaSession {
  app: string;
  app_label: string;
  status: string;
  title: string;
  artist: string;
  album: string;
}

export async function mediaSessions(): Promise<MediaSession[]> {
  return (await invoke("media_sessions")) as MediaSession[];
}

function isSpotify(s: MediaSession): boolean {
  return /spotify/i.test(s.app) || /spotify/i.test(s.app_label);
}

export function sessionLine(s: MediaSession): string {
  const what = s.title
    ? `"${s.title}"${s.artist ? ` — ${s.artist}` : ""}${s.album ? ` · ${s.album}` : ""}`
    : "(nothing loaded)";
  return `${s.app_label} · ${s.status} · ${what}`;
}

const NOT_ALLOWED: ToolResult = {
  ok: false,
  family: "needs_you",
  text: "Reading Spotify on this computer is off — Settings → Connected apps → Spotify → Allow.",
  logLine: "Spotify isn't allowed yet — nothing was read.",
};

function allowed(): boolean {
  return getSettings().apps?.spotifyAllowed === true;
}

const nowPlaying: ToolSpec = {
  writes: false,
  def: {
    type: "function",
    function: {
      name: "spotify_now_playing",
      description:
        "What Spotify on this computer is playing right now: track, artist, album, and whether it is playing or paused. No account needed.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  params: z.object({}).passthrough(),
  async run() {
    if (!allowed()) return NOT_ALLOWED;
    let sessions: MediaSession[];
    try {
      sessions = await mediaSessions();
    } catch (e) {
      return {
        ok: false,
        family: "broke",
        text: `Windows didn't report what's playing — ${String(e).slice(0, 80)}`,
        logLine: "Asked Windows what's playing — it didn't answer.",
      };
    }
    const sp = sessions.filter(isSpotify);
    if (sp.length === 0) {
      return {
        ok: false,
        family: "on_purpose",
        text: "Spotify has nothing open right now — no song is loaded on this computer. (Spotify may be closed.)",
        logLine: "Asked Windows what Spotify is playing — Spotify has no session open.",
      };
    }
    const lines = sp.map(sessionLine);
    return {
      ok: true,
      family: "ok",
      text: lines.join("\n"),
      corpusText: lines.join("\n"),
      logLine: `Read what Spotify is playing from Windows' media session — ${sp[0].status}${sp[0].title ? `, "${sp[0].title}"` : ""}. Nothing left this computer.`,
    };
  },
};

const control: ToolSpec = {
  writes: true,
  def: {
    type: "function",
    function: {
      name: "spotify_control",
      description:
        "Tell Spotify on this computer to play, pause, skip to the next song, or go back to the previous one.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["play", "pause", "next", "previous"] },
        },
        required: ["action"],
      },
    },
  },
  params: z.object({ action: z.enum(["play", "pause", "next", "previous"]) }),
  async run(args) {
    if (!allowed()) return NOT_ALLOWED;
    const action = String(args.action);
    try {
      const ok = (await invoke("media_control", { app: "spotify", action })) as boolean;
      if (!ok) {
        return {
          ok: false,
          family: "broke",
          text: `Spotify didn't take the ${action} command — it may be showing an ad, or be closed.`,
          logLine: `Sent Spotify "${action}" — it refused.`,
        };
      }
      // Say what it's doing now, so the answer can be literally true.
      let after = "";
      try {
        const s = (await mediaSessions()).find(isSpotify);
        if (s) after = ` Now: ${sessionLine(s)}`;
      } catch {
        // the command landed; the follow-up read is a courtesy
      }
      return {
        ok: true,
        family: "ok",
        text: `Spotify accepted ${action}.${after}`,
        corpusText: after.trim(),
        logLine: `Told Spotify to ${action} through Windows' media controls — it accepted. Reversible: press the other button.`,
      };
    } catch (e) {
      const s = String(e);
      if (s.includes("NoSession")) {
        return {
          ok: false,
          family: "on_purpose",
          text: "Spotify has nothing open right now, so there is nothing to control.",
          logLine: "Spotify has no session open — no command sent.",
        };
      }
      return {
        ok: false,
        family: "broke",
        text: `Windows didn't relay the ${action} command — ${s.slice(0, 80)}`,
        logLine: `Tried to ${action} Spotify — Windows didn't relay it.`,
      };
    }
  },
};

export const spotifyConnector: Connector = {
  id: "spotify",
  label: "Spotify",
  blurb:
    "Sees what's playing on this computer and can pause or skip — no account needed. Nothing leaves this computer.",
  tools: [nowPlaying, control],
  menuLine:
    "spotify_now_playing{} · spotify_control{action: play|pause|next|previous} — what Spotify on this computer is playing; pause/skip. No sign-in.",
  async status() {
    if (allowed()) return { state: "ready", detail: "Allowed — reads what's playing on this computer." };
    // Detect an installed Spotify by asking Windows for a session; absent a
    // session we can't tell installed-but-closed from missing, so say so.
    try {
      const s = (await mediaSessions()).find(isSpotify);
      if (s) return { state: "needs_allow", detail: `Spotify is open (${s.status}) — one Allow away.` };
    } catch {
      // media sessions unavailable — still offer Allow
    }
    return { state: "needs_allow", detail: "Works whenever Spotify is open on this computer." };
  },
};
