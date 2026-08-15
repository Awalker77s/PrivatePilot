// Recursive chunker: split on blank lines → lines → sentences, targeting
// ~512 tokens (~2000 chars) per chunk with near-zero overlap (a 2026 study
// found overlap gave no measurable benefit at this scale). Page metadata
// carries through so a citation can name where a fact came from.
export interface Chunk {
  id: string; // `${docId}#${i}`
  docId: string;
  page: number;
  text: string;
}

const TARGET = 2000;
const HARD_MAX = 3200;

function splitRecursive(text: string): string[] {
  if (text.length <= HARD_MAX) return [text];
  // Try paragraphs, then lines, then sentences.
  for (const sep of [/\n\s*\n/, /\n/, /(?<=[.!?])\s+/]) {
    const parts = text.split(sep).filter((p) => p.trim().length > 0);
    if (parts.length > 1) {
      const out: string[] = [];
      let buf = "";
      for (const p of parts) {
        if (buf && (buf.length + p.length) > TARGET) {
          out.push(buf.trim());
          buf = "";
        }
        buf += (buf ? "\n" : "") + p;
        if (buf.length > HARD_MAX) {
          // one part is itself huge — recurse into it
          out.push(...splitRecursive(buf));
          buf = "";
        }
      }
      if (buf.trim()) out.push(buf.trim());
      return out;
    }
  }
  // No separators — hard-slice.
  const out: string[] = [];
  for (let i = 0; i < text.length; i += TARGET) out.push(text.slice(i, i + TARGET));
  return out;
}

// A document's text may carry `=== name ===` page/section banners (the OCR
// tool emits one per file). Split on those first so each page's chunks keep
// their page number.
export function chunkDocument(docId: string, text: string): Chunk[] {
  const sections = text.split(/^===\s.+\s===$/m);
  const banners = [...text.matchAll(/^===\s(.+)\s===$/gm)].map((m) => m[1]);
  const blocks: { page: number; text: string }[] = [];
  if (banners.length > 0) {
    // sections[0] is preamble before the first banner (usually empty)
    for (let i = 1; i < sections.length; i++) {
      const body = sections[i]?.trim();
      if (body) blocks.push({ page: i, text: body });
    }
  } else {
    blocks.push({ page: 1, text: text.trim() });
  }
  const chunks: Chunk[] = [];
  let n = 0;
  for (const b of blocks) {
    for (const piece of splitRecursive(b.text)) {
      if (piece.replace(/\s+/g, "").length < 8) continue; // skip empty scraps
      chunks.push({ id: `${docId}#${n}`, docId, page: b.page, text: piece });
      n++;
    }
  }
  return chunks;
}
