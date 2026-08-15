// Outlook mail & calendar, read locally from classic Outlook's object model
// — zero accounts, zero registration, nothing leaves this computer. Reads
// mail and calendar; the only write is a DRAFT saved into the Drafts folder,
// which the person sends themselves. Never .Send().
//
// (Microsoft Graph — the "any device, New Outlook too" backend — sits behind
// these same five tools once an Entra app registration exists; see NOTES.)
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { getSettings } from "../storage/settings";
import type { Connector, ToolContext, ToolResult, ToolSpec } from "./types";

interface MailRow {
  id: string;
  when: string;
  from: string;
  address: string;
  subject: string;
  unread: boolean;
  attachments: number;
  preview: string;
}

export interface OutlookDetect {
  classic: boolean;
  newOutlook: boolean;
  running: boolean;
}

async function op<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const raw = (await invoke("outlook_classic", {
    op: name,
    args: JSON.stringify(args),
  })) as string;
  return JSON.parse(raw) as T;
}

// Detection shells out (Get-AppxPackage is slow, ~5 s) — cache it; installs
// don't change mid-session, and "running" only matters at run time.
let detectCache: { at: number; value: OutlookDetect } | null = null;
const DETECT_TTL = 10 * 60 * 1000;

export async function detectOutlook(): Promise<OutlookDetect> {
  if (detectCache && Date.now() - detectCache.at < DETECT_TTL) return detectCache.value;
  const value = await op<OutlookDetect>("detect", {});
  detectCache = { at: Date.now(), value };
  return value;
}

function allowed(): boolean {
  return getSettings().apps?.outlookClassicAllowed === true;
}

const NOT_ALLOWED: ToolResult = {
  ok: false,
  family: "needs_you",
  text: "Outlook isn't connected yet — Settings → Connected apps → Outlook → Allow, then run this again.",
  logLine: "Outlook isn't allowed yet — nothing was read.",
};

// The failure sentences: mechanism error → what a person should do.
function failure(e: unknown, verb: string): ToolResult {
  const s = String(e);
  if (s.includes("Timeout")) {
    return {
      ok: false,
      family: "broke",
      text: "Outlook didn't answer in a minute — if it just opened, or is showing a dialog, deal with that and run this again.",
      logLine: `Asked classic Outlook to ${verb} — no answer in 60 s.`,
    };
  }
  if (/80080005|REGDB_E_CLASSNOTREG|Cannot create/i.test(s)) {
    return {
      ok: false,
      family: "needs_you",
      text: "I can only read Outlook this way when the classic Outlook app is installed here. The new Outlook keeps its mail out of reach of local apps.",
      logLine: "Classic Outlook isn't installed — nothing read.",
    };
  }
  if (/E_ABORT|user cancelled|permission|denied/i.test(s)) {
    return {
      ok: false,
      family: "needs_you",
      text: "Outlook asked for permission in its own window — click Allow there and run again.",
      logLine: `Outlook blocked the ${verb} until you allow it in its own dialog.`,
    };
  }
  return {
    ok: false,
    family: "broke",
    text: `Outlook didn't ${verb} — ${s.replace(/^Outlook:Script:/, "").slice(0, 120)}`,
    logLine: `Asked classic Outlook to ${verb} — it broke: ${s.slice(0, 80)}`,
  };
}

// Short run-local handles: the model reads and writes m1…mN, never a
// 140-character EntryID it would mangle.
function remember(ctx: ToolContext, rows: MailRow[]): string[] {
  const ids = (ctx.memory.get("outlook.ids") as Map<string, string> | undefined) ?? new Map();
  const addrs = (ctx.memory.get("outlook.addresses") as Set<string> | undefined) ?? new Set();
  const out: string[] = [];
  for (const r of rows) {
    const handle = `m${ids.size + 1}`;
    ids.set(handle, r.id);
    if (r.address) addrs.add(r.address.toLowerCase());
    out.push(handle);
  }
  ctx.memory.set("outlook.ids", ids);
  ctx.memory.set("outlook.addresses", addrs);
  return out;
}

