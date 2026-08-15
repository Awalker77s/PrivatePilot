// fetch_page: defuddle + the webview's own DOM parsing → clean text, with
// @mozilla/readability as fallback. Limits in order: 15s timeout, refuse
// non-text Content-Types, 2 MB body cap, ~24k char trim. The fence check
// (hostname ∈ sources) runs BEFORE any fetch. 403 = identity rejection,
// never retry; 429 honors Retry-After.
import { fetch } from "@tauri-apps/plugin-http";

const BODY_CAP = 2 * 1024 * 1024;
const TEXT_CAP = 24_000;

export interface FetchOutcome {
  ok: boolean;
  text: string; // extracted text, or the designed refusal sentence
  sentence: string | null; // designed sentence when stopped
  family: "ok" | "on_purpose" | "broke";
  logLine: string;
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
  // the network (URL parsing would punycode it into gibberish).
  if (/\s|%20/.test(url.trim()) || !/^[a-z0-9.:/?#&=_%+~-]+$/i.test(url.trim())) {
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

  // Search results pages only answer in a real browser — reroute the model
  // to the rendered reader instead of wasting a raw fetch.
  if (SEARCH_ENGINES.some((s) => host === s || host.endsWith(`.${s}`))) {
    const sentence = `${host} only answers in a real browser — use read_page for this URL instead (or fetch a data API directly; stock prices: https://query1.finance.yahoo.com/v8/finance/chart/TSLA?range=1d&interval=1d).`;
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
    res = await fetch(full, {
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
    return { ok: false, text: sentence, sentence, family: "broke", logLine: sentence };
  }

  if (res.status === 403) {
    const sentence = `${host} turned the request away (403). Some sites don't talk to programs.`;
    return {
      ok: false,
      text: sentence,
      sentence,
      family: "on_purpose",
      logLine: sentence,
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
    };
  }
  if (!res.ok) {
    const sentence = `${host} answered with an error (${res.status}).`;
    return { ok: false, text: sentence, sentence, family: "broke", logLine: sentence };
  }

  const ctype = res.headers.get("Content-Type") ?? "";
  const isText =
    /text\/|application\/(json|xml|xhtml|rss|atom)/i.test(ctype) || ctype === "";
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
    text = body;
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
  return {
    ok: true,
    text: trimmed,
    sentence: null,
    family: "ok",
    logLine: `Fetched ${host} — kept ${trimmed.length.toLocaleString()} characters.`,
  };
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
