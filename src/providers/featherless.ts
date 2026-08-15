// Featherless.ai — local-first, not local-only. Fully OpenAI-compatible:
// base https://api.featherless.ai/v1, POST /v1/chat/completions, Bearer key.
// The request runs in Rust (plugin-http/reqwest); the key lives in
// settings.json on this machine only. Pricing is concurrency-based, so every
// cloud call serializes through one queue — a watcher firing during a manual
// run WOULD 429 otherwise.
import { fetch } from "@tauri-apps/plugin-http";
import {
  ChatRequest,
  ChatResponse,
  ModelInfo,
  ModelProvider,
  ProviderError,
} from "./types";
import { getSettings } from "../storage/settings";

const BASE = "https://api.featherless.ai/v1";

export const QUEUE_SENTENCE =
  "Waiting for the borrowed computer — one run at a time on this plan.";

// Pinned model choices, confirmed live in the catalog (build pack A3-8).
export const CLOUD_MODELS: { id: string; role: string; tools: boolean }[] = [
  { id: "Qwen/Qwen3-32B", role: "Cloud default — native tool calling", tools: true },
  {
    id: "Qwen/Qwen2.5-7B-Instruct",
    role: "The mirror — same weights as local qwen2.5:7b",
    tools: false,
  },
  {
    id: "zai-org/GLM-4.7-Flash",
    role: "Long-context thorough mode (202k)",
    tools: false,
  },
  { id: "moonshotai/Kimi-K2.6", role: "Showcase (262k context)", tools: true },
  { id: "Qwen/Qwen3-VL-8B-Instruct", role: "Vision", tools: true },
];

// Native tools only on the Qwen3 family and Kimi models.
function modelSupportsTools(model: string): boolean {
  return /Qwen3|Kimi/i.test(model);
}

// One queue for every cloud call. Concurrency is the plan, not the tokens.
let queueTail: Promise<void> = Promise.resolve();
let inFlight = 0;
const meterListeners = new Set<(n: number) => void>();

export function onCloudMeter(fn: (n: number) => void): () => void {
  meterListeners.add(fn);
  return () => meterListeners.delete(fn);
}

function setInFlight(n: number) {
  inFlight = n;
  for (const fn of meterListeners) fn(n);
}

