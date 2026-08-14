// Provider registry + active-model resolution. Featherless joins in step 8;
// capability flags decide which pipeline defenses are available per model.
import {
  LOCAL_DEFAULT,
  LOCAL_FALLBACKS,
  OllamaProvider,
  friendlyName,
} from "./ollama";
import type { ChatRequest, ChatResponse, ModelInfo, ModelProvider } from "./types";

export const ollama = new OllamaProvider();

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

export function activeProvider(): ModelProvider {
  return ollama; // step 8 swaps this per the Featherless toggle
}

export async function activeModelLabel(): Promise<string> {
  const tag = await activeLocalModel();
  return tag ? friendlyName(tag) : "No model";
}

export async function chat(req: ChatRequest): Promise<ChatResponse> {
  return activeProvider().chat(req);
}
