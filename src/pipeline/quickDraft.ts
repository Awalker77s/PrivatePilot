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

// Every word a template can actually express: request plumbing, schedule
// words, and its own trigger vocabulary. Anything outside this — a topic, an
// extra deliverable ("with summaries"), a filter, a place — means the template
// would answer a DIFFERENT question than the one asked.
const TEMPLATE_VOCAB = new Set(
  `a an the this that these those there here it its i me my mine you your we us
   one ones some any thing things something please can could would will want
   wants need needs like lets let make makes making build create creates set
   setup give gives show shows tell tells get gets fetch fetches find finds
   check checks checking see know watch watches watching track tracks tracking
   monitor monitors report reports automation automations job task alert alerts
   notify update updates and or for of to on in at with from about into is are
   was be do does what whats how when much many current currently live latest
   new newest right now today todays up top first best main again just only also
   still per out specifically exactly really actually maybe instead else
   more other another next last sure ok okay thanks please regarding
   covering over across around related world
   every each daily day days morning mornings evening night hour hours hourly
   minute minutes week weekly am pm oclock time schedule
   price prices worth quote quotes cost value stock stocks share shares market
   news headline headlines story stories hacker tech technology sports
   status outage outages operational working down`
    .split(/\s+/)
    .filter(Boolean)
);

// The words a template consumed (its entity aliases, its topic) — plus the
// vocabulary above — must account for the whole message, or we hand the
// request to the model instead of serving a canned automation.
function uncoveredWords(text: string, consumed: string[]): string[] {
  const covered = new Set(
    consumed
      .flatMap((c) => c.toLowerCase().split(/[^a-z0-9]+/))
      .filter(Boolean)
  );
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter(
      (word) =>
        !/^\d+$/.test(word) && !TEMPLATE_VOCAB.has(word) && !covered.has(word)
    );
}

function aliasKeysWhere<T>(
  aliases: Record<string, T>,
  match: (value: T) => boolean
): string[] {
  return Object.entries(aliases)
    .filter(([, value]) => match(value))
    .map(([key]) => key);
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
  return automation(text, {
    name: `${label} Headlines`.split(/\s+/).slice(0, 4).join(" "),
    sentence: `Fetches today's top ${count} ${label.toLowerCase()} headlines and lists them clearly.`,
    category: "Notes",
    steps: [
      `GET https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`,
      `List the top ${count} headlines, one item per line`,
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

// Common public-data requests have a stable, keyless source and a fixed record
// shape. Compile those locally in milliseconds; the model remains available
// for requests that actually need interpretation, files, chains, or edits.
export function tryQuickCompile(context: DraftContext): QuickCompileMatch | null {
  if (context.demo) return null;
  const answerText = context.answers.map((answer) => answer.answer).join(" ");
  const original = context.userText.trim();
  const text = `${original} ${answerText}`.trim();
  const lower = text.toLowerCase();

  if (
    /\b(file|folder|document|pdf|spreadsheet|sheet|excel|invoice|receipt|ledger)\b/i.test(text) ||
    /\b(email me|send me|text me|draft (an? )?(email|message)|then message)\b/i.test(text) ||
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
  // Words this template path actually accounted for — checked at the end so a
  // canned automation never stands in for a request it only half-matched.
  const consumed: string[] = [];

  const wantsNews = /\b(news|headlines?|stories)\b/i.test(text);
  const wantsTech = wantsNews && /\b(tech|technology|hacker news)\b/i.test(text);
  const wantsSports = wantsNews && /\bsports?\b/i.test(text);
  // A topic qualifier ("news on Claude", "news specifically about rust") must
  // never be dropped — serving the generic template for a specific ask is the
  // fast path answering a different question than the person asked.
  const aboutMatch = text.match(
    /\b(?:news|headlines?|stories)\s+(?:\w+\s+){0,2}?(?:about|on|regarding|covering)\s+(.+?)(?=\s+every\b|\s+daily\b|\s+each\b|\s+at\s+\d|$)/i
  );
  const aboutTopic = aboutMatch?.[1]?.trim().replace(/[.!?]+$/, "");
  if (wantsTech) {
    const count = requestedCount(text);
    if (aboutTopic && !/^(tech|technology)$/i.test(aboutTopic)) {
      // Topic-qualified tech news: search Hacker News for the topic.
      const label = aboutTopic.replace(/\b\w/g, (c) => c.toUpperCase());
      automations.push(
        automation(text, {
          name: `${label} Tech News`.split(/\s+/).slice(0, 4).join(" "),
          sentence: `Fetches today's top ${count} tech stories about ${aboutTopic} and lists them clearly.`,
          category: "Notes",
          steps: [
            `GET https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(aboutTopic).replace(/%20/g, "+")}&tags=story&hitsPerPage=${count}`,
            `List the top ${count} stories about ${aboutTopic}, one item per line with its link`,
          ],
          sources: ["hn.algolia.com"],
          outputs: [],
        })
      );
      matched.push(`${aboutTopic} tech headlines`);
      consumed.push(aboutTopic);
    } else {
      automations.push(
        automation(text, {
          name: "Top Tech News",
          sentence: `Fetches today's top ${count} technology stories and lists them clearly.`,
          category: "Notes",
          steps: [
            `GET https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${count}`,
            `List the top ${count} stories, one item per line`,
          ],
          sources: ["hn.algolia.com"],
          outputs: [],
        })
      );
      matched.push("tech headlines");
    }
  }
  if (wantsSports) {
    automations.push(newsAutomation(text, "sports", "Sports"));
    matched.push("sports headlines");
  }
  if (wantsNews && !wantsTech && !wantsSports) {
    const topic = aboutTopic || (/\bworld\b/i.test(text) ? "world" : "top stories");
    const label = topic === "top stories" ? "Top" : topic.replace(/\b\w/g, (c) => c.toUpperCase());
    automations.push(newsAutomation(text, topic, label));
    matched.push(`${topic} headlines`);
    consumed.push(topic);
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
            `GET https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(stock.symbol)}?interval=1d&range=1d`,
            "Answer with the current price and previous close",
          ],
          sources: ["query1.finance.yahoo.com"],
          outputs: [{ name: "price" }],
        })
      );
      matched.push(`${stock.symbol} stock price`);
      consumed.push(
        stock.label,
        stock.symbol,
        ...aliasKeysWhere(STOCKS, (v) => v.symbol === stock.symbol)
      );
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
      consumed.push(
        coin.label,
        coin.id,
        ...aliasKeysWhere(COINS, (v) => v.id === coin.id)
      );
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
      consumed.push(
        service.label,
        ...aliasKeysWhere(SERVICES, (v) => v.host === service.host)
      );
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
  // A canned automation may only answer a request it fully covers. Leftover
  // words mean the person asked for something this template cannot express
  // ("...with summaries", "...about quantum", "...for my team") — hand the
  // whole request to the model instead of serving a near-miss.
  const leftover = uncoveredWords(text, consumed);
  if (leftover.length > 0) return null;
  return {
    kind: "draft",
    matched,
    draft: { automations: unique, chain: null, question: null },
  };
}