export function cloudCallsInFlight(): number {
  return inFlight;
}

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    setInFlight(1);
    try {
      return await work();
    } finally {
      setInFlight(0);
    }
  });
  queueTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FeatherlessProvider implements ModelProvider {
  id = "featherless" as const;
  label = "Featherless (cloud)";

  supportsSchemaFormat(_model: string): boolean {
    return false; // only response_format json_object — the validator loop is the defense
  }

  supportsTools(model: string): boolean {
    return modelSupportsTools(model);
  }

  async listModels(): Promise<ModelInfo[]> {
    // The live catalog is free — GET /v1/models is public, no key.
    const res = await fetch(`${BASE}/models`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new ProviderError(
        `Featherless's catalog answered with an error (${res.status}).`,
        await res.text().catch(() => "")
      );
    }
    const body = (await res.json()) as {
      data?: { id: string; context_length?: number }[];
    };
    return (body.data ?? []).map((m) => ({
      id: m.id,
      label: m.id,
      sizeBytes: null,
    }));
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const key = getSettings().featherless.key;
    if (!key) {
      throw new ProviderError(
        "Borrowing cloud compute needs a Featherless key — paste one in Settings.",
        "no key"
      );
    }
    if (req.format && req.tools) {
      throw new ProviderError(
        "A drafting call and a tool call got mixed together — this is a Private Pilot bug, not yours.",
        "format and tools in the same request"
      );
    }
    if (req.tools && !this.supportsTools(req.model)) {
      throw new ProviderError(
        `${req.model} can't call tools on Featherless — pick a Qwen3 or Kimi model for runs.`,
        "tools on non-tool model"
      );
    }

    return enqueue(async () => {
      const started = Date.now();
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(`${BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          signal: AbortSignal.timeout(180_000),
          body: JSON.stringify({
            model: req.model,
            messages: req.messages.map((m) => ({
              role: m.role,
              content: m.content,
              ...(m.tool_calls
                ? {
                    tool_calls: m.tool_calls.map((c, i) => ({
                      id: `call_${i}`,
                      type: "function",
                      function: {
                        name: c.function.name,
                        arguments: JSON.stringify(c.function.arguments),
                      },
                    })),
                  }
                : {}),
            })),
            // No json_schema response format on Featherless — json_object
            // only; the schema already rides in the prompt and the validator
            // loop takes it from there.
            ...(req.format ? { response_format: { type: "json_object" } } : {}),
            ...(req.tools ? { tools: req.tools } : {}),
            temperature: req.options.temperature,
            ...(req.options.top_p !== undefined ? { top_p: req.options.top_p } : {}),
            ...(req.options.seed !== undefined ? { seed: req.options.seed } : {}),
            // Throughput floor is ~10 tok/s on the biggest models — cap output.
            max_tokens: req.options.max_tokens ?? 1800,
          }),
        });

        if (res.status === 429) {
          // Over the plan's concurrency: honor Retry-After, say the sentence.
          const retryAfter = Number(res.headers.get("Retry-After") ?? "5");
          if (attempt < 2) {
            await sleep(Math.min(retryAfter, 30) * 1000);
            continue;
          }
          throw new ProviderError(QUEUE_SENTENCE, "429 after retries");
        }
        if (res.status === 401 || res.status === 403) {
          throw new ProviderError(
            `The Featherless key doesn't work (${res.status}) — check it in Settings.`,
            await res.text().catch(() => "")
          );
        }
        if (!res.ok) {
          throw new ProviderError(
            `The borrowed computer answered with an error (${res.status}).`,
            (await res.text().catch(() => "")).slice(0, 400)
          );
        }
        const body = (await res.json()) as {
          choices?: {
            message?: {
              content?: string | null;
              tool_calls?: {
                function: { name: string; arguments: string };
              }[];
            };
            finish_reason?: string;
          }[];
        };
        const choice = body.choices?.[0];
        return {
          content: choice?.message?.content ?? "",
          toolCalls: (choice?.message?.tool_calls ?? []).map((c) => ({
            function: {
              name: c.function.name,
              arguments: safeParseArgs(c.function.arguments),
            },
          })),
          doneReason: choice?.finish_reason ?? null,
          totalMs: Date.now() - started,
        };
      }
      throw new ProviderError(QUEUE_SENTENCE, "unreachable");
    });
  }
}

function safeParseArgs(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface PlanInfo {
  ok: boolean;
  line: string; // "Scale plan · 4 concurrency units" or the designed failure
}

// Judge-bait endpoint beyond chat: show the user's actual plan inside the
// Borrow-cloud card before they flip the switch.
export async function fetchPlan(key: string): Promise<PlanInfo> {
  try {
    const res = await fetch(`${BASE}/plan`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, line: "That key doesn't work — Featherless turned it away." };
    }
    if (!res.ok) {
      return { ok: false, line: `Featherless answered ${res.status} — try again in a bit.` };
    }
    const body = (await res.json()) as Record<string, unknown>;
    const name =
      (body.plan as string) ?? (body.name as string) ?? (body.tier as string) ?? "plan";
    const units =
      (body.concurrency as number) ??
      (body.concurrent_connections as number) ??
      (body.units as number) ??
      null;
    return {
      ok: true,
      line: `${name}${units ? ` · ${units} concurrent unit${units === 1 ? "" : "s"}` : ""}`,
    };
  } catch (e) {
    return { ok: false, line: `Couldn't reach Featherless — ${String(e).slice(0, 80)}` };
  }
}

// Pre-warm on opt-in: a 1-token request so the first real run isn't cold.
export async function prewarm(model: string): Promise<void> {
  const key = getSettings().featherless.key;
  if (!key) return;
  try {
    await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
    });
  } catch {
    // warming is best-effort; the real call will say what's wrong
  }
}
