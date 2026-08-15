import type { DraftContext } from "./draft";
import type { WireAutomation, WireDraft } from "./draft/schema";

export interface QuickQuestion {
  asking: string;
  term: string;
  kind: "other";
  options: { label: string; value: string }[];
}

export type QuickCompileMatch =
  | { kind: "draft"; draft: WireDraft; matched: string[] }
  | { kind: "question"; question: QuickQuestion; matched: string[] };

const STOCKS: Record<string, { symbol: string; label: string }> = {
  apple: { symbol: "AAPL", label: "Apple" },
  aapl: { symbol: "AAPL", label: "Apple" },
  tesla: { symbol: "TSLA", label: "Tesla" },
  tsla: { symbol: "TSLA", label: "Tesla" },
  nvidia: { symbol: "NVDA", label: "Nvidia" },
  nvda: { symbol: "NVDA", label: "Nvidia" },
  microsoft: { symbol: "MSFT", label: "Microsoft" },
  msft: { symbol: "MSFT", label: "Microsoft" },
  amazon: { symbol: "AMZN", label: "Amazon" },
  amzn: { symbol: "AMZN", label: "Amazon" },
  meta: { symbol: "META", label: "Meta" },
  google: { symbol: "GOOGL", label: "Alphabet" },
  alphabet: { symbol: "GOOGL", label: "Alphabet" },
  googl: { symbol: "GOOGL", label: "Alphabet" },
  amd: { symbol: "AMD", label: "AMD" },
  netflix: { symbol: "NFLX", label: "Netflix" },
  nflx: { symbol: "NFLX", label: "Netflix" },
};

const COINS: Record<string, { id: string; label: string }> = {
  bitcoin: { id: "bitcoin", label: "Bitcoin" },
  btc: { id: "bitcoin", label: "Bitcoin" },
  ethereum: { id: "ethereum", label: "Ethereum" },
  eth: { id: "ethereum", label: "Ethereum" },
  solana: { id: "solana", label: "Solana" },
  sol: { id: "solana", label: "Solana" },
  dogecoin: { id: "dogecoin", label: "Dogecoin" },
  doge: { id: "dogecoin", label: "Dogecoin" },
  cardano: { id: "cardano", label: "Cardano" },
  ada: { id: "cardano", label: "Cardano" },
  xrp: { id: "ripple", label: "XRP" },
};

const SERVICES: Record<string, { host: string; label: string }> = {
  github: { host: "www.githubstatus.com", label: "GitHub" },
  discord: { host: "discordstatus.com", label: "Discord" },
  cloudflare: { host: "www.cloudflarestatus.com", label: "Cloudflare" },
  openai: { host: "status.openai.com", label: "OpenAI" },
  anthropic: { host: "status.anthropic.com", label: "Anthropic" },
};

function scheduleFrom(text: string): WireAutomation["schedule"] {
  const every = text.match(/\bevery\s+(\d{1,4})\s+minutes?\b/i);
  if (every) {
    return {
      trigger: "watch",
      everyMinutes: Math.max(5, Math.min(1440, Number(every[1]))),
    };
  }
  if (/\b(every\s+(day|morning)|daily|each\s+(day|morning))\b/i.test(text)) {
    const at = text.match(/\bat\s+(\d{1,2})(?::\d{2})?\s*(am|pm)?\b/i);
    let hour = at ? Number(at[1]) : 8;
    if (at?.[2]?.toLowerCase() === "pm" && hour < 12) hour += 12;
    if (at?.[2]?.toLowerCase() === "am" && hour === 12) hour = 0;
    return { trigger: "daily", hour: Math.max(0, Math.min(23, hour)) };
  }
  return { trigger: "manual" };
}

function automation(
  text: string,
  fields: Pick<
    WireAutomation,
    "name" | "sentence" | "category" | "steps" | "sources" | "outputs"
  >
): WireAutomation {
  return {
    ...fields,
    inputs: [],
    files: { reads: [], writes: [] },
    // Fences added since this fast path was written — public-data drafts touch
    // no apps, heavy tools, or knowledge bases.
    apps: [],
    tools: [],
    knowledge: [],
    delivers: "answer",
    schedule: scheduleFrom(text),
    effort: "quick",
  };
}

function requestedCount(text: string, fallback = 10): number {
  const match = text.match(/\btop\s+(\d{1,2})\b/i);
  return match ? Math.max(3, Math.min(20, Number(match[1]))) : fallback;
}

function requestedEditorialCount(text: string, noun: string, fallback: number): number {
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
  };
  const match = text.match(
    new RegExp(
      `\\b(\\d|one|two|three|four|five)\\s+(?:biggest|main|key|most important\\s+)?${noun}`,
      "i"
    )
  );
  if (!match) return fallback;
  return Number(match[1]) || words[match[1].toLowerCase()] || fallback;
}

