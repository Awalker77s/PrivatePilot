import type { AutomationRecord } from "../storage/types";
import { fetchPage } from "./fetchPage";

export interface DirectOutcome {
  answer: string;
  corpus: string;
  logLines: string[];
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
  if (!fetched.ok) return null;

  try {
    const body = JSON.parse(fetched.text) as Record<string, unknown>;
    const answer = formatAnswer(kind, body, new URL(url).hostname);
    if (!answer) return null;
    return {
      answer,
      corpus: `=== ${url} ===\n${fetched.text}`,
      logLines: [fetched.logLine, "Read the verified endpoint directly — no model turn needed."],
    };
  } catch {
    return null;
  }
}

type DirectKind = "status" | "coingecko" | "coinbase" | "frankfurter";

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
  return null;
}

function formatAnswer(
  kind: DirectKind,
  body: Record<string, unknown>,
  hostname: string
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

  const base = typeof body.base === "string" ? body.base : null;
  const rates = body.rates as Record<string, unknown> | undefined;
  const quote = rates ? Object.keys(rates)[0] : null;
  const rate = quote ? Number(rates?.[quote]) : Number.NaN;
  if (!base || !quote || !Number.isFinite(rate)) return null;
  return `One ${base} buys ${compactNumber(rate, 6)} ${quote}. OUTPUTS: rate=${rate}`;
}
