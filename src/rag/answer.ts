// Answer a question from a knowledge base, grounded and honest: the model may
// use ONLY the retrieved sources, must cite them, and if the answer isn't
// there it says so. Refusal is enforced in code, not just asked for — an
// answer with zero surviving citations becomes the refusal string.
import { chat } from "../providers";
import { activeLocalModel } from "../providers";
import { NUM_CTX_TOOLS } from "../providers";
import { RAG_REFUSAL, RagSource, retrieve } from "./ask";

export interface RagAnswer {
  ok: boolean;
  answer: string;
  refused: boolean;
  citations: { n: number; docName: string; page: number; sourcePath: string }[];
  sources: RagSource[];
}

const SYSTEM = [
  "You answer a question using ONLY the numbered sources provided — the person's own documents.",
  "After each fact, cite the source number(s) in square brackets like [1] or [2][3].",
  "If the answer is not in the sources, reply with exactly this and nothing else: " + JSON.stringify(RAG_REFUSAL),
  "Do not use any outside knowledge. Do not guess. Quote numbers and names exactly as they appear.",
  "Answer in at most four sentences.",
].join("\n");

export async function answerFromKb(
  kbName: string,
  question: string,
  modelOverride?: string
): Promise<RagAnswer> {
  const r = await retrieve(kbName, question);
  if (!r.ok) {
    return { ok: false, answer: r.sentence, refused: true, citations: [], sources: [] };
  }
  const model = modelOverride ?? (await activeLocalModel());
  if (!model) {
    return { ok: false, answer: "The local AI isn't running.", refused: true, citations: [], sources: r.sources };
  }
  const res = await chat({
    model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Sources:\n\n${r.context}\n\nQuestion: ${question}` },
    ],
    options: { num_ctx: NUM_CTX_TOOLS, temperature: 0.2 },
    think: false,
  });
  const raw = res.content.trim();

  // Citation post-validation: keep only [n] that map to a served source.
  const cited = new Set(
    [...raw.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])).filter((n) => r.sources.some((s) => s.n === n))
  );
  const isRefusal = raw.toLowerCase().includes(RAG_REFUSAL.toLowerCase().slice(0, 24));

  // Force the refusal when the model answered without a single valid citation
  // (grounding guardrail — a citation-free answer is ungrounded by definition).
  if (!isRefusal && cited.size === 0) {
    return { ok: true, answer: RAG_REFUSAL, refused: true, citations: [], sources: r.sources };
  }
  if (isRefusal) {
    return { ok: true, answer: RAG_REFUSAL, refused: true, citations: [], sources: r.sources };
  }

  const citations = [...cited].sort((a, b) => a - b).map((n) => {
    const s = r.sources.find((x) => x.n === n)!;
    return { n, docName: s.docName, page: s.page, sourcePath: s.sourcePath };
  });
  return { ok: true, answer: raw, refused: false, citations, sources: r.sources };
}
