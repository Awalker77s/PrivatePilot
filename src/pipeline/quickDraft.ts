import type { DraftContext } from "./draft";
import type { WireAutomation, WireDraft } from "./draft/schema";

export interface QuickQuestion {
  asking: string;
  term: string;
  kind: "file" | "folder" | "other";
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

export function scheduleFrom(text: string): WireAutomation["schedule"] {
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
   one two three four five six seven eight nine ten couple few several
   more other another next last sure ok okay thanks please regarding
   covering over across around related world
   every each daily day days morning mornings evening night hour hours hourly
   minute minutes week weekly am pm oclock time schedule
   price prices worth quote quotes cost value stock stocks share shares market
   news headline headlines story stories hacker tech technology sports
   status outage outages operational working down
   sequence sequences chain chains workflow workflows connect connected
   connecting link linked links combine combined join joined together
   then after order series row back string hook`
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

// The editorial vocabulary the finishing steps EXPRESS — when they fire, the
// template really did account for these words, so the coverage guard must not
// treat them as leftovers and hand the request to the model.
// What the price templates actually REPORT — a request naming these is fully
// answered by them ('the Tesla stock price and previous close', 'bitcoin and
// its 24-hour change'), so they are covered, not leftovers.
const PRICE_REPORT_WORDS =
  'previous close change changes percent percentage percentages hour hours ' +
  'daily market status last trade time current';

export const EDITORIAL_WORDS =
  'identify pick highlight rank important importance themes theme summarize ' +
  'summarise summary summaries gist takeaways takeaway biggest main key most ' +
  'strongest matters why each concise brief briefing';

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

function discordScreenDraft(text: string): QuickCompileMatch {
  const record = automation(text, {
    name: "Discord Message Check",
    sentence:
      "Reads the visible Discord window and summarizes only the messages currently shown.",
    category: "Notes",
    steps: [
      "read_app Discord",
      "Answer with a concise summary of the messages visible in the Discord window",
    ],
    sources: [],
    outputs: [],
  });
  record.apps = ["computer"];
  return {
    kind: "draft",
    matched: ["visible Discord messages"],
    draft: { automations: [record], chain: null, question: null },
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
  if (discordPrivate) {
    const visibleAppRequest =
      /\b(app|application|window|screen|visible|shown|showing|desktop)\b/i.test(text) &&
      !/\b(watch|monitor|every \d+ minutes?|click|type|send|reply|post)\b/i.test(text);
    return visibleAppRequest ? discordScreenDraft(text) : privateDiscordQuestion();
  }

  const automations: WireAutomation[] = [];
  const matched: string[] = [];
  // Words this template path actually accounted for — checked at the end so a
  // canned automation never stands in for a request it only half-matched.
  const consumed: string[] = [];
  // If the editorial finishing steps fire, the template DID express those
  // words ("highlight the two most important", "summarize the themes") — they
  // are covered, not leftovers.
  const consumedEditorial = newsFinishingSteps(text).length > 0;

  const wantsNews = /\b(news|headlines?|stories)\b/i.test(text);
  const wantsTech = wantsNews && /\b(tech|technology|hacker news)\b/i.test(text);
  const wantsAi = wantsNews && /\b(ai|artificial intelligence)\b/i.test(text);
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
    // Both hardenings apply: a topic qualifier searches HN for that topic
    // (never the generic front page), and either shape gets the editorial
    // finishing steps when the person asked for importance/themes.
    const finishing = newsFinishingSteps(text);
    const briefing = finishing.length
      ? " and turns them into a concise briefing"
      : " and lists them clearly";
    if (aboutTopic && !/^(tech|technology)$/i.test(aboutTopic)) {
      const label = aboutTopic.replace(/\b\w/g, (c) => c.toUpperCase());
      automations.push(
        automation(text, {
          name: `${label} Tech News`.split(/\s+/).slice(0, 4).join(" "),
          sentence: `Fetches today's top ${count} tech stories about ${aboutTopic}${briefing}.`,
          category: "Notes",
          steps: [
            `GET https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(aboutTopic).replace(/%20/g, "+")}&tags=story&hitsPerPage=${count}`,
            `List the top ${count} stories about ${aboutTopic}, one item per line with its link`,
            ...finishing,
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
          sentence: `Fetches today's top ${count} technology stories${briefing}.`,
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
  }
  if (wantsAi) {
    automations.push(newsAutomation(text, "artificial intelligence", "AI"));
    matched.push("AI headlines");
  }
  if (wantsSports) {
    automations.push(newsAutomation(text, "sports", "Sports"));
    matched.push("sports headlines");
  }
  // Their AI branch, our topic capture (computed once above; "for" left out
  // deliberately so "news for my newsletter" isn't read as a topic).
  if (wantsNews && !wantsTech && !wantsAi && !wantsSports) {
    const topic = aboutTopic || (/\bworld\b/i.test(text) ? "world" : "top stories");
    const label = topic === "top stories" ? "Top" : topic.replace(/\b\w/g, (c) => c.toUpperCase());
    automations.push(newsAutomation(text, topic, label));
    matched.push(`${topic} headlines`);
    consumed.push(topic);
  }

  // NOT a bare "quote" — "a motivational quote", "a shipping quote" are not
  // stock asks, and the zero-ticker branch below would hijack the message.
  // A named company plus ordinary price language is unambiguous too. This is
  // what keeps the built-in "Check Bitcoin and Tesla prices" request on the
  // instant verified path even though a person naturally omits "stock".
  const stocks = aliasesIn(lower, STOCKS);
  const wantsStock =
    /\b(stock|share price|market price|stock price|stock quote)\b/i.test(text) ||
    (stocks.length > 0 && /\b(price|prices|worth|quote|quotes|value)\b/i.test(text));
  if (wantsStock) {
    // Only ASK when the stock request is the whole message — returning here
    // would throw away automations other templates already matched.
    if (stocks.length === 0 && automations.length === 0) {
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
      consumed.push(
        stock.label,
        stock.symbol,
        ...aliasKeysWhere(STOCKS, (v) => v.symbol === stock.symbol),
        PRICE_REPORT_WORDS
      );
    }
  }

  const wantsPrice = /\b(price|prices|worth|quote|quotes|value|values)\b/i.test(text);
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
        ...aliasKeysWhere(COINS, (v) => v.id === coin.id),
        PRICE_REPORT_WORDS
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
  const leftover = uncoveredWords(
    text,
    consumedEditorial ? [...consumed, EDITORIAL_WORDS] : consumed
  );
  if (leftover.length > 0) return null;
  return {
    kind: "draft",
    matched,
    draft: { automations: unique, chain: null, question: null },
  };
}
