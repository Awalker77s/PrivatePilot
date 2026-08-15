// "This computer" — the read_page of apps. Lists the open app windows and
// reads what one shows through Windows UI Automation (the same tree a
// screen reader gets), one window at a time, only when an automation names
// it. Read-only: it looks, it never clicks or types. Also the all-apps
// media view (any player, not just Spotify).
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { getSettings } from "../storage/settings";
import { mediaSessions, sessionLine } from "./spotify";
import type { Connector, ToolResult, ToolSpec } from "./types";

interface AppWindow {
  title: string;
  process: string;
  pid: number;
}

interface WindowText {
  title: string;
  process: string;
  elements_total: number;
  elements_shown: number;
  text: string;
  walk_ms: number;
  retries: number;
}

const NOT_ALLOWED: ToolResult = {
  ok: false,
  family: "needs_you",
  text: "Reading app windows is off — Settings → Connected apps → This computer → Allow.",
  logLine: "Reading app windows isn't allowed yet — nothing was read.",
};

function allowed(): boolean {
  return getSettings().apps?.computerAllowed === true;
}

function prettyProcess(p: string): string {
  return p.replace(/\.exe$/i, "");
}

const listApps: ToolSpec = {
  writes: false,
  def: {
    type: "function",
    function: {
      name: "list_apps",
      description:
        "List the app windows open on this computer right now (title and app name). Use it to find the exact name to pass to read_app.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  params: z.object({}).passthrough(),
  async run() {
    if (!allowed()) return NOT_ALLOWED;
    let wins: AppWindow[];
    try {
      wins = (await invoke("list_windows")) as AppWindow[];
    } catch (e) {
      return {
        ok: false,
        family: "broke",
        text: `Windows didn't list the open windows — ${String(e).slice(0, 80)}`,
        logLine: "Asked Windows for the open windows — it didn't answer.",
      };
    }
    if (wins.length === 0) {
      return {
        ok: false,
        family: "on_purpose",
        text: "No app windows are open right now.",
        logLine: "Listed the open windows — none.",
      };
    }
    const lines = wins.map((w) => `${prettyProcess(w.process)} · "${w.title}"`);
    return {
      ok: true,
      family: "ok",
      text: lines.join("\n"),
      corpusText: lines.join("\n"),
      logLine: `Listed ${wins.length} open window${wins.length === 1 ? "" : "s"} on this computer. Nothing left the machine.`,
    };
  },
};

const readApp: ToolSpec = {
  writes: false,
  def: {
    type: "function",
    function: {
      name: "read_app",
      description:
        "Read what an open app window on this computer shows, as text (buttons, lists, messages, document text). Give the app's name (Discord, Notepad, Outlook, Teams…). Optional focus narrows to a region whose name contains that word (e.g. 'Inbox').",
      parameters: {
        type: "object",
        properties: {
          app: { type: "string", description: "App or window name, e.g. Discord" },
          focus: { type: "string", description: "Optional region name to narrow to" },
        },
        required: ["app"],
      },
    },
  },
  params: z.object({
    app: z.string().min(1),
    focus: z.string().optional().nullable(),
  }),
  async run(args, ctx) {
    if (!allowed()) return NOT_ALLOWED;
    const app = String(args.app);
    const focus = args.focus ? String(args.focus) : null;
    ctx.runNote(`Reading the ${app} window…`);
    let r: WindowText;
    try {
      r = (await invoke("read_window", { app, focus })) as WindowText;
    } catch (e) {
      const s = String(e);
      if (s.includes("NoWindow")) {
        return {
          ok: false,
          family: "on_purpose",
          text: `I couldn't find a ${app} window — is it open? Minimised is fine, closed isn't. Use list_apps to see the exact names.`,
          logLine: `Looked for a ${app} window — none open.`,
        };
      }
      if (s.includes("Timeout")) {
        return {
          ok: false,
          family: "broke",
          text: `${app}'s window didn't answer in time — it may be busy or frozen.`,
          logLine: `Tried to read the ${app} window — it didn't answer in 20 s.`,
        };
      }
      return {
        ok: false,
        family: "broke",
        text: `Couldn't read the ${app} window — ${s.slice(0, 80)}`,
        logLine: `Tried to read the ${app} window — Windows refused (${s.slice(0, 60)}).`,
      };
    }
    const label = `${prettyProcess(r.process)} — "${r.title}"`;
    if (r.elements_total < 30 || r.text.trim().length < 20) {
      // Skeletal: some apps (Spotify's Store build, some games) expose almost
      // nothing to Windows' accessibility tree. Say so; never invent.
      return {
        ok: false,
        family: "on_purpose",
        text: `${label} shows almost no readable text to Windows (${r.elements_total} elements) — that app doesn't describe its screen. I can't read it honestly.`,
        logLine: `Read the ${label} window — only ${r.elements_total} elements after ${r.retries} retr${r.retries === 1 ? "y" : "ies"}; that app hides its screen from Windows.`,
      };
    }
    const header = `${label} · ${r.elements_total.toLocaleString()} elements, showing ${r.elements_shown}${focus ? ` · focused on "${focus}"` : ""}`;
    return {
      ok: true,
      family: "ok",
      text: `${header}\n${r.text}`,
      corpusText: r.text,
      logLine: `Read the ${label} window through Windows' accessibility tree in ${(r.walk_ms / 1000).toFixed(1)}s — ${r.elements_shown} of ${r.elements_total.toLocaleString()} elements. Nothing left this computer.`,
    };
  },
};

const nowPlayingAll: ToolSpec = {
  writes: false,
  def: {
    type: "function",
    function: {
      name: "now_playing",
      description:
        "What every media app on this computer is playing right now (Spotify, a browser tab, a video player) — track/title, app, playing or paused.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  params: z.object({}).passthrough(),
  async run() {
    if (!allowed()) return NOT_ALLOWED;
    try {
      const s = await mediaSessions();
      if (s.length === 0) {
        return {
          ok: false,
          family: "on_purpose",
          text: "Nothing is playing — no media app has a session open right now.",
          logLine: "Asked Windows what's playing — nothing.",
        };
      }
      const lines = s.map(sessionLine);
      return {
        ok: true,
        family: "ok",
        text: lines.join("\n"),
        corpusText: lines.join("\n"),
        logLine: `Read ${s.length} media session${s.length === 1 ? "" : "s"} from Windows. Nothing left this computer.`,
      };
    } catch (e) {
      return {
        ok: false,
        family: "broke",
        text: `Windows didn't report what's playing — ${String(e).slice(0, 80)}`,
        logLine: "Asked Windows what's playing — it didn't answer.",
      };
    }
  },
};

export const computerConnector: Connector = {
  id: "computer",
  label: "This computer",
  blurb:
    "Reads what an open app window shows (Discord, Teams, Notepad, Outlook…) and what any media app is playing — one window at a time, only when an automation names it. Never password managers. Nothing leaves this computer.",
  tools: [listApps, readApp, nowPlayingAll],
  menuLine:
    "list_apps{} · read_app{app, focus?} · now_playing{} — what an open app window shows as text (Discord, Teams, Notepad…), and what any media app is playing. No sign-in.",
  async status() {
    if (allowed()) return { state: "ready", detail: "Allowed — reads open app windows on request." };
    return { state: "needs_allow", detail: "Off until you allow it." };
  },
};
