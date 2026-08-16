// A small-model path for ordinary read-only jobs. The full compiler carries
// every file, chain, mail, heavy-tool, and branching rule in one prompt. That
// is necessary for complex work, but on a CPU-only PC it can take minutes for
// a simple "read this app" or weather request. This path asks for only the
// fields a single safe read job can vary; the app fills the rest itself and
// validates the finished record against the same wire schema.
import { chat } from "../providers";
import { ENDPOINTS } from "./endpoints";
import type { Catalog } from "./catalog";
import type { DraftContext } from "./draft";
import {
  buildWireSchema,
  CATEGORIES,
  type WireDraft,
} from "./draft/schema";
import { scheduleFrom } from "./quickDraft";
import { ProviderError } from "../providers/types";

const COMPACT_CTX = 4096;

const COMPLEX_REQUEST =
  /\b(file|folder|document|pdf|spreadsheet|sheet|excel|invoice|receipt|ledger|email|e-mail|mail|inbox|calendar|meeting|gmail|outlook|spotify|then|after that|hand[ -]?off|otherwise|or else|depending on|alert|notify|watch|monitor|cross(?:es|ing)?|drops?|rises?|below|above|changes? by|every \d+ minutes?|hourly|send|draft|reply|write|edit|delete|remove|rename|move|copy|upload|download|click|type|post|press|fill|enter)\b/i;

const READ_REQUEST =
  /\b(check|read|show|tell|summari[sz]e|find|get|fetch|look|what|which|is|are|open|report|list)\b/i;

const SCREEN_REQUEST =
  /\b(app|application|window|screen|visible|shown|showing|discord|teams|slack|notepad|calculator|chrome|edge|browser|zoom|figma)\b/i;

function endpointHints(text: string): string[] {
  const wanted = ENDPOINTS.filter((endpoint) => {
    if (/\b(weather|forecast|temperature|rain|snow)\b/i.test(text))
      return /weather|coordinates/.test(endpoint.intent);
    if (/\b(currency|exchange rate|usd|eur|gbp|jpy)\b/i.test(text))
      return /currency/.test(endpoint.intent);
    if (/\b(news|headlines?|stories)\b/i.test(text))
      return /news/.test(endpoint.intent);
    if (/\b(sports?|game|score|team|match)\b/i.test(text))
      return /sports/.test(endpoint.intent);
    if (/\b(status|down|outage|operational)\b/i.test(text))
      return /service down/.test(endpoint.intent);
    if (/\b(price|prices|worth|quote|value)\b/i.test(text))
      return /price/.test(endpoint.intent);
    return false;
  });
  return wanted.map(
    (endpoint) =>
      `${endpoint.intent}: ${endpoint.urlTemplate} (${endpoint.slots})`
  );
}

export function isCompactReadRequest(context: DraftContext): boolean {
  if (context.demo || context.answers.length > 0) return false;
  const text = context.userText.trim();
  if (!READ_REQUEST.test(text) || COMPLEX_REQUEST.test(text)) return false;
  return SCREEN_REQUEST.test(text) || endpointHints(text).length > 0;
}

const compactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "category", "steps", "sources", "apps"],
  properties: {
    name: { type: "string" },
    category: { type: "string", enum: [...CATEGORIES] },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: { type: "string" },
    },
    sources: {
      type: "array",
      maxItems: 4,
      items: { type: "string" },
    },
    apps: {
      type: "array",
      maxItems: 1,
      items: { type: "string", enum: ["computer"] },
    },
  },
} as const;