function resolve(ctx: ToolContext, handle: string): string | null {
  const ids = ctx.memory.get("outlook.ids") as Map<string, string> | undefined;
  return ids?.get(handle.trim().toLowerCase()) ?? null;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function rowLine(handle: string, r: MailRow): string {
  return `${handle} · ${fmtWhen(r.when)} · ${r.from}${r.address ? ` <${r.address}>` : ""} · "${r.subject}"${r.unread ? " · unread" : ""}${r.attachments ? ` · ${r.attachments} attachment${r.attachments === 1 ? "" : "s"}` : ""}${r.preview ? ` · ${r.preview}` : ""}`;
}

const mailRecent: ToolSpec = {
  writes: false,
  def: {
    type: "function",
    function: {
      name: "outlook_mail_recent",
      description:
        "Recent messages in the Outlook inbox (or sent folder): sender, subject, time, unread, attachments, and a one-line preview. Returns short ids like m1 for outlook_mail_read.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", enum: ["inbox", "sent"], description: "default inbox" },
          since_hours: { type: "integer", description: "how far back, hours (default 24, max 720)" },
          unread_only: { type: "boolean" },
          from: { type: "string", description: "only messages whose sender name/address contains this" },
          limit: { type: "integer", description: "max rows (default 15, max 25)" },
        },
        required: [],
      },
    },
  },
  params: z.object({
    folder: z.enum(["inbox", "sent"]).default("inbox"),
    since_hours: z.coerce.number().int().min(1).max(720).default(24),
    unread_only: z.coerce.boolean().default(false),
    from: z.string().optional().nullable(),
    limit: z.coerce.number().int().min(1).max(25).default(15),
  }),
  async run(args, ctx) {
    if (!allowed()) return NOT_ALLOWED;
    ctx.runNote("Reading your Outlook inbox…");
    try {
      const r = await op<{ account: string; folder: string; rows: MailRow[] }>("mail_recent", args);
      const handles = remember(ctx, r.rows);
      if (r.account) {
        // A note to yourself is always an allowed draft recipient.
        const addrs = (ctx.memory.get("outlook.addresses") as Set<string> | undefined) ?? new Set();
        addrs.add(r.account.toLowerCase());
        ctx.memory.set("outlook.addresses", addrs);
        ctx.memory.set("outlook.account", r.account);
      }
      if (r.rows.length === 0) {
        const t = `No ${args.unread_only ? "unread " : ""}messages in ${r.folder} in the last ${args.since_hours} hours${args.from ? ` from "${args.from}"` : ""}.`;
        return { ok: true, family: "ok", text: t, corpusText: t, logLine: `Read Outlook's ${r.folder} — ${t.toLowerCase()} Nothing left this computer.` };
      }
      const lines = r.rows.map((row, i) => rowLine(handles[i], row));
      return {
        ok: true,
        family: "ok",
        text: `${r.rows.length} message${r.rows.length === 1 ? "" : "s"} (${r.folder}, last ${args.since_hours}h${args.unread_only ? ", unread" : ""}):\n${lines.join("\n")}`,
        corpusText: lines.join("\n"),
        logLine: `Read ${r.rows.length} message${r.rows.length === 1 ? "" : "s"} from classic Outlook's ${r.folder} on this computer — nothing sent, nothing changed, nothing left the machine.`,
      };
    } catch (e) {
      return failure(e, "list recent mail");
    }
  },
};

const mailSearch: ToolSpec = {
  writes: false,
  def: {
    type: "function",
    function: {
      name: "outlook_mail_search",
      description: "Search the Outlook inbox by words in the subject, sender name, or body.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", description: "max rows (default 15, max 25)" },
        },
        required: ["query"],
      },
    },
  },
  params: z.object({
    query: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(25).default(15),
  }),
  async run(args, ctx) {
    if (!allowed()) return NOT_ALLOWED;
    ctx.runNote(`Searching Outlook for "${args.query}"…`);
    try {
      const r = await op<{ folder: string; rows: MailRow[] }>("mail_search", args);
      const handles = remember(ctx, r.rows);
      if (r.rows.length === 0) {
        const t = `No messages match "${args.query}".`;
        return { ok: true, family: "ok", text: t, corpusText: t, logLine: `Searched Outlook for "${args.query}" — no matches.` };
      }
      const lines = r.rows.map((row, i) => rowLine(handles[i], row));
      return {
        ok: true,
        family: "ok",
        text: `${r.rows.length} match${r.rows.length === 1 ? "" : "es"} for "${args.query}":\n${lines.join("\n")}`,
        corpusText: lines.join("\n"),
        logLine: `Searched classic Outlook for "${args.query}" — ${r.rows.length} match${r.rows.length === 1 ? "" : "es"}. Nothing left this computer.`,
      };
    } catch (e) {
      return failure(e, "search mail");
    }
  },
};

