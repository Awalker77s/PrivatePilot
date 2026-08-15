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

// High-accuracy listening: NVIDIA Parakeet TDT 0.6b v3 (CC-BY-4.0) on the
// same whisper.cpp runtime — roughly half the word errors of base.en at
// equal-or-better CPU speed. 638 MB, downloaded once, opt-in.
const PARAKEET_FILE = "ggml-parakeet-tdt-0.6b-v3-q8_0.bin";
const PARAKEET_URL = `https://huggingface.co/ggml-org/parakeet-GGUF/resolve/main/${PARAKEET_FILE}`;

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

export async function parakeetPath(): Promise<string> {
  return join(await appDataDir(), "models", PARAKEET_FILE);
}

export async function parakeetReady(): Promise<boolean> {
  return exists(await parakeetPath());
}

export async function ensureParakeet(
  onProgress: (pct: number) => void
): Promise<void> {
  if (await parakeetReady()) return;
  const dir = await join(await appDataDir(), "models");
  await mkdir(dir, { recursive: true });
  const res = await pluginFetch(PARAKEET_URL, {
    signal: AbortSignal.timeout(1_800_000),
  });
  if (!res.ok) {
    throw new SttError(
      "no_model",
      `Couldn't download the high-accuracy model (${res.status}) — try again when you're online.`
    );
  }
  onProgress(50);
  const buf = new Uint8Array(await res.arrayBuffer());
  await writeFile(await parakeetPath(), buf);
  onProgress(100);
}

// First-use download with visible progress — 60 MB once, then never again.
export async function ensureModel(
  onProgress: (pct: number) => void
): Promise<void> {
  if (await parakeetReady()) return; // the high-accuracy model covers everything
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
    // High-accuracy path: Parakeet whenever it's downloaded (word-error rate
    // roughly half of base.en at better speed). Plain text out, no
    // timestamps — one synthetic segment keeps downstream unchanged.
    if (await parakeetReady()) {
      try {
        const text = ((await invoke("transcribe_wav_parakeet", {
          wavPath,
          modelPath: await parakeetPath(),
        })) as string).trim();
        if (text) {
          return { text, segments: [{ fromMs: 0, toMs: 0, text }] };
        }
      } catch {
        // fall through to whisper — never lose a recording to the upgrade
      }
    }
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
