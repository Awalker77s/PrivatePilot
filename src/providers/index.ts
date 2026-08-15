// Provider registry + active-model resolution. Featherless joins in step 8;
// capability flags decide which pipeline defenses are available per model.
import {
  LOCAL_DEFAULT,
  LOCAL_FALLBACKS,
  OllamaProvider,
  friendlyName,
} from "./ollama";
import { FeatherlessProvider } from "./featherless";
import type { ChatRequest, ChatResponse, ModelInfo, ModelProvider } from "./types";
import { getSettings } from "../storage/settings";

export const ollama = new OllamaProvider();
export const featherless = new FeatherlessProvider();

export type Effort = "quick" | "thorough";

// Stage-tuned context sizes: 16384 drafting/validator, 32768 tool loop.
export const NUM_CTX_DRAFT = 16384;
export const NUM_CTX_TOOLS = 32768;

let cachedLocalModels: ModelInfo[] | null = null;

export async function localModels(refresh = false): Promise<ModelInfo[]> {
  if (!cachedLocalModels || refresh) {
    cachedLocalModels = await ollama.listModels();
  }
  return cachedLocalModels;
}

// The local model the app uses: the pack's default, then its fallbacks,
// then nothing (the doctor says what to pull).
export async function activeLocalModel(): Promise<string | null> {
  const models = await localModels();
  const names = models.map((m) => m.id);
  return (
    [LOCAL_DEFAULT, ...LOCAL_FALLBACKS].find((t) => names.includes(t)) ?? null
  );
}

// The toggle decides where compute happens — and the UI never lies about it.
export function cloudActive(): boolean {
  const f = getSettings().featherless;
  return f.enabled && !!f.key;
}

export function activeProvider(): ModelProvider {
  return cloudActive() ? featherless : ollama;
}

// The honest line every run record stores.
export function ranOnLabel(): string {
  return cloudActive() ? `featherless:${getSettings().featherless.model}` : "local";
}

export async function activeModelLabel(): Promise<string> {
  if (cloudActive()) return getSettings().featherless.model;
  const tag = await activeLocalModel();
  return tag ? friendlyName(tag) : "No model";
}

export async function chat(req: ChatRequest): Promise<ChatResponse> {
  if (cloudActive()) {
    // Same pipeline, different computer: swap the local tag for the chosen
    // cloud model; grammar-locked drafting is local-only, so format falls
    // back to json_object inside the provider.
    return featherless.chat({
      ...req,
      model: getSettings().featherless.model,
    });
  }
  return ollama.chat(req);
}
