import type { AutomationRecord } from "../storage/types";
import { fetchPage } from "./fetchPage";

export interface DirectOutcome {
  answer: string;
  corpus: string;
  logLines: string[];
}

export class DirectEndpointError extends Error {
  constructor(public sentence: string) {
    super(sentence);
  }
}

function firstUrl(record: AutomationRecord): string | null {
  for (const step of record.steps) {
    const match = step.match(/https?:\/\/[^\s]+/);
    if (match) return match[0].replace(/[),.;]+$/, "");
  }
  return null;
}

function titleWords(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function compactNumber(value: number, maximumFractionDigits = 4): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
  }).format(value);
}

// Known endpoints have stable response shapes and need no agentic decision.
// Fetch them through the same per-record source fence, then format only values
// read from the response. Unknown pages fall back to the model tool loop.
export async function runDirectEndpoint(
  record: AutomationRecord
): Promise<DirectOutcome | null> {
  const url = firstUrl(record);
  if (!url) return null;

  const kind = directKind(url);
  if (!kind) return null;
  const fetched = await fetchPage(url, record.sources);
  if (!fetched.ok) {
    throw new DirectEndpointError(
      fetched.sentence ?? "The verified data source did not return an answer."
    );
  }

  try {
    const answer =
      kind === "rss"
        ? formatFeedAnswer(fetched.text, record.name)
        : formatAnswer(
            kind,
            JSON.parse(fetched.text) as Record<string, unknown>,
            new URL(url).hostname,
            url
          );
    if (!answer) return null;
    return {
      answer,
      corpus: `=== ${url} ===\n${fetched.text}`,
      logLines: [fetched.logLine, "Read the verified endpoint directly — no model turn needed."],
    };
  } catch (error) {
    if (error instanceof DirectEndpointError) throw error;
    // A response this reader can't parse is not a broken run — it's a page
    // the fast path doesn't understand. Fall back to the model tool loop,
    // which can read it (or fail with its own designed sentence).
    return null;
  }
}

type DirectKind =
  | "status"
  | "coingecko"
  | "coinbase"
  | "frankfurter"
  | "yahoo"
  | "hackernews"
  | "rss";

function directKind(url: string): DirectKind | null {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("/api/v2/status.json")) return "status";
  if (parsed.hostname === "api.coingecko.com" && parsed.pathname.includes("/simple/price")) {
    return "coingecko";
  }
  if (parsed.hostname === "api.coinbase.com" && parsed.pathname.includes("/v2/prices/")) {
    return "coinbase";
  }
  if (parsed.hostname === "api.frankfurter.dev" && parsed.pathname.includes("/v1/latest")) {
    return "frankfurter";
  }
  if (
    (parsed.hostname === "query1.finance.yahoo.com" ||
      parsed.hostname === "query2.finance.yahoo.com") &&
    parsed.pathname.includes("/v8/finance/chart/")
  ) {
    return "yahoo";
  }
  if (
    parsed.hostname === "hn.algolia.com" &&
    parsed.pathname.includes("/api/v1/search")
  ) {
    return "hackernews";
  }
  if (
    parsed.hostname === "news.google.com" ||
    parsed.hostname === "feeds.bbci.co.uk"
  ) {
    return "rss";
  }
  return null;
}