const mailRead: ToolSpec = {
  writes: false,
  def: {
    type: "function",
    function: {
      name: "outlook_mail_read",
      description: "Read one message in full (from, to, date, subject, body, attachment names) by its short id from a previous listing, e.g. m2.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "short id like m2" } },
        required: ["id"],
      },
    },
  },
  params: z.object({ id: z.string().min(1) }),
  async run(args, ctx) {
    if (!allowed()) return NOT_ALLOWED;
    const real = resolve(ctx, String(args.id));
    if (!real) {
      return {
        ok: false,
        family: "on_purpose",
        text: `There is no message ${args.id} in this run — list messages first (outlook_mail_recent or outlook_mail_search) and use one of the ids it returns.`,
        logLine: `Asked for message ${args.id} before any listing — refused.`,
      };
    }
    try {
      const m = await op<{
        id: string; when: string; from: string; address: string; to: string; cc: string;
        subject: string; unread: boolean; attachments: string[]; body: string;
      }>("mail_read", { id: real });
      if (m.address) {
        const addrs = (ctx.memory.get("outlook.addresses") as Set<string> | undefined) ?? new Set();
        addrs.add(m.address.toLowerCase());
        ctx.memory.set("outlook.addresses", addrs);
      }
      const head = [
        `From: ${m.from}${m.address ? ` <${m.address}>` : ""}`,
        `To: ${m.to}`,
        m.cc ? `Cc: ${m.cc}` : "",
        `Date: ${fmtWhen(m.when)}`,
        `Subject: ${m.subject}`,
        m.attachments.length ? `Attachments: ${m.attachments.join(", ")}` : "",
      ].filter(Boolean).join("\n");
      const text = `${head}\n\n${m.body}`;
      return {
        ok: true,
        family: "ok",
        text,
        corpusText: text,
        logLine: `Read the message "${m.subject}" from classic Outlook — ${m.body.length.toLocaleString()} characters. Nothing left this computer.`,
      };
    } catch (e) {
      return failure(e, "open that message");
    }
  },
};

function rangeFor(range: string): { start: string; end: string; label: string } {
  const now = new Date();
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const start = day(now);
  const end = new Date(start);
  let label = "today";
  if (range === "tomorrow") {
    start.setDate(start.getDate() + 1);
    end.setDate(end.getDate() + 2);
    label = "tomorrow";
  } else if (range === "next_7_days") {
    end.setDate(end.getDate() + 7);
    label = "the next 7 days";
  } else if (range === "this_week") {
    const dow = (start.getDay() + 6) % 7; // Monday = 0
    start.setDate(start.getDate() - dow);
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 7);
    label = "this week";
  } else {
    end.setDate(end.getDate() + 1);
  }
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return { start: iso(start), end: iso(end), label };
}

