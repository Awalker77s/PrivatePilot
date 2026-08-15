// The starter gallery: curated automation records rendered by the exact
// same UI as user-compiled ones — proving compiled-truth-only by
// construction. Hand-written, guaranteed valid, one fenced hostname each,
// every endpoint live-verified. One click saves and runs it.
import type { AutomationRecord } from "../storage/types";
import { newId } from "../storage/stores";

export interface Starter {
  row: "Instant answers" | "Every morning";
  teaches: string; // the one concept this starter demonstrates
  record: Omit<AutomationRecord, "id">;
}

const base = {
  inputs: [],
  outputs: [],
  files: { reads: [], writes: [] },
  formats: {},
  delivers: "answer" as const,
  model: "qwen3.5:9b",
  effort: "quick" as const,
  compiledBy: "starter gallery",
  lastRun: null,
};

export const STARTERS: Starter[] = [
  {
    row: "Instant answers",
    teaches: "an instant answer",
    record: {
      ...base,
      name: "Solana price",
      sentence: "Checks the live Solana price on CoinGecko and answers here.",
      category: "Money",
      steps: [
        "GET https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true",
        "Answer with the price and the 24-hour change",
      ],
      outputs: [{ name: "price" }],
      sources: ["api.coingecko.com"],
      schedule: { trigger: "manual" },
    },
  },
  {
    row: "Instant answers",
    teaches: "a fill-in blank",
    record: {
      ...base,
      name: "Weather tomorrow",
      sentence: "Looks up tomorrow's weather for a city you name.",
      category: "Web",
      steps: [
        "GET https://geocoding-api.open-meteo.com/v1/search?name={city}&count=1 to find the coordinates",
        "GET https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=2",
        "Answer with tomorrow's high, low, and rain chance in plain words",
      ],
      inputs: [{ name: "city", label: "Which city", example: "Orlando" }],
      sources: ["geocoding-api.open-meteo.com", "api.open-meteo.com"],
      schedule: { trigger: "manual" },
    },
  },
  {
    row: "Instant answers",
    teaches: "a summary",
    record: {
      ...base,
      name: "Tech news gist",
      sentence: "Reads the top ten Hacker News stories and lists them clearly.",
      category: "Notes",
      steps: [
        "GET https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=10",
        "List the top ten stories, one item per line",
      ],
      sources: ["hn.algolia.com"],
      schedule: { trigger: "manual" },
    },
  },
  {
    row: "Instant answers",
    teaches: "a stock quote",
    record: {
      ...base,
      name: "Tesla stock price",
      sentence: "Checks Tesla's current stock price and previous close.",
      category: "Money",
      steps: [
        "GET https://query1.finance.yahoo.com/v8/finance/chart/TSLA?interval=1d&range=1d",
        "Answer with the current price and previous close",
      ],
      outputs: [{ name: "price" }],
      sources: ["query1.finance.yahoo.com"],
      schedule: { trigger: "manual" },
    },
  },
  {
    row: "Instant answers",
    teaches: "sports headlines",
    record: {
      ...base,
      name: "Sports headlines",
      sentence: "Pulls today's top sports headlines and lists them clearly.",
      category: "Notes",
      steps: [
        "GET https://news.google.com/rss/search?q=sports&hl=en-US&gl=US&ceid=US:en",
        "List the top ten headlines, one item per line",
      ],
      sources: ["news.google.com"],
      schedule: { trigger: "manual" },
    },
  },
  {
    row: "Instant answers",
    teaches: "another service check",
    record: {
      ...base,
      name: "Discord status",
      sentence: "Checks Discord's public status page for outages.",
      category: "Watch",
      steps: [
        "GET https://discordstatus.com/api/v2/status.json",
        "Answer with the public status description",
      ],
      sources: ["discordstatus.com"],
      schedule: { trigger: "manual" },
    },
  },
  {
    row: "Instant answers",
    teaches: "AI headlines",
    record: {
      ...base,
      name: "AI headlines",
      sentence: "Pulls today's top artificial-intelligence headlines.",
      category: "Notes",
      steps: [
        "GET https://news.google.com/rss/search?q=artificial+intelligence&hl=en-US&gl=US&ceid=US:en",
        "List the top ten headlines, one item per line",
      ],
      sources: ["news.google.com"],
      schedule: { trigger: "manual" },
    },
  },
  {
    row: "Instant answers",
    teaches: "a status check",
    record: {
      ...base,
      name: "Is GitHub down",
      sentence: "Asks GitHub's status page whether everything is running.",
      category: "Watch",
      steps: [
        "GET https://www.githubstatus.com/api/v2/status.json",
        "Answer with the status description",
      ],
      sources: ["www.githubstatus.com"],
      schedule: { trigger: "manual" },
    },
  },
  {
    row: "Every morning",
    teaches: "a schedule",
    record: {
      ...base,
      name: "Bitcoin each morning",
      sentence:
        "Every morning at 8, checks the Bitcoin price and 24-hour change.",
      category: "Money",
      steps: [
        "GET https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
        "Answer with the price and the 24-hour change",
      ],
      outputs: [{ name: "price" }],
      sources: ["api.coingecko.com"],
      schedule: { trigger: "daily", hour: 8 },
    },
  },
  {
    row: "Every morning",
    teaches: "a daily stock quote",
    record: {
      ...base,
      name: "Nvidia each morning",
      sentence: "Every morning at 8, checks Nvidia's price and previous close.",
      category: "Money",
      steps: [
        "GET https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=1d&range=1d",
        "Answer with the current price and previous close",
      ],
      outputs: [{ name: "price" }],
      sources: ["query1.finance.yahoo.com"],
      schedule: { trigger: "daily", hour: 8 },
    },
  },
  {
    row: "Every morning",
    teaches: "world headlines",
    record: {
      ...base,
      name: "World news morning",
      sentence: "Every morning at 8, lists the top world-news headlines.",
      category: "Notes",
      steps: [
        "GET https://feeds.bbci.co.uk/news/world/rss.xml",
        "List the top ten headlines, one item per line",
      ],
      sources: ["feeds.bbci.co.uk"],
      schedule: { trigger: "daily", hour: 8 },
    },
  },
  {
    row: "Every morning",
    teaches: "an exchange rate",
    record: {
      ...base,
      name: "Dollar to euro",
      sentence: "Checks how many euros one US dollar buys today.",
      category: "Money",
      steps: [
        "GET https://api.frankfurter.dev/v1/latest?from=USD&to=EUR",
        "Answer with the rate",
      ],
      outputs: [{ name: "rate" }],
      sources: ["api.frankfurter.dev"],
      schedule: { trigger: "daily", hour: 8 },
    },
  },
  {
    row: "Every morning",
    teaches: "news about anything",
    record: {
      ...base,
      name: "Morning headlines",
      sentence: "Each morning, pulls headlines about a topic you pick.",
      category: "Notes",
      steps: [
        "GET https://news.google.com/rss/search?q={topic}&hl=en-US&gl=US&ceid=US:en",
        "Answer with the top five headlines, one line each",
      ],
      inputs: [{ name: "topic", label: "About what", example: "space launches" }],
      sources: ["news.google.com"],
      schedule: { trigger: "daily", hour: 8 },
    },
  },
  {
    row: "Every morning",
    teaches: "a watcher",
    record: {
      ...base,
      name: "Solana watcher",
      sentence:
        "Checks the Solana price every 15 minutes while the app is open.",
      category: "Watch",
      steps: [
        "GET https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        "Answer with the price",
      ],
      outputs: [{ name: "price" }],
      sources: ["api.coingecko.com"],
      schedule: { trigger: "watch", everyMinutes: 15 },
    },
  },
];

export function instantiateStarter(s: Starter): AutomationRecord {
  return { ...s.record, id: newId("auto") };
}
