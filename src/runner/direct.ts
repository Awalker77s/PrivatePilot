import type { AutomationRecord } from "../storage/types";
import { activeLocalModel, chat } from "../providers";
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
    // Blocked is not the end of the road — but this fast path parses ONE
    // known response shape, so it can't read a stand-in source itself.
    // Returning null hands the job to the model tool loop, which walks the
    // browser-then-mirror ladder and can read whatever comes back.
    if (fetched.blocked) return null;
    throw new DirectEndpointError(
      fetched.sentence ?? "The verified data source did not return an answer."
    );
  }

  try {
    let secondaryBody: Record<string, unknown> | undefined;
    let secondaryCorpus = "";
    const logLines = [fetched.logLine];
    if (kind === "nasdaq") {
      const summaryUrl = url.replace(/\/info(\?|$)/, "/summary$1");
      const summary = await fetchPage(summaryUrl, record.sources);
      if (!summary.ok) {
        if (summary.blocked) return null; // let the resilient loop have it
        throw new DirectEndpointError(
          summary.sentence ?? "Nasdaq did not return the stock summary."
        );
      }
      secondaryBody = JSON.parse(summary.text) as Record<string, unknown>;
      secondaryCorpus = `\n\n=== ${summaryUrl} ===\n${summary.text}`;
      logLines.push(summary.logLine);
    }
    const editorial = record.steps.some((step) =>
      /\b(Themes|Most important) section\b/i.test(step)
    );
    const answer = editorial && (kind === "hackernews" || kind === "rss")
      ? await formatEditorialAnswer(record, kind, fetched.text, url)
      : kind === "rss"
        ? formatFeedAnswer(fetched.text, record.name)
        : formatAnswer(
              kind,
              JSON.parse(fetched.text) as Record<string, unknown>,
              new URL(url).hostname,
              url,
              secondaryBody
            );
    if (!answer) return null;
    return {
      answer,
      corpus: `=== ${url} ===\n${fetched.text}${secondaryCorpus}`,
      logLines: [
        ...logLines,
        editorial
          ? "Used one focused local pass to turn the verified headlines into a briefing."
          : "Read the verified endpoint directly — no model turn needed.",
      ],
    };
  } catch (error) {
    if (error instanceof DirectEndpointError) throw error;
    // A response this reader can't parse is not a broken run — it's a page
    // the fast path doesn't understand. Fall back to the model tool loop,
    // which can read it (or fail with its own designed sentence).
    return null;
  }
}

