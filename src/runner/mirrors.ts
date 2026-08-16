// Bot protection is not an answer. When a source turns us away (403, a rate
// limit, a "prove you're human" page), the run used to stop and report the
// refusal. Now it keeps looking: the SAME page through a real browser first,
// then a curated same-data alternative.
//
// Two hard rules, so this never becomes "wander the web":
// - Alternatives come only from the table below — hand-picked, keyless,
//   public endpoints that serve THE SAME FACT (a Bitcoin price is a Bitcoin
//   price whether CoinGecko or Coinbase says it). Never a search result,
//   never a host the model named.
// - Every substitution is said out loud in the run log and carried into the
//   answer, so "where did this number come from" always has an answer.
import { COIN_ALIASES } from "../pipeline/endpoints";

export interface Alternative {
  url: string;
  host: string;
  why: string; // one plain clause for the log: "Coinbase publishes the same spot price"
}

// bitcoin → BTC, from the alias table the compiler already uses.
const SLUG_TO_TICKER: Record<string, string> = Object.fromEntries(
  Object.entries(COIN_ALIASES).map(([ticker, slug]) => [slug, ticker.toUpperCase()])
);
const TICKER_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(COIN_ALIASES).map(([ticker, slug]) => [ticker.toUpperCase(), slug])
);

function coingeckoUrl(slug: string): string {
  return `https://api.coingecko.com/api/v3/simple/price?ids=${slug}&vs_currencies=usd&include_24hr_change=true`;
}
function coinbaseUrl(ticker: string): string {
  return `https://api.coinbase.com/v2/prices/${ticker}-USD/spot`;
}
function krakenUrl(ticker: string): string {
  const pair = ticker.toUpperCase() === "BTC" ? "XBT" : ticker.toUpperCase();
  return `https://api.kraken.com/0/public/Ticker?pair=${pair}USD`;
}
function nasdaqUrl(symbol: string): string {
  return `https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=stocks`;
}
function yahooUrl(symbol: string): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1d`;
}
function googleNewsUrl(topic: string): string {
  return `https://news.google.com/rss/search?q=${topic}&hl=en-US&gl=US&ceid=US:en`;
}
function hnSearchUrl(topic: string): string {
  return `https://hn.algolia.com/api/v1/search?query=${topic}&tags=story&hitsPerPage=10`;
}

/**
 * Same-fact alternatives for a blocked URL, best first. [] when we have no
 * honest substitute — a person's own named site has no mirror, and inventing
 * one would answer a different question than the one asked.
 */
