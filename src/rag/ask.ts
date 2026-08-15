// Retrieve + build the grounded context for a question. The ANSWER is
// produced by the runner's tool loop (so number-verification, held-back, and
// citation post-validation all apply); this module does the retrieval and
// hands back numbered sources. Refuse-when-absent is enforced two ways: an
// empty retrieval returns a refusal here, and the loop forces the refusal
// string if the model answers with zero surviving citations.
import { b64ToVec, loadChunks, loadManifest, slugify } from "./store";
import { cosine, embedQuery } from "./embed";

export const RAG_REFUSAL = "I couldn't find that in your documents.";

export interface RagSource {
  n: number;
  docName: string;
  page: number;
  sourcePath: string;
  text: string;
}

export interface RagRetrieval {
  ok: boolean;
  sentence: string; // designed sentence when nothing usable
  sources: RagSource[];
  context: string; // numbered blocks for the prompt
}

const TOP_K = 6;

// A light keyword pass so exact numbers/dates/names that embeddings miss still
// surface — unioned with the dense hits.
function keywordScore(q: string, text: string): number {
  const terms = q.toLowerCase().match(/[a-z0-9$.]+/g) ?? [];
  const hay = text.toLowerCase();
  let hits = 0;
  for (const t of terms) if (t.length >= 3 && hay.includes(t)) hits++;
  return hits;
}

export async function retrieve(kbName: string, question: string): Promise<RagRetrieval> {
  const slug = slugify(kbName);
  const manifest = await loadManifest(slug);
  if (!manifest || manifest.documents.length === 0) {
    return {
      ok: false,
      sentence: `There's nothing in the "${kbName}" knowledge base yet — clean and file some documents into it first.`,
      sources: [],
      context: "",
    };
  }
  const chunks = await loadChunks(slug);
  if (chunks.length === 0) {
    return { ok: false, sentence: `The "${kbName}" knowledge base has no readable text yet.`, sources: [], context: "" };
  }

  const qv = await embedQuery(question);
  const scored = chunks.map((c) => ({
    c,
    dense: cosine(qv, b64ToVec(c.vec)),
    kw: keywordScore(question, c.text),
  }));
  // Dense top-K, then union in any strong keyword hits not already picked.
  scored.sort((a, b) => b.dense - a.dense);
  const picked = scored.slice(0, TOP_K);
  const pickedIds = new Set(picked.map((s) => s.c.id));
  const kwExtra = scored
    .filter((s) => !pickedIds.has(s.c.id) && s.kw >= 2)
    .sort((a, b) => b.kw - a.kw)
    .slice(0, 2);
  const final = [...picked, ...kwExtra];

  const sources: RagSource[] = final.map((s, i) => ({
    n: i + 1,
    docName: s.c.docName,
    page: s.c.page,
    sourcePath: manifest.documents.find((d) => d.docId === s.c.docId)?.sourcePath ?? "",
    text: s.c.text,
  }));
  const context = sources
    .map((s) => `[${s.n}] (${s.docName} p.${s.page})\n${s.text}`)
    .join("\n\n");
  return { ok: true, sentence: "", sources, context };
}
