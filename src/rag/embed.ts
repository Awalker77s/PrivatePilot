// The embedding layer — the load-bearing correctness detail is the nomic task
// prefixes: "search_document: " on every chunk, "search_query: " on every
// question. Ollama does NOT add them; skipping quietly wrecks retrieval (no
// error, just worse hits). The prefix lives ONLY in the string sent to the
// model — never stored, never shown in a citation.
import { ollama } from "../providers";

export const EMBED_MODEL = "nomic-embed-text:latest";
export const EMBED_DIM = 768;
const BATCH = 48;

// L2-normalize so cosine similarity == dot product (cheap at query time).
function normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

async function embedBatched(prefixed: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < prefixed.length; i += BATCH) {
    const slice = prefixed.slice(i, i + BATCH);
    const vecs = await ollama.embed(EMBED_MODEL, slice);
    for (const v of vecs) out.push(normalize(v));
  }
  return out;
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  return embedBatched(texts.map((t) => `search_document: ${t}`));
}

export async function embedQuery(question: string): Promise<number[]> {
  const [v] = await embedBatched([`search_query: ${question}`]);
  return v;
}

export function cosine(a: number[], b: number[]): number {
  // Both are pre-normalized, so this is a plain dot product.
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
