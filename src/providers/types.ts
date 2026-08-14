// ModelProvider — list models · chat · capability flags. The pipeline picks
// stage configs; the provider enforces the wire rules (num_ctx explicit,
// format XOR tools, keep_alive on every call).

export interface ModelInfo {
  id: string; // raw tag / repo id
  label: string; // friendly name — surfaces never show raw IDs for local models
  sizeBytes: number | null;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ChatOptions {
  num_ctx: number; // REQUIRED explicitly on every call — Ollama's 4,096 default truncates silently
  temperature: number;
  top_p?: number;
  top_k?: number;
  seed?: number;
  max_tokens?: number; // cloud runs cap output (~1500–2000)
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  format?: Record<string, unknown>; // JSON schema — stages 1–2
  tools?: ToolDef[]; // stage 3 — NEVER together with format
  options: ChatOptions;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  doneReason: string | null;
  totalMs: number;
}

export class ProviderError extends Error {
  constructor(
    public sentence: string, // the designed sentence the user sees
    public detail: string
  ) {
    super(sentence);
  }
}

export interface ModelProvider {
  id: "ollama" | "featherless";
  label: string;
  listModels(): Promise<ModelInfo[]>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  supportsSchemaFormat(model: string): boolean;
  supportsTools(model: string): boolean;
}