async function formatEditorialAnswer(
  record: AutomationRecord,
  kind: "hackernews" | "rss",
  fetchedText: string,
  url: string
): Promise<string> {
  const count = Math.max(
    3,
    Math.min(20, Number(new URL(url).searchParams.get("hitsPerPage") ?? 10))
  );
  let source: string;
  let headlineList: string | null;
  let titleOptions: string[] = [];
  if (kind === "hackernews") {
    const body = JSON.parse(fetchedText) as { hits?: unknown[] };
    headlineList = formatAnswer(
      "hackernews",
      body as Record<string, unknown>,
      new URL(url).hostname,
      url
    );
    const compactHits = (body.hits ?? []).slice(0, count).map((raw) => {
        const hit = raw as {
          title?: unknown;
          url?: unknown;
          story_url?: unknown;
          points?: unknown;
        };
        return {
          title: hit.title,
          url: hit.url ?? hit.story_url,
          points: hit.points,
        };
      });
    titleOptions = compactHits
      .map((hit) => hit.title)
      .filter((title): title is string => typeof title === "string");
    source = JSON.stringify(compactHits);
  } else {
    headlineList = formatFeedAnswer(fetchedText, record.name);
    source = fetchedText.split("\n").slice(0, count * 2 + 2).join("\n");
  }

  const model = await activeLocalModel();
  if (!model) {
    throw new DirectEndpointError(
      "The local AI isn't running — start Ollama, then try again."
    );
  }
  const requirements = record.steps
    .filter((step) => /\b(Themes|Most important) section\b/i.test(step))
    .join("\n- ");
  const importantCount = Math.max(
    1,
    Math.min(5, Number(requirements.match(/Most important section with the (\d+)/i)?.[1] ?? 2))
  );
  const themeCount = Math.max(
    1,
    Math.min(5, Number(requirements.match(/Themes section covering the (\d+)/i)?.[1] ?? 3))
  );
  const result = await chat({
    model,
    messages: [
      {
        role: "system",
        content:
          "Select important headlines and name recurring themes using only the verified titles and points. Never add performance claims, costs, causes, or other facts absent from a title. Keep every explanation under 14 words.",
      },
      {
        role: "user",
        content: `Job: ${record.sentence}\nRequirements:\n- ${requirements}\n\nVerified headlines:\n${source}`,
      },
    ],
    format: {
      type: "object",
      properties: {
        important: {
          type: "array",
          minItems: importantCount,
          maxItems: importantCount,
          items: {
            type: "object",
            properties: {
              title: titleOptions.length
                ? { type: "string", enum: titleOptions }
                : { type: "string" },
              why: { type: "string" },
            },
            required: ["title", "why"],
            additionalProperties: false,
          },
        },
        themes: {
          type: "array",
          minItems: themeCount,
          maxItems: themeCount,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              summary: { type: "string" },
            },
            required: ["name", "summary"],
            additionalProperties: false,
          },
        },
      },
      required: ["important", "themes"],
      additionalProperties: false,
    },
    options: {
      num_ctx: 4096,
      temperature: 0,
      top_p: 0.9,
      top_k: 20,
      max_tokens: 256,
    },
    think: false,
  });
  let parsed: {
    important: { title: string; why: string }[];
    themes: { name: string; summary: string }[];
  };
  try {
    parsed = JSON.parse(result.content) as typeof parsed;
  } catch {
    throw new DirectEndpointError(
      "The local AI returned an unreadable briefing — try again."
    );
  }
  const short = (value: string) =>
    value.trim().split(/\s+/).slice(0, 14).join(" ").replace(/[,:;]$/, "");
  const analysis = [
    "## Most important",
    ...parsed.important
      .slice(0, importantCount)
      .map((item) => `- **${item.title}** — ${short(item.why)}`),
    "",
    "## Themes",
    ...parsed.themes
      .slice(0, themeCount)
      .map((item) => `- **${short(item.name)}** — ${short(item.summary)}`),
  ].join("\n");
  const briefing = headlineList ? `${headlineList}\n\n${analysis}` : analysis;
  const output = record.outputs[0]?.name;
  if (!output) return briefing;
  const baton = (titleOptions.length ? titleOptions.join(" | ") : source)
    .replace(/;/g, ",")
    .replace(/\s*\n\s*/g, " | ")
    .slice(0, 2_000);
  return `${briefing}\n\nOUTPUTS: ${output}=${baton}`;
}

type DirectKind =
  | "status"
  | "coingecko"
  | "coinbase"
  | "frankfurter"
  | "yahoo"
  | "nasdaq"
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
    parsed.hostname === "api.nasdaq.com" &&
    parsed.pathname.endsWith("/info")
  ) {
    return "nasdaq";
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
  url: string,
  secondaryBody?: Record<string, unknown>
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

  if (kind === "nasdaq") {
    const data = body.data as
      | {
          symbol?: unknown;
          companyName?: unknown;
          marketStatus?: unknown;
          primaryData?: {
            lastSalePrice?: unknown;
            netChange?: unknown;
            percentageChange?: unknown;
            deltaIndicator?: unknown;
            lastTradeTimestamp?: unknown;
          };
        }
      | undefined;
    const summaryData = (
      secondaryBody?.data as
        | { summaryData?: Record<string, { value?: unknown }> }
        | undefined
    )?.summaryData;
    const priceText = data?.primaryData?.lastSalePrice;
    const previousText = summaryData?.PreviousClose?.value;
    const parseMoney = (value: unknown) =>
      Number(String(value ?? "").replace(/[$,+%]/g, "").replace(/,/g, ""));
    const price = parseMoney(priceText);
    const previous = parseMoney(previousText);
    if (!Number.isFinite(price)) return null;
    const symbol = typeof data?.symbol === "string" ? data.symbol : "Stock";
    const name =
      typeof data?.companyName === "string" ? data.companyName : symbol;
    const net = data?.primaryData?.netChange;
    const percent = data?.primaryData?.percentageChange;
    const direction = data?.primaryData?.deltaIndicator === "down" ? "down" : "up";
    const market =
      typeof data?.marketStatus === "string" ? data.marketStatus : null;
    const traded =
      typeof data?.primaryData?.lastTradeTimestamp === "string"
        ? data.primaryData.lastTradeTimestamp
        : null;
    return [
      `## ${name} (${symbol})`,
      "",
      `Price: **$${compactNumber(price)}**`,
      ...(Number.isFinite(previous)
        ? [`Previous close: $${compactNumber(previous)}`]
        : []),
      ...(typeof net === "string" && typeof percent === "string"
        ? [`Daily move: ${direction} ${net.replace(/^[-+]/, "")} (${percent.replace(/^[-+]/, "")})`]
        : []),
      ...(market ? [`Market: ${market}`] : []),
      ...(traded ? [`Last trade: ${traded}`] : []),
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