function newsFinishingSteps(text: string): string[] {
  const steps: string[] = [];
  if (/\b(identify|pick|highlight|rank)\b.*\bimportant\b/i.test(text)) {
    const count = requestedEditorialCount(text, "(?:stories|headlines)", 3);
    steps.push(
      `Add a Most important section with the ${count} strongest stories and one sentence on why each matters`
    );
  }
  if (/\b(themes?|summari[sz]e|summary|gist|takeaways?)\b/i.test(text)) {
    const count = requestedEditorialCount(text, "themes?", 3);
    steps.push(
      `End with a Themes section covering the ${count} strongest recurring themes in plain words`
    );
  }
  return steps;
}

function aliasesIn<T>(text: string, aliases: Record<string, T>): T[] {
  const found: T[] = [];
  const seen = new Set<T>();
  for (const [word, value] of Object.entries(aliases)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text) && !seen.has(value)) {
      found.push(value);
      seen.add(value);
    }
  }
  return found;
}

function newsAutomation(text: string, topic: string, label: string): WireAutomation {
  const count = requestedCount(text);
  const query = encodeURIComponent(topic).replace(/%20/g, "+");
  const finishing = newsFinishingSteps(text);
  return automation(text, {
    name: `${label} Headlines`.split(/\s+/).slice(0, 4).join(" "),
    sentence: `Fetches today's top ${count} ${label.toLowerCase()} headlines${finishing.length ? " and turns them into a concise briefing" : " and lists them clearly"}.`,
    category: "Notes",
    steps: [
      `GET https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`,
      `List the top ${count} headlines, one item per line`,
      ...finishing,
    ],
    sources: ["news.google.com"],
    outputs: [],
  });
}

function privateDiscordQuestion(): QuickCompileMatch {
  return {
    kind: "question",
    matched: ["private Discord messages"],
    question: {
      asking:
        "Reading private Discord messages needs a connected Discord account, which is not set up. I can check whether Discord itself is down instead.",
      term: "Discord messages",
      kind: "other",
      options: [
        {
          label: "Check Discord status",
          value: "Check public Discord status instead",
        },
      ],
    },
  };
}

function newsEmailBrief(text: string): QuickCompileMatch | null {
  if (
    !/\b(news|headlines?|stories)\b/i.test(text) ||
    !/\b(email|e-mail|mail)\b/i.test(text)
  ) {
    return null;
  }
  const label = /\b(ai|artificial intelligence)\b/i.test(text)
    ? "AI"
    : /\bsports?\b/i.test(text)
      ? "Sports"
      : /\b(tech|technology)\b/i.test(text)
        ? "Tech"
        : "News";
  const topic = label === "AI" ? "artificial intelligence" : label.toLowerCase();
  const source = newsAutomation(text, topic, label);
  source.name = `${label} News Brief`;
  source.sentence = `Builds a ${requestedCount(text)}-story ${label.toLowerCase()} briefing and identifies what matters most.`;
  source.outputs = [{ name: "headlines" }];

  const email: WireAutomation = {
    ...automation("", {
      name: `${label} Email Brief`,
      sentence: `Drafts a concise email from the ${label.toLowerCase()} news briefing, with links and why each story matters.`,
      category: "Email",
      steps: [
        "Draft a short email with a specific subject line",
        "Use {headlines} as the source material",
        "Keep the links and add one concise why-it-matters line per highlighted story",
      ],
      sources: [],
      outputs: [],
    }),
    inputs: [
      {
        name: "headlines",
        label: "News briefing",
        example: "Five verified headlines with links",
      },
    ],
    schedule: { trigger: "manual" },
  };

  return {
    kind: "draft",
    matched: [`${label} news email brief`],
    draft: {
      automations: [source, email],
      chain: {
        name: `${label} News to Email`,
        links: [
          {
            from: source.name,
            to: email.name,
            map: [{ output: "headlines", input: "headlines" }],
            onlyWhen: null,
          },
        ],
        steps: [],
      },
      question: null,
    },
  };
}