function hostname(value: string): string | null {
  try {
    const url = new URL(
      /^https?:\/\//i.test(value) ? value : `https://${value}`
    );
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function uniqueName(name: string, catalog: Catalog): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  if (words.length < 2) words.push("Check");
  let candidate = words.join(" ") || "New Automation";
  const taken = new Set(catalog.automationNames.map((item) => item.toLowerCase()));
  if (taken.has(candidate.toLowerCase())) {
    candidate = `${candidate.split(/\s+/).slice(0, 3).join(" ")} New`;
  }
  return candidate;
}

export async function compactReadDraft(
  context: DraftContext,
  model: string,
  catalog: Catalog
): Promise<{ draft: WireDraft; ms: number } | null> {
  if (!isCompactReadRequest(context)) return null;

  const hints = endpointHints(context.userText);
  const system = [
    "Create exactly one safe, read-only Private Pilot automation.",
    "Return only the requested JSON. Use a 2-4 word name.",
    "Steps are short and executable. For a named desktop app, use a step exactly like `read_app Discord`, set apps to [\"computer\"], use no sources, and only report what is visible in the open window.",
    "For web data, use GET plus a complete URL, put each fetched hostname in sources, and use no apps.",
    "The final step says how to answer after the read; never write a current result while building the job.",
    "Never click, type, send, edit, delete, or claim background/private access.",
    ...(hints.length > 0
      ? ["Use these verified endpoint shapes when they fit:", ...hints]
      : []),
  ].join("\n");

  const response = await chat({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: context.userText },
    ],
    format: compactSchema,
    options: {
      num_ctx: COMPACT_CTX,
      max_tokens: 512,
      temperature: 0,
      seed: 7,
    },
    think: false,
  });

  let parsed: {
    name?: unknown;
    category?: unknown;
    steps?: unknown;
    sources?: unknown;
    apps?: unknown;
  };
  try {
    parsed = JSON.parse(response.content) as typeof parsed;
  } catch {
    throw new ProviderError(
      "The local AI couldn't finish this small draft — try once more.",
      "compact draft was not JSON"
    );
  }

  let steps = Array.isArray(parsed.steps)
    ? parsed.steps.filter((step): step is string => typeof step === "string").slice(0, 4)
    : [];
  if (steps.length === 0) {
    throw new ProviderError(
      "The local AI couldn't finish this small draft — try once more.",
      "compact draft had no steps"
    );
  }

  const readApp = steps.find((step) => /\bread_app\s+/i.test(step));
  const usesComputer = !!readApp;
  if (
    usesComputer &&
    !steps.some((step) => /^(answer|report|summari[sz]e|list|tell)\b/i.test(step.trim()))
  ) {
    steps = [
      ...steps.slice(0, 3),
      "Answer the person's request using only what is visible in the app",
    ];
  }

  const urlHosts = steps.flatMap((step) =>
    [...step.matchAll(/https?:\/\/[^\s)]+/gi)]
      .map((match) => hostname(match[0]))
      .filter((host): host is string => !!host)
  );
  const proposedSources = Array.isArray(parsed.sources)
    ? parsed.sources
        .filter((source): source is string => typeof source === "string")
        .map(hostname)
        .filter((host): host is string => !!host)
    : [];
  const appName = readApp
    ?.replace(/^.*?\bread_app\s+/i, "")
    .replace(/["'`]/g, "")
    .trim()
    .slice(0, 50);
  const allSources = [...new Set([...proposedSources, ...urlHosts])];
  if (!usesComputer && allSources.length === 0) {
    throw new ProviderError(
      "The local AI needs a little more detail about where to read that.",
      "compact draft had neither an app read nor a web source"
    );
  }
  const sentence = usesComputer
    ? `Reads the visible ${appName || "app"} window and reports what you asked for without changing anything.`
    : `Fetches the requested information from ${allSources.join(", ")} and reports it in the app.`;
  const draft: WireDraft = {
    automations: [
      {
        name: uniqueName(String(parsed.name ?? "New Automation"), catalog),
        sentence,
        category: CATEGORIES.includes(parsed.category as (typeof CATEGORIES)[number])
          ? (parsed.category as (typeof CATEGORIES)[number])
          : "Notes",
        steps,
        inputs: [],
        outputs: [],
        files: { reads: [], writes: [] },
        sources: allSources,
        apps: usesComputer ? ["computer"] : [],
        tools: [],
        knowledge: [],
        delivers: "answer",
        schedule: scheduleFrom(context.userText),
        effort: "quick",
      },
    ],
    chain: null,
    question: null,
  };

  const checked = buildWireSchema(catalog).safeParse(draft);
  if (!checked.success) {
    throw new ProviderError(
      "The local AI couldn't safely finish this draft — try a little more detail.",
      checked.error.issues.map((issue) => issue.message).join("; ")
    );
  }
  return { draft: checked.data, ms: response.totalMs };
}