const calendar: ToolSpec = {
  writes: false,
  def: {
    type: "function",
    function: {
      name: "outlook_calendar",
      description: "Meetings and events on the Outlook calendar for a range: start/end times, subject, location, organizer.",
      parameters: {
        type: "object",
        properties: {
          range: { type: "string", enum: ["today", "tomorrow", "next_7_days", "this_week"] },
          limit: { type: "integer", description: "max rows (default 20, max 30)" },
        },
        required: ["range"],
      },
    },
  },
  params: z.object({
    range: z.enum(["today", "tomorrow", "next_7_days", "this_week"]).default("today"),
    limit: z.coerce.number().int().min(1).max(30).default(20),
  }),
  async run(args, ctx) {
    if (!allowed()) return NOT_ALLOWED;
    const r = rangeFor(String(args.range));
    ctx.runNote(`Reading your Outlook calendar for ${r.label}…`);
    try {
      const res = await op<{ rows: { start: string; end: string; subject: string; location: string; organizer: string; allDay: boolean }[] }>(
        "calendar",
        { start: r.start, end: r.end, limit: args.limit }
      );
      if (res.rows.length === 0) {
        const t = `Nothing on the calendar for ${r.label}.`;
        return { ok: true, family: "ok", text: t, corpusText: t, logLine: `Read Outlook's calendar for ${r.label} — empty. Nothing left this computer.` };
      }
      const lines = res.rows.map((e) => {
        const s = new Date(e.start);
        const en = new Date(e.end);
        const when = e.allDay
          ? `${s.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · all day`
          : `${s.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}–${en.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
        return `${when} · ${e.subject}${e.location ? ` · ${e.location}` : ""}${e.organizer ? ` · organizer ${e.organizer}` : ""}`;
      });
      return {
        ok: true,
        family: "ok",
        text: `${res.rows.length} event${res.rows.length === 1 ? "" : "s"} for ${r.label}:\n${lines.join("\n")}`,
        corpusText: lines.join("\n"),
        logLine: `Read ${res.rows.length} calendar event${res.rows.length === 1 ? "" : "s"} for ${r.label} from classic Outlook. Nothing left this computer.`,
      };
    } catch (e) {
      return failure(e, "read the calendar");
    }
  },
};

const draft: ToolSpec = {
  writes: true,
  def: {
    type: "function",
    function: {
      name: "outlook_draft",
      description:
        "Save a DRAFT email in Outlook's Drafts folder — never sends. Either reply to a message by its short id (reply_to) or start a new draft with to + subject. The person presses Send in Outlook.",
      parameters: {
        type: "object",
        properties: {
          reply_to: { type: "string", description: "short id like m2 to reply to" },
          to: { type: "string", description: "recipient address (new draft only)" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["body"],
      },
    },
  },
  params: z.object({
    reply_to: z.string().optional().nullable(),
    to: z.string().optional().nullable(),
    subject: z.string().optional().nullable(),
    body: z.string().min(1),
  }),
  async run(args, ctx) {
    if (!allowed()) return NOT_ALLOWED;
    const payload: Record<string, unknown> = { body: args.body };
    if (args.reply_to) {
      const real = resolve(ctx, String(args.reply_to));
      if (!real) {
        return {
          ok: false,
          family: "on_purpose",
          text: `There is no message ${args.reply_to} in this run to reply to — list messages first.`,
          logLine: `Asked to reply to ${args.reply_to} before any listing — refused.`,
        };
      }
      payload.reply_to = real;
    } else {
      const to = String(args.to ?? "").trim().toLowerCase();
      const seen = (ctx.memory.get("outlook.addresses") as Set<string> | undefined) ?? new Set();
      const inputs = (ctx.memory.get("inputs.values") as string[] | undefined) ?? [];
      const known = seen.has(to) || inputs.some((v) => v.toLowerCase().includes(to));
      if (!to || !known) {
        return {
          ok: false,
          family: "on_purpose",
          text: `Refused — I only address drafts to people this run actually read from (or an address the person typed as a fill-in). Reply to a listed message with reply_to instead.`,
          logLine: `Refused to address a draft to "${to || "(nobody)"}" — not seen in this run.`,
        };
      }
      payload.to = to;
      payload.subject = args.subject ?? "";
    }
    ctx.runNote("Saving a draft in Outlook…");
    try {
      const d = await op<{ id: string; to: string; subject: string }>("draft", payload);
      const line = `Draft saved in your Outlook Drafts folder: "${d.subject}" to ${d.to} — you press Send there. Nothing was sent.`;
      return {
        ok: true,
        family: "ok",
        text: line,
        corpusText: line,
        logLine: `Saved a draft "${d.subject}" to ${d.to} in classic Outlook's Drafts folder — nothing sent.`,
        handoff: {
          kind: "outlook_draft",
          label: "Open the draft in Outlook",
          caption: "Saved in your Drafts folder — you press Send there.",
          ref: d.id,
          to: d.to,
          subject: d.subject,
        },
      };
    } catch (e) {
      return failure(e, "save the draft");
    }
  },
};

export async function openDraft(ref: string): Promise<void> {
  await op("open_draft", { id: ref });
}

export const outlookConnector: Connector = {
  id: "outlook",
  label: "Outlook mail & calendar",
  blurb:
    "Reads your inbox and calendar from classic Outlook on this computer — no sign-in — and saves drafts into your Drafts folder. Never sends. Nothing leaves this computer.",
  tools: [mailRecent, mailSearch, mailRead, calendar, draft],
  menuLine:
    "outlook_mail_recent{folder?, since_hours?, unread_only?, from?, limit?} · outlook_mail_search{query} · outlook_mail_read{id} · outlook_calendar{range: today|tomorrow|next_7_days|this_week} · outlook_draft{reply_to|to+subject, body} — reads Outlook mail & calendar on this computer; saves drafts, never sends.",
  async status() {
    if (allowed()) return { state: "ready", detail: "Allowed — reads classic Outlook on this computer." };
    try {
      const d = await detectOutlook();
      if (d.classic) return { state: "needs_allow", detail: `Classic Outlook is installed here${d.running ? " and open" : ""} — one Allow away.` };
      if (d.newOutlook) return { state: "unavailable", detail: "This computer has the new Outlook, which keeps its mail out of reach of local apps. (A Microsoft-account connection is the next step — not built yet.)" };
      return { state: "unavailable", detail: "Outlook isn't installed on this computer." };
    } catch {
      return { state: "unavailable", detail: "Couldn't check for Outlook." };
    }
  },
};
