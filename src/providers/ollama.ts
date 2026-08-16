// OllamaProvider — every network call goes through plugin-http (never
// window.fetch: the packaged origin http://tauri.localhost is not on Ollama's
// CORS allowlist, so window.fetch dies only in the build you demo).
import { invoke } from "@tauri-apps/api/core";
import { isDesktopApp } from "../platform";
import {
  ChatRequest,
  ChatResponse,
  ModelInfo,
  ModelProvider,
  ProviderError,
} from "./types";
import { getSettings } from "../storage/settings";

const OLLAMA = "http://127.0.0.1:11434";

export const OLLAMA_DOWN_SENTENCE =
  "The local AI isn't running — start Ollama, then try again.";

// The curated brains, ranked from a live bench of the app's own compile
// pipeline + tool loop + vision probe on this class of laptop (Aug 2026).
// Fast is the default; Careful trades speed for the best screen/image
// reading (the only model that read two labelled images without fusing them).
export interface RecommendedModel {
  tag: string;
  role: "Fast" | "Careful" | "Balanced";
  name: string;
  blurb: string;
  downloadGB: number;
}
export const RECOMMENDED_MODELS: RecommendedModel[] = [
  {
    tag: "qwen3.5:4b",
    role: "Fast",
    name: "Qwen 4B",
    blurb: "Quick and sharp — best all-round for building automations. The default.",
    downloadGB: 3.4,
  },
  {
    tag: "gemma4:12b",
    role: "Careful",
    name: "Gemma 12B",
    blurb: "Slower, but the best at reading screens and images — pick it for Watch me and screen-heavy jobs.",
    downloadGB: 7.6,
  },
  {
    tag: "qwen3.5:9b",
    role: "Balanced",
    name: "Qwen 9B",
    blurb: "The middle ground — a bit slower than Fast, no better at drafting.",
    downloadGB: 6.6,
  },
];

// Local default and fallbacks. Order = what an unset preference tries first.
export const LOCAL_DEFAULT = "qwen3.5:4b";
export const LOCAL_FALLBACKS = ["qwen3.5:9b", "gemma4:12b", "qwen2.5:7b"];

export function localModelCandidates(preferred?: string | null): string[] {
  return [...new Set([preferred, LOCAL_DEFAULT, ...LOCAL_FALLBACKS].filter(
    (tag): tag is string => !!tag
  ))];
}

const FRIENDLY: Record<string, string> = {
  "qwen3.5:9b": "Qwen 9B",
  "qwen3.5:4b": "Qwen 4B",
  "qwen3.5:2b": "Qwen 2B",
  "qwen2.5:7b": "Qwen 7B",
  "qwen3-vl:4b": "Qwen Vision 4B",
  "gemma4:12b": "Gemma 12B",
};

export function friendlyName(tag: string): string {
  if (FRIENDLY[tag]) return FRIENDLY[tag];
  // "some-model:7b-instruct" → "Some Model 7b Instruct"
  return tag
    .replace(/:latest$/, "")
    .split(/[:\-_.\/]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// keep_alive: "30m" on every call; -1 while a chain is executing or a watcher
// is armed, so heartbeats never pay a cold model load.
let holds = 0;
export function holdModelInMemory(): () => void {
  holds++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      holds--;
    }
  };
}
export function currentKeepAlive(): string | number {
  return holds > 0 ? -1 : "30m";
}