function formatAnswer(
  kind: DirectKind,
  body: Record<string, unknown>,
  hostname: string,
  url: string
): string | null {
  if (kind === "status") {
    const status = body.status as { description?: unknown } | undefined;
    if (typeof status?.description !== "string") return null;
    const service = hostname.includes("github")
      ? "GitHub"
      : hostname.includes("discord")
        ? "Discord"
        : hostname.includes("cloudflare")
          ? "Cloudflare"
          : hostname.includes("openai")
            ? "OpenAI"
            : hostname.includes("anthropic")
              ? "Anthropic"
              : "The service";
    return `${service} status page reports "${status.description}".`;
  }

  if (kind === "coingecko") {
    const coin = Object.keys(body)[0];
    const values = body[coin] as
      | { usd?: unknown; usd_24h_change?: unknown }
      | undefined;
    if (!coin || typeof values?.usd !== "number") return null;
    const price = values.usd;
    const change = values.usd_24h_change;
    const changeSentence =
      typeof change === "number"
        ? ` It is ${change >= 0 ? "up" : "down"} ${Math.abs(change).toFixed(2)}% over 24 hours.`
        : "";
    return `${titleWords(coin)} is $${compactNumber(price)}.${changeSentence} OUTPUTS: price=${price}`;
  }

  if (kind === "coinbase") {
    const data = body.data as { base?: unknown; amount?: unknown } | undefined;
    const amount = Number(data?.amount);
    if (!Number.isFinite(amount)) return null;
    const asset = typeof data?.base === "string" ? data.base : "The asset";
    return `${asset} is $${compactNumber(amount)}. OUTPUTS: price=${amount}`;
  }

  if (kind === "yahoo") {
    const chart = body.chart as
      | {
          result?: {
            meta?: {
              symbol?: unknown;
              shortName?: unknown;
              longName?: unknown;
              currency?: unknown;
              regularMarketPrice?: unknown;
              previousClose?: unknown;
              chartPreviousClose?: unknown;
            };
          }[];
          error?: unknown;
        }
      | undefined;
    const meta = chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    const previous = Number(meta?.previousClose ?? meta?.chartPreviousClose);
    if (chart?.error || !Number.isFinite(price)) return null;
    const symbol =
      typeof meta?.symbol === "string"
        ? meta.symbol
        : decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "Stock");
    const name =
      typeof meta?.shortName === "string"
        ? meta.shortName
        : typeof meta?.longName === "string"
          ? meta.longName
          : symbol;
    const currency = typeof meta?.currency === "string" ? meta.currency : "USD";
    const money = (value: number) =>
      currency === "USD"
        ? `$${compactNumber(value, 4)}`
        : `${compactNumber(value, 4)} ${currency}`;
    return [
      `## ${name} (${symbol})`,
      "",
      `Price: **${money(price)}**`,
      ...(Number.isFinite(previous) ? [`Previous close: ${money(previous)}`] : []),
      "",
      `OUTPUTS: price=${price}`,
    ].join("\n");
  }

  if (kind === "hackernews") {
    const hits = Array.isArray(body.hits) ? body.hits : [];
    const limit = Math.max(
      1,
      Math.min(20, Number(new URL(url).searchParams.get("hitsPerPage") ?? 10))
    );
    const topic = new URL(url).searchParams.get("query");
    const stories = hits
      .slice(0, limit)
      .map((raw, i) => {
        const hit = raw as {
          title?: unknown;
          url?: unknown;
          story_url?: unknown;
          objectID?: unknown;
        };
        if (typeof hit.title !== "string" || !hit.title.trim()) return null;
        const storyUrl =
          typeof hit.url === "string"
            ? hit.url
            : typeof hit.story_url === "string"
              ? hit.story_url
              : typeof hit.objectID === "string"
                ? `https://news.ycombinator.com/item?id=${hit.objectID}`
                : null;
        // Spec shape: numbered, bold title, publisher-name link at the END —
        // a linked headline hides the destination; the domain is the trust
        // signal.
        let publisher = "news.ycombinator.com";
        try {
          if (storyUrl) publisher = new URL(storyUrl).hostname.replace(/^www\./, "");
        } catch {
          /* keep default */
        }
        return `${i + 1}. **${hit.title.trim()}**${storyUrl ? ` ([${publisher}](${storyUrl}))` : ""}`;
      })
      .filter((story): story is string => !!story);
    if (stories.length === 0) return null;
    const what = topic ? `stories about ${topic}` : "tech stories";
    return `Here are today's top ${stories.length} ${what} from Hacker News:\n\n${stories.join("\n")}`;
  }

  const base = typeof body.base === "string" ? body.base : null;
  const rates = body.rates as Record<string, unknown> | undefined;
  const quote = rates ? Object.keys(rates)[0] : null;
  const rate = quote ? Number(rates?.[quote]) : Number.NaN;
  if (!base || !quote || !Number.isFinite(rate)) return null;
  return `One ${base} buys ${compactNumber(rate, 6)} ${quote}. OUTPUTS: rate=${rate}`;
}

function formatFeedAnswer(text: string, recordName: string): string | null {
  const items = text.replace(/^Feed headlines:\s*/i, "").trim();
  if (!items || !/^[-*]\s+/m.test(items)) return null;
  return `## ${recordName}\n\n${items}`;
}
