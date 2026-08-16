// Provider registry + active-model resolution. Featherless joins in step 8;
// capability flags decide which pipeline defenses are available per model.
import { OllamaProvider, friendlyName, localModelCandidates } from "./ollama";
import { FeatherlessProvider } from "./featherless";
import type { ChatRequest, ChatResponse, ModelInfo, ModelProvider } from "./types";
import { getSettings, updateSettings } from "../storage/settings";

export const ollama = new OllamaProvider();
export const featherless = new FeatherlessProvider();

export type Effort = "quick" | "thorough";

// The drafting prompt and its constrained JSON response fit below 8k for
// ordinary requests. Reserving 16k made CPU-only Ollama allocate twice the KV
// cache and pushed simple drafts past the two-minute ceiling.
export const NUM_CTX_DRAFT = 8192;
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
  return localModelCandidates(getSettings().localModel).find((t) =>
    names.includes(t)
  ) ?? null;
}

// ONE brain at a time, and picking it is the only way to switch. Borrowing is
// not a separate switch that can sit on behind a local choice: choosing a
// local model turns it off, choosing a cloud model turns it on. Every surface
// (composer picker, Settings model list, Settings cloud card) calls these, so
// "cloud is on" always means exactly "a Featherless model is the brain".
export async function useLocalBrain(tag: string): Promise<void> {
  const previous = await activeLocalModel().catch(() => null);
  await updateSettings((s) => {
    s.localModel = tag || null;
    s.featherless.enabled = false;
  });
  if (previous && previous !== tag) {
    await ollama.unload(previous).catch(() => {});
  }
}

export async function useCloudBrain(model: string): Promise<void> {
  const previous = await activeLocalModel().catch(() => null);
  await updateSettings((s) => {
    s.featherless.model = model;
    s.featherless.enabled = true;
  });
  if (previous) await ollama.unload(previous).catch(() => {});
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