async function ollamaFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  // A single chat turn shouldn't hold the UI for five minutes (public-data
  // jobs bypass the model; unusual model-backed turns get two minutes).
  // Embedding a document batch on CPU genuinely takes minutes, so it keeps the
  // long ceiling.
  const timeoutMs =
    path === "/api/embed" ? 300_000 : path === "/api/chat" ? 120_000 : 20_000;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    // A wedged request must become a designed sentence, never a forever-hang
    // (the tool loop's 30-min stall check only runs between turns).
    if (isDesktopApp()) {
      const native = await invoke<{ status: number; body: string }>(
        "ollama_request",
        {
          path,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
          timeoutMs,
        }
      );
      return new Response(native.body, {
        status: native.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    const request = globalThis.fetch.bind(globalThis);
    return await request(`${OLLAMA}${path}`, {
      signal,
      ...init,
    });
  } catch (e) {
    const timedOut =
      signal.aborted ||
      String(e).toLowerCase().includes("timeout") ||
      (e instanceof Error && e.name === "TimeoutError");
    throw new ProviderError(
      timedOut
        ? "The local AI took over two minutes on this CPU — split a complex request into smaller automations, then try again."
        : OLLAMA_DOWN_SENTENCE,
      String(e)
    );
  }
}

export class OllamaProvider implements ModelProvider {
  id = "ollama" as const;
  label = "Local (Ollama)";

  supportsSchemaFormat(_model: string): boolean {
    return true; // llama.cpp grammar lock — local-only luxury
  }

  supportsTools(model: string): boolean {
    return toolsCapableCache.get(model) ?? true; // doctor refines per model
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await ollamaFetch("/api/tags");
    if (!res.ok)
      throw new ProviderError(OLLAMA_DOWN_SENTENCE, `GET /api/tags ${res.status}`);
    const body = (await res.json()) as {
      models?: { name: string; size?: number }[];
    };
    return (body.models ?? []).map((m) => ({
      id: m.name,
      label: friendlyName(m.name),
      sizeBytes: m.size ?? null,
    }));
  }

  // Ollama keeps models resident after a request. Explicitly evict the brain
  // a person just switched away from so a 12B and 4B model do not compete for
  // RAM on CPU-only Windows machines.
  async unload(model: string): Promise<void> {
    const res = await ollamaFetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0, stream: false }),
    });
    if (!res.ok) {
      throw new ProviderError(
        "The previous local model couldn't be unloaded.",
        `POST /api/generate ${res.status}`
      );
    }
  }

  // Embed a batch of strings → one 768-vector each. num_ctx 8192 stops long
  // chunks silently truncating at Ollama's 2048 default. The caller adds the
  // nomic task prefixes (search_document:/search_query:) — Ollama does not.
  async embed(model: string, inputs: string[]): Promise<number[][]> {
    const res = await ollamaFetch("/api/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: inputs,
        truncate: true,
        options: { num_ctx: 8192 },
      }),
    });
    if (!res.ok)
      throw new ProviderError(OLLAMA_DOWN_SENTENCE, `POST /api/embed ${res.status}`);
    const body = (await res.json()) as { embeddings?: number[][] };
    if (!body.embeddings || body.embeddings.length !== inputs.length) {
      throw new ProviderError(
        "The embedding model didn't answer — is nomic-embed-text pulled?",
        `embed returned ${body.embeddings?.length ?? 0} of ${inputs.length}`
      );
    }
    return body.embeddings;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // The open Ollama bug: a request may carry format OR tools, never both —
    // when both are present the schema wins and tool_calls never come.
    if (req.format && req.tools) {
      throw new ProviderError(
        "A drafting call and a tool call got mixed together — this is a Private Pilot bug, not yours.",
        "format and tools in the same request"
      );
    }
    if (!req.options || typeof req.options.num_ctx !== "number") {
      throw new ProviderError(
        "A model call went out without an explicit context size — this is a Private Pilot bug, not yours.",
        "options.num_ctx missing"
      );
    }
    const started = Date.now();
    const { max_tokens, ...options } = req.options;
    const res = await ollamaFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: false,
        ...(req.format ? { format: req.format } : {}),
        ...(req.tools ? { tools: req.tools } : {}),
        ...(req.think === undefined ? {} : { think: req.think }),
        options: { ...options, ...(max_tokens ? { num_predict: max_tokens } : {}) },
        keep_alive: currentKeepAlive(),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `The local AI answered with an error (${res.status}).`,
        text.slice(0, 500)
      );
    }
    const body = (await res.json()) as {
      message?: {
        content?: string;
        tool_calls?: {
          function: { name: string; arguments: Record<string, unknown> };
        }[];
      };
      done_reason?: string;
    };
    return {
      content: body.message?.content ?? "",
      toolCalls: body.message?.tool_calls ?? [],
      doneReason: body.done_reason ?? null,
      totalMs: Date.now() - started,
    };
  }
}

// ---- model doctor ----

const toolsCapableCache = new Map<string, boolean>();

export interface DoctorReport {
  up: boolean;
  installedTag: string | null; // the local model we'll use
  friendly: string | null;
  toolsCapable: boolean | null;
  visionCapable: boolean | null;
  loaded: boolean; // is it resident right now
  contextLength: number | null; // from /api/ps — real value, not config
  processor: string | null; // "your graphics card" | "your CPU" | "graphics card + CPU"
  sentence: string; // the plain-words card line
}

export async function runModelDoctor(): Promise<DoctorReport> {
  const report: DoctorReport = {
    up: false,
    installedTag: null,
    friendly: null,
    toolsCapable: null,
    visionCapable: null,
    loaded: false,
    contextLength: null,
    processor: null,
    sentence: "",
  };

  // 1 · is Ollama up, and which tag do we have?
  let tags: { name: string }[];
  try {
    const res = await ollamaFetch("/api/tags");
    if (!res.ok) throw new Error(`GET /api/tags ${res.status}`);
    tags = ((await res.json()).models ?? []) as { name: string }[];
  } catch {
    report.sentence = OLLAMA_DOWN_SENTENCE;
    return report;
  }
  report.up = true;
  const names = tags.map((t) => t.name);
  report.installedTag =
    localModelCandidates(getSettings().localModel).find((t) => names.includes(t)) ??
    null;
  if (!report.installedTag) {
    report.sentence = `No Qwen model is pulled yet — run: ollama pull ${LOCAL_DEFAULT}`;
    return report;
  }
  report.friendly = friendlyName(report.installedTag);

  // 2 · does it list the tools capability?
  try {
    const res = await ollamaFetch("/api/show", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: report.installedTag }),
    });
    if (res.ok) {
      const body = (await res.json()) as { capabilities?: string[] };
      const caps = body.capabilities ?? [];
      report.toolsCapable = caps.includes("tools");
      report.visionCapable = caps.includes("vision");
      toolsCapableCache.set(report.installedTag, report.toolsCapable);
    }
  } catch {
    // show failing is not fatal; the card just won't claim capabilities
  }

  // 3 · after first load: what's resident, its real context, and where it runs
  try {
    const res = await ollamaFetch("/api/ps");
    if (res.ok) {
      const body = (await res.json()) as {
        models?: {
          name: string;
          size?: number;
          size_vram?: number;
          context_length?: number;
        }[];
      };
      const loaded = (body.models ?? []).find(
        (m) => m.name === report.installedTag
      );
      if (loaded) {
        report.loaded = true;
        report.contextLength = loaded.context_length ?? null;
        const size = loaded.size ?? 0;
        const vram = loaded.size_vram ?? 0;
        report.processor =
          vram >= size && size > 0
            ? "your graphics card"
            : vram === 0
              ? "your CPU"
              : "graphics card + CPU";
      }
    }
  } catch {
    // ps failing is not fatal
  }

  if (report.loaded && report.contextLength && report.processor) {
    report.sentence = `${report.friendly} · ${Math.round(
      report.contextLength / 1024
    )}k memory · ${report.processor}`;
  } else {
    report.sentence = `${report.friendly} is pulled and ready — it loads on the first run.`;
  }
  return report;
}
