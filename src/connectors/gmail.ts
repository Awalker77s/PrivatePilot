// Gmail — read over IMAP with an app password the person pastes once (no
// developer registration, no OAuth screens). Reads never mark mail as
// read; the only write is a DRAFT saved into Gmail's Drafts, which the
// person sends from Gmail. Never a send. The password is DPAPI-sealed and
// only Rust ever unseals it, to log in — it never crosses back to here.
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { getSettings } from "../storage/settings";
import type { Connector, ToolContext, ToolResult, ToolSpec } from "./types";

export const GMAIL_SECRET = "gmail.app_password";

interface Row {
  id: number;
  when: string;
  from: string;
  address: string;
  subject: string;
  unread: boolean;
  size: number;
}

function account(): string {
  return getSettings().apps?.gmail?.address?.trim() ?? "";
}

export async function gmailHasPassword(): Promise<boolean> {
  return (await invoke("secret_has", { name: GMAIL_SECRET })) as boolean;
}

async function op<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const raw = (await invoke("gmail_imap", {
    account: account(),
    op: name,
    args: JSON.stringify(args),
  })) as string;
  return JSON.parse(raw) as T;
}

// One live login — the Settings row's "Connect" proves the password works.
export async function gmailCheck(): Promise<{ ok: true; account: string } | { ok: false; sentence: string }> {
  try {
    const r = await op<{ ok: boolean; account: string }>("status", {});
    return { ok: true, account: r.account };
  } catch (e) {
    return { ok: false, sentence: failure(e, "sign in").text };
  }
}

const NOT_CONNECTED: ToolResult = {
  ok: false,
  family: "needs_you",
  text: "Gmail isn't connected yet — Settings → Connected apps → Gmail → paste an app password, then run this again.",
  logLine: "Gmail isn't connected — nothing was read.",
};

function failure(e: unknown, verb: string): ToolResult {
  const s = String(e);
  if (s.includes("NoPassword") || s.includes("NoAccount")) return NOT_CONNECTED;
  if (/AUTHENTICATIONFAILED|Invalid credentials|Application-specific password|Username and Password not accepted/i.test(s)) {
    return {
      ok: false,
      family: "needs_you",
      text: "Google didn't accept the app password — generate a new one (Google Account → Security → 2-Step Verification → App passwords) and paste it again in Settings.",
      logLine: `Gmail refused the sign-in — nothing was read.`,
    };
  }
  if (/IMAP access is disabled|IMAP is disabled/i.test(s)) {
    return {
      ok: false,
      family: "needs_you",
      text: "Gmail's IMAP switch is off — Gmail → Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP.",
      logLine: "Gmail has IMAP turned off — nothing was read.",
    };
  }
  if (/Dns|Connect:|Tls|timed out|os error 10060|WSAETIMEDOUT/i.test(s)) {
    return {
      ok: false,
      family: "broke",
      text: "Couldn't reach imap.gmail.com — are you online?",
      logLine: `Tried to reach Gmail to ${verb} — no connection.`,
    };
  }
  if (s.includes("NoSuchMessage")) {
    return {
      ok: false,
      family: "on_purpose",
      text: "That message isn't in the inbox any more — list messages again.",
      logLine: "Asked Gmail for a message it no longer lists.",
    };
  }
  return {
    ok: false,
    family: "broke",
    text: `Gmail didn't ${verb} — ${s.replace(/^Gmail:\w+:/, "").slice(0, 120)}`,
    logLine: `Asked Gmail to ${verb} — it broke: ${s.slice(0, 80)}`,
  };
}

// Short run-local handles g1…gN → IMAP UIDs; addresses seen this run.
function remember(ctx: ToolContext, rows: Row[]): string[] {
  const ids = (ctx.memory.get("gmail.ids") as Map<string, number> | undefined) ?? new Map();
  const addrs = (ctx.memory.get("gmail.addresses") as Set<string> | undefined) ?? new Set();
  const own = account().toLowerCase();
  if (own) addrs.add(own); // a note to yourself is always allowed
  const out: string[] = [];
  for (const r of rows) {
    const handle = `g${ids.size + 1}`;
    ids.set(handle, r.id);
    if (r.address) addrs.add(r.address.toLowerCase());
    out.push(handle);
  }
  ctx.memory.set("gmail.ids", ids);
  ctx.memory.set("gmail.addresses", addrs);
  return out;
}