export function alternativesFor(rawUrl: string): Alternative[] {
  let u: URL;
  try {
    u = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
  } catch {
    return [];
  }
  const host = u.hostname.toLowerCase();
  const out: Alternative[] = [];
  const add = (url: string, why: string) => {
    const h = new URL(url).hostname;
    if (h !== host && !out.some((a) => a.host === h)) out.push({ url, host: h, why });
  };

  // ---- crypto spot price (three houses quote the same coin) ----
  if (host === "api.coingecko.com" && u.pathname.includes("/simple/price")) {
    const slug = (u.searchParams.get("ids") ?? "").split(",")[0]?.toLowerCase();
    const ticker = SLUG_TO_TICKER[slug];
    if (ticker) {
      add(coinbaseUrl(ticker), "Coinbase publishes the same spot price");
      add(krakenUrl(ticker), "Kraken publishes the same spot price");
    }
  }
  if (host === "api.coinbase.com") {
    const m = u.pathname.match(/\/v2\/prices\/([A-Za-z]+)-USD\/spot/);
    const ticker = m?.[1]?.toUpperCase();
    const slug = ticker ? TICKER_TO_SLUG[ticker] : undefined;
    if (slug) add(coingeckoUrl(slug), "CoinGecko publishes the same spot price");
    if (ticker) add(krakenUrl(ticker), "Kraken publishes the same spot price");
  }
  if (host === "api.kraken.com") {
    const pair = (u.searchParams.get("pair") ?? "").toUpperCase();
    const ticker = pair.replace(/USD.*$/, "").replace(/^X/, "");
    const slug = TICKER_TO_SLUG[ticker === "XBT" ? "BTC" : ticker];
    if (slug) add(coingeckoUrl(slug), "CoinGecko publishes the same spot price");
  }

  // ---- currency rates ----
  if (host === "api.frankfurter.dev") {
    const from = u.searchParams.get("from") ?? "USD";
    add(
      `https://open.er-api.com/v6/latest/${from.toUpperCase()}`,
      "the open exchange-rate API quotes the same pair"
    );
  }
  if (host === "open.er-api.com") {
    const m = u.pathname.match(/\/v6\/latest\/([A-Za-z]{3})/);
    if (m)
      add(
        `https://api.frankfurter.dev/v1/latest?from=${m[1].toUpperCase()}`,
        "Frankfurter quotes the same pair"
      );
  }

  // ---- US stock quote ----
  if (host === "api.nasdaq.com") {
    const m = u.pathname.match(/\/api\/quote\/([A-Za-z.\-]+)\//);
    if (m) add(yahooUrl(m[1].toUpperCase()), "Yahoo Finance carries the same quote");
  }
  if (host === "query1.finance.yahoo.com") {
    // /v8/finance/chart/TSLA and the older /v7/finance/quote?symbols=TSLA —
    // v7 answers 401 to programs now, which is exactly when this matters.
    const m = u.pathname.match(/\/v\d\/finance\/chart\/([A-Za-z.\-]+)/);
    const symbol = m?.[1] ?? (u.searchParams.get("symbols") ?? "").split(",")[0];
    if (symbol) add(nasdaqUrl(symbol.toUpperCase()), "Nasdaq carries the same quote");
  }

  // ---- news on a topic ----
  if (host === "news.google.com" && u.pathname.startsWith("/rss/search")) {
    const topic = u.searchParams.get("q");
    if (topic) {
      add(hnSearchUrl(encodeURIComponent(topic)), "Hacker News search covers the same topic");
      add("https://feeds.bbci.co.uk/news/world/rss.xml", "the BBC world feed still carries headlines");
    }
  }
  if (host === "news.google.com" && !u.pathname.startsWith("/rss/search")) {
    add("https://feeds.bbci.co.uk/news/world/rss.xml", "the BBC world feed still carries top headlines");
  }
  if (host === "hn.algolia.com") {
    const topic = u.searchParams.get("query");
    if (topic) add(googleNewsUrl(encodeURIComponent(topic)), "Google News covers the same topic");
  }
  if (host === "feeds.bbci.co.uk") {
    add("https://news.google.com/rss", "Google News carries top headlines too");
  }

  return out;
}

// Hosts this table may ever reach for, given what an automation already
// fetches. Used to widen the fence by exactly these and nothing else.
export function mirrorHostsFor(sources: string[]): string[] {
  const probes: Record<string, string> = {
    "api.coingecko.com": coingeckoUrl("bitcoin"),
    "api.coinbase.com": coinbaseUrl("BTC"),
    "api.nasdaq.com": nasdaqUrl("TSLA"),
    "query1.finance.yahoo.com": yahooUrl("TSLA"),
    "news.google.com": googleNewsUrl("test"),
    "api.kraken.com": krakenUrl("BTC"),
    "api.frankfurter.dev": "https://api.frankfurter.dev/v1/latest?from=USD&to=EUR",
    "open.er-api.com": "https://open.er-api.com/v6/latest/USD",
    "hn.algolia.com": hnSearchUrl("test"),
    "feeds.bbci.co.uk": "https://feeds.bbci.co.uk/news/world/rss.xml",
  };
  const out = new Set<string>();
  for (const s of sources) {
    const probe = probes[s.toLowerCase()];
    if (!probe) continue;
    for (const alt of alternativesFor(probe)) out.add(alt.host);
  }
  for (const s of sources) out.delete(s.toLowerCase());
  return [...out];
}
