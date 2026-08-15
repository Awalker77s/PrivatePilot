// Index documents into a knowledge base: chunk → embed → store. Dedup on the
// content SHA-256 so the same scanned invoice arriving via Gmail AND Outlook
// indexes once. Incremental: appends to the existing store.
import { chunkDocument } from "./chunk";
import { embedDocuments } from "./embed";
import {
  KbManifest,
  StoredChunk,
  emptyManifest,
  loadChunks,
  loadManifest,
  saveChunks,
  saveManifest,
  slugify,
  vecToB64,
} from "./store";

export interface IndexInput {
  name: string; // "receipt-1"
  text: string; // the OCR/extracted text
  sourcePath: string; // the kept searchable PDF (for citation open)
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface IndexResult {
  kb: string;
  added: number; // documents newly indexed
  skipped: number; // already present (same sha)
  chunks: number; // chunks added
}

export async function indexDocuments(
  kbName: string,
  docs: IndexInput[]
): Promise<IndexResult> {
  const slug = slugify(kbName);
  const manifest: KbManifest = (await loadManifest(slug)) ?? emptyManifest(slug, kbName);
  const existing = new Set(manifest.documents.map((d) => d.sha256));
  const stored = await loadChunks(slug);

  let added = 0;
  let skipped = 0;
  let newChunks = 0;

  for (const doc of docs) {
    const text = doc.text.trim();
    if (!text) continue;
    const sha = await sha256(text);
    if (existing.has(sha)) {
      skipped++;
      continue;
    }
    const docId = sha.slice(0, 12);
    const chunks = chunkDocument(docId, text);
    if (chunks.length === 0) continue;
    const vectors = await embedDocuments(chunks.map((c) => c.text));
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      stored.push({ ...c, docName: doc.name, vec: vecToB64(vectors[i]) } as StoredChunk);
    }
    manifest.documents.push({
      docId,
      name: doc.name,
      sourcePath: doc.sourcePath,
      sha256: sha,
      chunkCount: chunks.length,
      indexedAt: Date.now(),
    });
    existing.add(sha);
    added++;
    newChunks += chunks.length;
  }

  if (added > 0) {
    await saveChunks(slug, stored);
    await saveManifest(manifest);
  }
  return { kb: kbName, added, skipped, chunks: newChunks };
}
