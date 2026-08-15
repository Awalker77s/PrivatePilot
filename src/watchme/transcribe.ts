// Narration → local transcript. whisper-cli (bundled, v1.9.2) with
// ggml-base.en-q5_1 (59.7 MB), downloaded once into app data. The WAV lives
// in app data only for the seconds transcription takes — deleted in finally.
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, remove, writeFile } from "@tauri-apps/plugin-fs";
import { fetch as pluginFetch } from "@tauri-apps/plugin-http";
import { webmToWav16k } from "./wav";

const MODEL_FILE = "ggml-base.en-q5_1.bin";
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`;
const MODEL_BYTES = 59_721_011;

export interface TranscriptSegment {
  fromMs: number;
  toMs: number;
  text: string;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
}

export class SttError extends Error {
  constructor(
    public kind: "no_model" | "no_sidecar" | "decode_failed" | "heard_nothing" | "failed",
    public sentence: string
  ) {
    super(sentence);
  }
}

export async function modelPath(): Promise<string> {
  return join(await appDataDir(), "models", MODEL_FILE);
}

export async function modelReady(): Promise<boolean> {
  return exists(await modelPath());
}

// First-use download with visible progress — 60 MB once, then never again.
export async function ensureModel(
  onProgress: (pct: number) => void
): Promise<void> {
  if (await modelReady()) return;
  const dir = await join(await appDataDir(), "models");
  await mkdir(dir, { recursive: true });
  const res = await pluginFetch(MODEL_URL, {
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    throw new SttError(
      "no_model",
      `Couldn't download the listening model (${res.status}) — try again when you're online.`
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  onProgress(Math.round((buf.length / MODEL_BYTES) * 100));
  await writeFile(await modelPath(), buf);
  onProgress(100);
}

export async function transcribe(narration: Blob): Promise<Transcript> {
  let wav: Uint8Array;
  try {
    wav = await webmToWav16k(narration);
  } catch (e) {
    throw new SttError(
      "decode_failed",
      `Couldn't decode the recording — ${String(e).slice(0, 80)}`
    );
  }

  const dir = await join(await appDataDir(), "temp");
  await mkdir(dir, { recursive: true });
  const wavPath = await join(dir, `narration-${Date.now()}.wav`);
  await writeFile(wavPath, wav);

  try {
    const json = (await invoke("transcribe_wav", {
      wavPath,
      modelPath: await modelPath(),
    })) as string;
    const parsed = JSON.parse(json) as {
      transcription?: {
        offsets?: { from: number; to: number };
        text: string;
      }[];
    };
    const segments: TranscriptSegment[] = (parsed.transcription ?? []).map(
      (s) => ({
        fromMs: s.offsets?.from ?? 0,
        toMs: s.offsets?.to ?? 0,
        text: s.text.trim(),
      })
    );
    const text = segments
      .map((s) => s.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      throw new SttError(
        "heard_nothing",
        "I couldn't hear you — type what you did instead."
      );
    }
    return { text, segments };
  } catch (e) {
    if (e instanceof SttError) throw e;
    const s = String(e);
    if (s.includes("NoSidecar")) {
      throw new SttError(
        "no_sidecar",
        "The listening engine isn't installed with this build."
      );
    }
    throw new SttError("failed", `Listening back broke — ${s.slice(0, 100)}`);
  } finally {
    // Half of "burns to zero": the narration never outlives this call.
    await remove(wavPath).catch(() => {});
  }
}
