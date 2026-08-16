// fetch_page: defuddle + the webview's own DOM parsing → clean text, with
// @mozilla/readability as fallback. Limits in order: 15s timeout, refuse
// non-text Content-Types, 2 MB body cap, ~24k char trim. The fence check
// (hostname ∈ sources) runs BEFORE any fetch. 403 = identity rejection,
// never retry; 429 honors Retry-After.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isDesktopApp } from "../platform";

const BODY_CAP = 2 * 1024 * 1024;
const TEXT_CAP = 24_000;

export interface FetchOutcome {
  ok: boolean;
  text: string; // extracted text, or the designed refusal sentence
  sentence: string | null; // designed sentence when stopped
  family: "ok" | "on_purpose" | "broke";
  logLine: string;
  // The site pushed us away rather than not having the data: a 403, a rate
  // limit, a human-proof challenge. Worth trying the same fact elsewhere —
  // unlike a fence refusal or a bad URL, where retrying is pointless.
  blocked?: boolean;
}

export function hostnameOf(url: string): string | null {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
  } catch {
    return null;
  }
}

export function fenceAllows(sources: string[], url: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return sources.some((s) => host === s || host.endsWith(`.${s}`));
}

// Is this token a real web address, or a bare phrase? A phrase ("google com
// finance tsla") must never reach the network — URL parsing would punycode it
// into gibberish. But a genuine URL may legally carry commas, brackets,
// semicolons, and %-escapes (including %20) in its path and query — those are
// NOT disqualifying. The test that actually matters: it parses to an http(s)
// URL whose HOST has a dot (or is localhost) and contains no whitespace.
export function looksLikeUrl(raw: string): boolean {
  const s = raw.trim();
  if (/\s/.test(s)) return false; // a real URL token never has a raw space
  const full = s.startsWith("http") ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(full);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (/\s|%20/.test(u.hostname)) return false; // an escaped space in the HOST = a phrase
  return u.hostname === "localhost" || u.hostname.includes(".");
}

const SEARCH_ENGINES = [
  "bing.com",
  "www.bing.com",
  "google.com",
  "www.google.com",
  "duckduckgo.com",
  "search.yahoo.com",
  "search.brave.com",
];