function resolve(ctx: ToolContext, handle: string): number | null {
  const ids = ctx.memory.get("gmail.ids") as Map<string, number> | undefined;
  return ids?.get(handle.trim().toLowerCase()) ?? null;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function rowLine(handle: string, r: Row): string {
  return `${handle} · ${fmtWhen(r.when)} · ${r.from}${r.address && r.address !== r.from ? ` <${r.address}>` : ""} · "${r.subject}"${r.unread ? " · unread" : ""}`;
}

const recent: ToolSpec = {
  writes: false,
  def: {
    type: "function",
    function: {
      name: "gmail_recent",
      description: "Recent messages in the Gmail inbox: sender, subject, time, unread. Returns short ids like g1 for gmail_read.",
      parameters: {
        type: "object",
        properties: {
          since_hours: { type: "integer", description: "how far back, hours (default 24, max 720)" },
          unread_only: { type: "boolean" },
          from: { type: "string", description: "only messages from this sender (name or address)" },
          limit: { type: "integer", description: "max rows (default 15, max 25)" },
        },
        required: [],
      },
    },
  },
  params: z.object({
    since_hours: z.coerce.number().int().min(1).max(720).default(24),
    unread_only: z.coerce.boolean().default(false),
    from: z.string().optional().nullable(),
    limit: z.coerce.number().int().min(1).max(25).default(15),
  }),
  async run(args, ctx) {
    if (!account()) return NOT_CONNECTED;
    ctx.runNote("Reading your Gmail inbox…");
    try {
      const r = await op<{ rows: Row[] }>("recent", args);
      const handles = remember(ctx, r.rows);
      if (r.rows.length === 0) {
        const t = `No ${args.unread_only ? "unread " : ""}messages in the last ${args.since_hours} hours${args.from ? ` from "${args.from}"` : ""}.`;
        return { ok: true, family: "ok", text: t, corpusText: t, logLine: `Read Gmail's inbox over IMAP — ${t.toLowerCase()} Nothing was marked read.` };
      }
      const lines = r.rows.map((row, i) => rowLine(handles[i], row));
      return {
        ok: true,
        family: "ok",
        text: `${r.rows.length} message${r.rows.length === 1 ? "" : "s"} (inbox, last ${args.since_hours}h${args.unread_only ? ", unread" : ""}):\n${lines.join("\n")}`,
        corpusText: lines.join("\n"),
        logLine: `Read ${r.rows.length} message${r.rows.length === 1 ? "" : "s"} from Gmail over IMAP (imap.gmail.com, your app password) — nothing sent, nothing marked read.`,
      };
    } catch (e) {
      return failure(e, "list recent mail");
    }
  },
};

const search: ToolSpec = {
  writes: false,
  def: {
    type: "function",
    function: {
      name: "gmail_search",
      description: "Search Gmail with Gmail's own search syntax (e.g. from:jane has:attachment newer_than:7d invoice).",
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
  params: z.object({ query: z.string().min(1), limit: z.coerce.number().int().min(1).max(25).default(15) }),
  async run(args, ctx) {
    if (!account()) return NOT_CONNECTED;
    ctx.runNote(`Searching Gmail for "${args.query}"…`);
    try {
      const r = await op<{ rows: Row[] }>("search", args);
      const handles = remember(ctx, r.rows);
      if (r.rows.length === 0) {
        const t = `No messages match "${args.query}".`;
        return { ok: true, family: "ok", text: t, corpusText: t, logLine: `Searched Gmail for "${args.query}" — no matches.` };
      }
      const lines = r.rows.map((row, i) => rowLine(handles[i], row));
      return {
        ok: true,
        family: "ok",
        text: `${r.rows.length} match${r.rows.length === 1 ? "" : "es"} for "${args.query}":\n${lines.join("\n")}`,
        corpusText: lines.join("\n"),
        logLine: `Searched Gmail for "${args.query}" over IMAP — ${r.rows.length} match${r.rows.length === 1 ? "" : "es"}. Nothing marked read.`,
      };
    } catch (e) {
      return failure(e, "search mail");
    }
  },
};

const read: ToolSpec = {
  writes: false,
  def: {
    type: "function",
    function: {
      name: "gmail_read",
      description: "Read one Gmail message in full (from, to, date, subject, body, attachment names) by its short id from a previous listing, e.g. g2.",
      parameters: { type: "object", properties: { id: { type: "string", description: "short id like g2" } }, required: ["id"] },
    },
  },
  params: z.object({ id: z.string().min(1) }),
  async run(args, ctx) {
    if (!account()) return NOT_CONNECTED;
    const uid = resolve(ctx, String(args.id));
    if (uid === null) {
      return {
        ok: false,
        family: "on_purpose",
        text: `There is no message ${args.id} in this run — list messages first (gmail_recent or gmail_search) and use one of the ids it returns.`,
        logLine: `Asked for message ${args.id} before any listing — refused.`,
      };
    }
    try {
      const m = await op<{ id: number; from: string; address: string; to: string; cc: string; date: string; subject: string; attachments: string[]; body: string }>("read", { uid });
      if (m.address) {
        const addrs = (ctx.memory.get("gmail.addresses") as Set<string> | undefined) ?? new Set();
        addrs.add(m.address.toLowerCase());
        ctx.memory.set("gmail.addresses", addrs);
      }
      const head = [
        `From: ${m.from}${m.address && m.address !== m.from ? ` <${m.address}>` : ""}`,
        `To: ${m.to}`,
        m.cc ? `Cc: ${m.cc}` : "",
        `Date: ${m.date}`,
        `Subject: ${m.subject}`,
        m.attachments.length ? `Attachments: ${m.attachments.join(", ")}` : "",
      ].filter(Boolean).join("\n");
      const text = `${head}\n\n${m.body}`;
      return {
        ok: true,
        family: "ok",
        text,
        corpusText: text,
        logLine: `Read the message "${m.subject}" from Gmail over IMAP — ${m.body.length.toLocaleString()} characters. Nothing marked read.`,
      };
    } catch (e) {
      return failure(e, "open that message");
    }
  },
};

const draft: ToolSpec = {
  writes: true,
  def: {
    type: "function",
    function: {
      name: "gmail_draft",
      description: "Save a DRAFT in Gmail's Drafts folder — never sends. Either reply to a message by its short id (reply_to) or start a new draft with to + subject. The person presses Send in Gmail.",
      parameters: {
        type: "object",
        properties: {
          reply_to: { type: "string", description: "short id like g2 to reply to" },
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
    if (!account()) return NOT_CONNECTED;
    const payload: Record<string, unknown> = { body: args.body };
    if (args.reply_to) {
      const uid = resolve(ctx, String(args.reply_to));
      if (uid === null) {
        return {
          ok: false,
          family: "on_purpose",
          text: `There is no message ${args.reply_to} in this run to reply to — list messages first.`,
          logLine: `Asked to reply to ${args.reply_to} before any listing — refused.`,
        };
      }
      payload.reply_to = uid;
    } else {
      const to = String(args.to ?? "").trim().toLowerCase();
      const seen = (ctx.memory.get("gmail.addresses") as Set<string> | undefined) ?? new Set([account().toLowerCase()]);
      const inputs = (ctx.memory.get("inputs.values") as string[] | undefined) ?? [];
      const known = to && (seen.has(to) || to === account().toLowerCase() || inputs.some((v) => v.toLowerCase().includes(to)));
      if (!known) {
        return {
          ok: false,
          family: "on_purpose",
          text: "Refused — I only address drafts to people this run actually read from, to you, or to an address the person typed as a fill-in. Reply to a listed message with reply_to instead.",
          logLine: `Refused to address a draft to "${to || "(nobody)"}" — not seen in this run.`,
        };
      }
      payload.to = to;
      payload.subject = args.subject ?? "";
    }
    ctx.runNote("Saving a draft in Gmail…");
    try {
      const d = await op<{ to: string; subject: string }>("draft", payload);
      const line = `Draft saved in your Gmail Drafts: "${d.subject}" to ${d.to} — you press Send there. Nothing was sent.`;
      return {
        ok: true,
        family: "ok",
        text: line,
        corpusText: line,
        logLine: `Saved a draft "${d.subject}" to ${d.to} in Gmail's Drafts over IMAP — nothing sent.`,
        handoff: {
          kind: "gmail_draft",
          label: "Open Gmail Drafts",
          caption: "Saved in your Gmail Drafts — you press Send there.",
          ref: "https://mail.google.com/mail/#drafts",
          to: d.to,
          subject: d.subject,
        },
      };
    } catch (e) {
      return failure(e, "save the draft");
    }
  },
};

const saveAttachment: ToolSpec = {
  writes: false,
  def: {
    type: "function",
    function: {
      name: "gmail_save_attachment",
      description:
        "Save an attachment from a Gmail message (by its short id, e.g. g2) into this automation's folder so other tools (like ocr_pdf) can work on it. Optionally name which attachment.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "short id like g2 from a listing" },
          name: { type: "string", description: "part of the attachment filename, if there are several" },
        },
        required: ["id"],
      },
    },
  },
  params: z.object({ id: z.string().min(1), name: z.string().optional().nullable() }),
  async run(args, ctx) {
    if (!account()) return NOT_CONNECTED;
    if (!ctx.writeSandboxFile) {
      return {
        ok: false,
        family: "on_purpose",
        text: "This automation has no folder to save into — give it a folder in files first.",
        logLine: "gmail_save_attachment: no sandbox to write to.",
      };
    }
    const uid = resolve(ctx, String(args.id));
    if (uid === null) {
      return {
        ok: false,
        family: "on_purpose",
        text: `There is no message ${args.id} in this run — list messages first (gmail_recent/gmail_search).`,
        logLine: `gmail_save_attachment: ${args.id} before any listing — refused.`,
      };
    }
    ctx.runNote("Saving the attachment…");
    try {
      const r = await op<{ name: string; bytes_b64: string; size: number; count: number }>("save_attachment", {
        uid,
        ...(args.name ? { name: args.name } : {}),
      });
      const bin = atob(r.bytes_b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const safeName = r.name.replace(/[\\/:*?"<>|]/g, "_") || "attachment";
      const written = await ctx.writeSandboxFile(safeName, bytes);
      if (!written) {
        return { ok: false, family: "broke", text: `Couldn't save ${safeName} into the automation's folder.`, logLine: "gmail_save_attachment: write failed." };
      }
      const line = `Saved "${r.name}" (${(r.size / 1024).toFixed(0)} KB) from message ${args.id} into ${written}.`;
      return {
        ok: true,
        family: "ok",
        text: `${line} You can now clean or read it.`,
        corpusText: line,
        logLine: `gmail_save_attachment: wrote ${safeName} (${r.size} bytes) into the sandbox. Nothing sent.`,
      };
    } catch (e) {
      const s = String(e);
      if (s.includes("NoAttachment")) return { ok: false, family: "on_purpose", text: `Message ${args.id} has no attachment${args.name ? ` matching "${args.name}"` : ""}.`, logLine: "gmail_save_attachment: no attachment." };
      if (s.includes("TooBig")) return { ok: false, family: "on_purpose", text: "That attachment is over 25 MB — too big to bring in.", logLine: "gmail_save_attachment: too big." };
      return failure(e, "save the attachment");
    }
  },
};

export const gmailConnector: Connector = {
  id: "gmail",
  label: "Gmail",
  blurb:
    "Reads your Gmail inbox over IMAP with an app password you paste once — no Google sign-in screens, no developer setup. Saves drafts into Gmail's Drafts and can save attachments into your folders; never sends; never marks mail as read.",
  tools: [recent, search, read, draft, saveAttachment],
  menuLine:
    "gmail_recent{since_hours?, unread_only?, from?, limit?} · gmail_search{query} · gmail_read{id} · gmail_draft{reply_to|to+subject, body} · gmail_save_attachment{id, name?} — reads Gmail mail; saves drafts and attachments; never sends.",
  async status() {
    const addr = account();
    if (!addr) return { state: "needs_allow", detail: "Not connected — paste a Gmail app password." };
    if (!(await gmailHasPassword())) return { state: "needs_allow", detail: `${addr} — app password missing.` };
    return { state: "ready", detail: `Connected as ${addr} · reads over IMAP, drafts only.` };
  },
};
