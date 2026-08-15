// OllamaProvider — every network call goes through plugin-http (never
// window.fetch: the packaged origin http://tauri.localhost is not on Ollama's
// CORS allowlist, so window.fetch dies only in the build you demo).
import { fetch } from "@tauri-apps/plugin-http";
import {
  ChatRequest,
  ChatResponse,
  ModelInfo,
  ModelProvider,
  ProviderError,
} from "./types";

const OLLAMA = "http://127.0.0.1:11434";

export const OLLAMA_DOWN_SENTENCE =
  "The local AI isn't running — start Ollama, then try again.";

// Local default and fallbacks, verified in Ollama's library (Aug 2026).
export const LOCAL_DEFAULT = "qwen3.5:9b";
export const LOCAL_FALLBACKS = ["qwen3.5:4b", "qwen2.5:7b"];

const FRIENDLY: Record<string, string> = {
  "qwen3.5:9b": "Qwen 9B",
  "qwen3.5:4b": "Qwen 4B",
  "qwen2.5:7b": "Qwen 7B",
  "qwen3-vl:4b": "Qwen Vision 4B",
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
  init?: Parameters<typeof fetch>[1]
): Promise<Response> {
  try {
    return await fetch(`${OLLAMA}${path}`, init);
  } catch (e) {
    throw new ProviderError(OLLAMA_DOWN_SENTENCE, String(e));
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
    [LOCAL_DEFAULT, ...LOCAL_FALLBACKS].find((t) => names.includes(t)) ?? null;
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
