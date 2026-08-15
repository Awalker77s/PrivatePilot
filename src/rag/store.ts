// A knowledge base is a named collection of indexed documents, stored under
// %APPDATA%/PrivatePilot/kb/<slug>/: a kb.json manifest (atomic) + a
// vectors.json of {chunk metadata + base64 Float32×768}. Plain-TS cosine over
// this is a few ms at thousands of chunks — comfortably past this app's scale;
// the documented upgrade past ~30k chunks is sqlite-vec (not now).
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile } from "@tauri-apps/plugin-fs";
import { atomicWriteText } from "../storage/atomic";
import { EMBED_DIM, EMBED_MODEL } from "./embed";
import type { Chunk } from "./chunk";

export interface KbDocument {
  docId: string;
  name: string; // human name, e.g. "receipt-1"
  sourcePath: string; // the kept searchable PDF / text, for citation open
  sha256: string;
  chunkCount: number;
  indexedAt: number;
}

export interface KbManifest {
  slug: string;
  name: string;
  embedModel: string;
  dim: number;
  documents: KbDocument[];
}

export interface StoredChunk extends Chunk {
  docName: string;
  vec: string; // base64 of Float32Array(768)
}

export function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // A fully non-Latin name (Cyrillic, CJK, Arabic, emoji) strips to "" and
  // would collapse to the single slug "kb", merging every such KB into one.
  // Give it a deterministic hash of the original so each name is distinct.
  if (base) return base;
  return `kb-${nameHash(name)}`;
}

function nameHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

async function kbDir(slug: string): Promise<string> {
  return join(await appDataDir(), "kb", slug);
}

export async function listKnowledgeBases(): Promise<KbManifest[]> {
  try {
    const root = await join(await appDataDir(), "kb");
    if (!(await exists(root))) return [];
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const entries = await readDir(root);
    const out: KbManifest[] = [];
    for (const e of entries) {
      if (!e.isDirectory) continue;
      const m = await loadManifest(e.name);
      if (m) out.push(m);
    }
    return out;
  } catch {
    return [];
  }
}

export async function loadManifest(slug: string): Promise<KbManifest | null> {
  try {
    const p = await join(await kbDir(slug), "kb.json");
    if (!(await exists(p))) return null;
    return JSON.parse(await readTextFile(p)) as KbManifest;
  } catch {
    return null;
  }
}

export async function saveManifest(m: KbManifest): Promise<void> {
  const dir = await kbDir(m.slug);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  await atomicWriteText(await join(dir, "kb.json"), JSON.stringify(m, null, 2));
}

export async function loadChunks(slug: string): Promise<StoredChunk[]> {
  try {
    const p = await join(await kbDir(slug), "vectors.json");
    if (!(await exists(p))) return [];
    return JSON.parse(await readTextFile(p)) as StoredChunk[];
  } catch {
    return [];
  }
}

export async function saveChunks(slug: string, chunks: StoredChunk[]): Promise<void> {
  const dir = await kbDir(slug);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  await atomicWriteText(await join(dir, "vectors.json"), JSON.stringify(chunks));
}

// Float32 vector ⇄ base64 (compact, and avoids JSON number bloat).
export function vecToB64(v: number[]): string {
  const f = new Float32Array(v);
  const bytes = new Uint8Array(f.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function b64ToVec(b64: string): number[] {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const f = new Float32Array(bytes.buffer);
  return Array.from(f);
}

export function emptyManifest(slug: string, name: string): KbManifest {
  return { slug, name, embedModel: EMBED_MODEL, dim: EMBED_DIM, documents: [] };
}