export async function fetchPage(
  url: string,
  sources: string[]
): Promise<FetchOutcome> {
  // A phrase is not an address: "google com finance tsla" must never reach
  // the network (URL parsing would punycode it into gibberish). A real URL
  // with commas/%20/brackets in its query is fine — only the host matters.
  if (!looksLikeUrl(url)) {
    const sentence = `That isn't a web address — fetch_page needs a full URL like https://api.example.com/… (got "${url.slice(0, 60)}").`;
    return {
      ok: false,
      text: sentence,
      sentence,
      family: "on_purpose",
      logLine: sentence,
    };
  }

  const full = url.startsWith("http") ? url : `https://${url}`;
  const host = hostnameOf(full) ?? url;
  const verifiedGoogleNewsFeed =
    host === "news.google.com" && new URL(full).pathname.startsWith("/rss");

  // Search results pages only answer in a real browser — reroute the model
  // to the rendered reader instead of wasting a raw fetch.
  if (
    !verifiedGoogleNewsFeed &&
    SEARCH_ENGINES.some((s) => host === s || host.endsWith(`.${s}`))
  ) {
    const sentence = `${host} only answers in a real browser — use read_page for this URL instead (or fetch a data API directly; stock prices: https://api.nasdaq.com/api/quote/TSLA/info?assetclass=stocks).`;
    return {
      ok: false,
      text: sentence,
      sentence,
      family: "on_purpose",
      logLine: sentence,
    };
  }

  // The fence: enforced in TypeScript, in code we own, before any fetch.
  if (!fenceAllows(sources, full)) {
    const sentence = `Refused — ${host} is not in this automation's sources. Nothing was fetched.`;
    return {
      ok: false,
      text: sentence,
      sentence,
      family: "on_purpose",
      logLine: sentence,
    };
  }

  let res: Response;
  try {
    const request = isDesktopApp()
      ? tauriFetch
      : globalThis.fetch.bind(globalThis);
    res = await request(full, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        // One coherent Chrome-like header set.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (e) {
    const timedOut = String(e).toLowerCase().includes("timeout");
    const sentence = timedOut
      ? `${host} didn't answer within 15 seconds.`
      : `Couldn't reach ${host}.`;
    // Aggressive protection often drops the connection instead of answering
    // 403, and a tarpit just never replies — both look like this. No data
    // came back either way, so the same fact is worth asking for elsewhere.
    return {
      ok: false,
      text: sentence,
      sentence,
      family: "broke",
      logLine: sentence,
      blocked: true,
    };
  }

  if (res.status === 403 || res.status === 401) {
    const sentence = `${host} turned the request away (${res.status}). Some sites don't talk to programs.`;
    return {
      ok: false,
      text: sentence,
      sentence,
      family: "on_purpose",
      logLine: sentence,
      blocked: true,
    };
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    const sentence = `${host} asked us to slow down (429${retryAfter ? `, try again in ${retryAfter}s` : ""}).`;
    return {
      ok: false,
      text: sentence,
      sentence,
      family: "on_purpose",
      logLine: sentence,
      blocked: true,
    };
  }
  if (!res.ok) {
    const sentence = `${host} answered with an error (${res.status}).`;
    // 5xx and the Cloudflare-family codes are the site pushing back, not the
    // data being absent — the same fact may be a mirror away.
    const pushback = res.status >= 500 || res.status === 418 || res.status === 451;
    return {
      ok: false,
      text: sentence,
      sentence,
      family: "broke",
      logLine: sentence,
      blocked: pushback,
    };
  }

  const ctype = res.headers.get("Content-Type") ?? "";
  // Structured-suffix types are the norm in open data: the US National
  // Weather Service answers application/geo+json, the ECB answers
  // application/vnd.sdmx.data+json, feeds answer application/atom+xml.
  // Matching only the bare names turned those into "not a page this tool
  // reads" — a refusal to read JSON because of the label on the envelope.
  const isText =
    ctype === "" ||
    /^text\//i.test(ctype) ||
    /application\/([\w.+-]*\+)?(json|xml)\b/i.test(ctype) ||
    /application\/(rss|atom|xhtml|javascript|x-ndjson|problem)/i.test(ctype);
  if (!isText) {
    const sentence = `${host} sent ${ctype.split(";")[0] || "something"} — not a page this tool reads.`;
    return {
      ok: false,
      text: sentence,
      sentence,
      family: "on_purpose",
      logLine: sentence,
    };
  }

  const raw = await res.text();
  const body = raw.length > BODY_CAP ? raw.slice(0, BODY_CAP) : raw;

  let text: string;
  const trimmedStart = body.trimStart();
  if (/json/i.test(ctype) || trimmedStart.startsWith("{") || trimmedStart.startsWith("[")) {
    // NEVER blind-truncate JSON — a mid-structure cut breaks every consumer
    // (the direct endpoint reader and the model alike). Shrink it instead:
    // long strings clipped, big arrays capped, structure kept valid.
    text = body.length > TEXT_CAP ? shrinkJsonText(body) : body;
  } else if (
    /xml|rss|atom/i.test(ctype) ||
    trimmedStart.startsWith("<?xml") ||
    trimmedStart.includes("<rss")
  ) {
    text = parseFeed(body) ?? (await extractReadable(body, full));
  } else {
    text = await extractReadable(body, full);
  }
  const trimmed = text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text;
  // A challenge page answers 200 and contains no data — Cloudflare's "Just a
  // moment", a JS/cookie demand, a human-proof puzzle. Treating that as a
  // successful fetch hands the model an interstitial to summarize.
  if (CHALLENGE_RE.test(trimmed.slice(0, 1500)) && trimmed.length < 3000) {
    const sentence = `${host} answered with a "prove you're human" page instead of the content.`;
    return {
      ok: false,
      text: sentence,
      sentence,
      family: "on_purpose",
      logLine: sentence,
      blocked: true,
    };
  }
  return {
    ok: true,
    text: trimmed,
    sentence: null,
    family: "ok",
    logLine: `Fetched ${host} — kept ${trimmed.length.toLocaleString()} characters.`,
  };
}

// Interstitials that mean "we blocked you", not "here is the page".
const CHALLENGE_RE =
  /just a moment|checking your browser|enable javascript and cookies|verify you are human|are you a robot|unusual traffic|access denied|attention required|cf-browser-verification|ddos protection by/i;

// Shrink an oversized JSON body while keeping it VALID: clip long string
// values, cap arrays, and re-serialize compactly. Two passes (gentle, then
// harsh); only if both still overflow does the caller's plain slice apply.
function shrinkJsonText(body: string): string {
  const shrink = (value: unknown, maxStr: number, maxArr: number): unknown => {
    if (typeof value === "string")
      return value.length > maxStr ? value.slice(0, maxStr) : value;
    if (Array.isArray(value))
      return value.slice(0, maxArr).map((v) => shrink(v, maxStr, maxArr));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = shrink(v, maxStr, maxArr);
      return out;
    }
    return value;
  };
  try {
    const parsed = JSON.parse(body) as unknown;
    const gentle = JSON.stringify(shrink(parsed, 300, 30));
    if (gentle.length <= TEXT_CAP) return gentle;
    return JSON.stringify(shrink(parsed, 80, 12));
  } catch {
    return body; // not actually parseable — leave it to the plain trim
  }
}

async function extractReadable(html: string, url: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  try {
    const { default: Defuddle } = await import("defuddle");
    const result = new Defuddle(doc, { url, markdown: true }).parse();
    if (result.content && result.content.trim().length > 0) {
      return stripHtml(result.content);
    }
  } catch {
    // fall through to readability
  }
  try {
    const { Readability } = await import("@mozilla/readability");
    const art = new Readability(doc).parse();
    if (art?.textContent) return art.textContent;
  } catch {
    // fall through to raw text
  }
  return doc.body?.textContent ?? "";
}

// RSS/Atom → plain headline lines: "title — link (date)". News for anything.
function parseFeed(xml: string): string | null {
  try {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    if (doc.querySelector("parsererror")) return null;
    const items = [
      ...doc.querySelectorAll("item"),
      ...doc.querySelectorAll("entry"),
    ].slice(0, 10);
    if (items.length === 0) return null;
    const lines = items.map((it) => {
      const title = it.querySelector("title")?.textContent?.trim() ?? "";
      const link =
        it.querySelector("link")?.textContent?.trim() ||
        it.querySelector("link")?.getAttribute("href") ||
        "";
      const date =
        it.querySelector("pubDate, updated, published")?.textContent?.trim() ??
        "";
      return `- ${title}${date ? ` (${date})` : ""}${link ? `\n  ${link}` : ""}`;
    });
    return `Feed headlines:\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

function stripHtml(s: string): string {
  if (!/[<>]/.test(s)) return s;
  const d = new DOMParser().parseFromString(s, "text/html");
  return d.body?.textContent ?? s;
}