// Common public-data requests have a stable, keyless source and a fixed record
// shape. Compile those locally in milliseconds; the model remains available
// for requests that actually need interpretation, files, chains, or edits.
export function tryQuickCompile(context: DraftContext): QuickCompileMatch | null {
  if (context.demo) return null;
  const answerText = context.answers.map((answer) => answer.answer).join(" ");
  const original = context.userText.trim();
  const text = `${original} ${answerText}`.trim();
  const lower = text.toLowerCase();

  const emailBrief = newsEmailBrief(text);
  if (emailBrief) return emailBrief;

  if (
    /\b(file|folder|document|pdf|spreadsheet|sheet|excel|invoice|receipt|ledger)\b/i.test(text) ||
    /\b(email|e-mail|mail me|send me|text me|message me|draft me|draft (an? )?(email|message))\b/i.test(text) ||
    /\b(then|after that|hand[ -]?off)\b/i.test(text) ||
    /\b(edit|rename|delete|remove|put it back|make it \d|change (it|my|the))\b/i.test(text)
  ) {
    return null;
  }

  const discordPrivate =
    /\bdiscord\b/i.test(text) &&
    /\b(messages?|dms?|unread|channels?|servers?|inbox)\b/i.test(text) &&
    !/\b(status|down|outage|operational)\b/i.test(answerText);
  if (discordPrivate) return privateDiscordQuestion();

  const automations: WireAutomation[] = [];
  const matched: string[] = [];

  const wantsNews = /\b(news|headlines?|stories)\b/i.test(text);
  const wantsTech = wantsNews && /\b(tech|technology|hacker news)\b/i.test(text);
  const wantsAi = wantsNews && /\b(ai|artificial intelligence)\b/i.test(text);
  const wantsSports = wantsNews && /\bsports?\b/i.test(text);
  if (wantsTech) {
    const count = requestedCount(text);
    const finishing = newsFinishingSteps(text);
    automations.push(
      automation(text, {
        name: "Top Tech News",
        sentence: `Fetches today's top ${count} technology stories${finishing.length ? " and turns them into a concise briefing" : " and lists them clearly"}.`,
        category: "Notes",
        steps: [
          `GET https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${count}`,
          `List the top ${count} stories, one item per line`,
          ...finishing,
        ],
        sources: ["hn.algolia.com"],
        outputs: [],
      })
    );
    matched.push("tech headlines");
  }
  if (wantsAi) {
    automations.push(newsAutomation(text, "artificial intelligence", "AI"));
    matched.push("AI headlines");
  }
  if (wantsSports) {
    automations.push(newsAutomation(text, "sports", "Sports"));
    matched.push("sports headlines");
  }
  if (wantsNews && !wantsTech && !wantsAi && !wantsSports) {
    const about = text.match(/\bnews\s+(?:about|on|for)\s+(.+?)(?=\s+every\b|\s+daily\b|\s+at\s+\d|$)/i);
    const topic = about?.[1]?.trim() || (/\bworld\b/i.test(text) ? "world" : "top stories");
    const label = topic === "top stories" ? "Top" : topic.replace(/\b\w/g, (c) => c.toUpperCase());
    automations.push(newsAutomation(text, topic, label));
    matched.push(`${topic} headlines`);
  }

  const wantsStock = /\b(stock|share price|market price|stock price|quote)\b/i.test(text);
  if (wantsStock) {
    const stocks = aliasesIn(lower, STOCKS);
    if (stocks.length === 0) {
      return {
        kind: "question",
        matched: ["stock price"],
        question: {
          asking: "Which stock price should I check?",
          term: "stock price",
          kind: "other",
          options: [
            { label: "Apple (AAPL)", value: "Apple AAPL" },
            { label: "Tesla (TSLA)", value: "Tesla TSLA" },
            { label: "Nvidia (NVDA)", value: "Nvidia NVDA" },
          ],
        },
      };
    }
    for (const stock of stocks.slice(0, 3)) {
      automations.push(
        automation(text, {
          name: `${stock.label} Stock Price`.split(/\s+/).slice(0, 4).join(" "),
          sentence: `Checks the current ${stock.label} stock price and previous close.`,
          category: "Money",
          steps: [
            `GET https://api.nasdaq.com/api/quote/${encodeURIComponent(stock.symbol)}/info?assetclass=stocks`,
            `GET https://api.nasdaq.com/api/quote/${encodeURIComponent(stock.symbol)}/summary?assetclass=stocks`,
            "Answer with the current price, previous close, daily dollar and percentage change, market status, and last trade time",
          ],
          sources: ["api.nasdaq.com"],
          outputs: [{ name: "price" }],
        })
      );
      matched.push(`${stock.symbol} stock price`);
    }
  }

  const wantsPrice = /\b(price|worth|quote)\b/i.test(text);
  if (wantsPrice) {
    for (const coin of aliasesIn(lower, COINS).slice(0, 3)) {
      automations.push(
        automation(text, {
          name: `${coin.label} Price`,
          sentence: `Checks the live ${coin.label} price and 24-hour change.`,
          category: "Money",
          steps: [
            `GET https://api.coingecko.com/api/v3/simple/price?ids=${coin.id}&vs_currencies=usd&include_24hr_change=true`,
            "Answer with the price and 24-hour change",
          ],
          sources: ["api.coingecko.com"],
          outputs: [{ name: "price" }],
        })
      );
      matched.push(`${coin.label} price`);
    }
  }

  if (/\b(status|down|outage|operational|working)\b/i.test(text)) {
    for (const [word, service] of Object.entries(SERVICES)) {
      if (!new RegExp(`\\b${word}\\b`, "i").test(text)) continue;
      automations.push(
        automation(text, {
          name: `${service.label} Status`,
          sentence: `Checks ${service.label}'s public status page for outages.`,
          category: "Watch",
          steps: [
            `GET https://${service.host}/api/v2/status.json`,
            "Answer with the public status description",
          ],
          sources: [service.host],
          outputs: [],
        })
      );
      matched.push(`${service.label} status`);
    }
  }

  // Alias overlap ("Tesla TSLA") must not create duplicate records.
  const unique = automations.filter(
    (candidate, index) =>
      automations.findIndex(
        (other) => other.name === candidate.name && other.steps[0] === candidate.steps[0]
      ) === index
  );
  if (unique.length === 0) return null;
  return {
    kind: "draft",
    matched,
    draft: { automations: unique, chain: null, question: null },
  };
}
