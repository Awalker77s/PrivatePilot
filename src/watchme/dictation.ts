// Composer dictation — the ChatGPT/Wispr grammar: tap the mic and you are
// live instantly (optimistic start); the composer's right rail becomes a
// waveform + timer + ✕ + ✓; tap ✓ (or tap the mic again) and the transcript
// lands IN THE BOX, editable, never auto-sent. Hold >300ms = push-to-talk:
// release is the confirm. Silence never auto-stops — after ~10s quiet a
// gentle hint appears. Audio dies the moment transcription returns.
import { MicRecorder, CaptureError } from "./capture";
import { SttError, ensureModel, transcribe } from "./transcribe";

export type DictationState = "idle" | "listening" | "transcribing";

export interface DictationHandle {
  state: DictationState;
  level: number; // 0..1 live input level for the waveform
  startedAt: number; // for the elapsed timer
  hint: string | null; // "Still listening — tap ✓ when done"
  error: string | null;
}

type Listener = (h: DictationHandle) => void;

let mic: MicRecorder | null = null;
let analyser: AnalyserNode | null = null;
let audioCtx: AudioContext | null = null;
let levelTimer: ReturnType<typeof setInterval> | null = null;
let lastLoudAt = 0;
let handle: DictationHandle = {
  state: "idle",
  level: 0,
  startedAt: 0,
  hint: null,
  error: null,
};
const listeners = new Set<Listener>();

export function subscribeDictation(fn: Listener): () => void {
  listeners.add(fn);
  fn(handle);
  return () => listeners.delete(fn);
}

function set(patch: Partial<DictationHandle>) {
  handle = { ...handle, ...patch };
  for (const fn of listeners) fn(handle);
}

export function dictationState(): DictationHandle {
  return handle;
}

export async function startDictation(): Promise<void> {
  if (handle.state !== "idle") return;
  // Optimistic: live the instant you tap — roll back only if the mic says no.
  set({ state: "listening", startedAt: Date.now(), hint: null, error: null });
  lastLoudAt = Date.now();
  mic = new MicRecorder();
  try {
    await mic.start();
  } catch (e) {
    mic = null;
    set({
      state: "idle",
      error:
        e instanceof CaptureError
          ? e.sentence
          : "The microphone wasn't allowed.",
    });
    return;
  }
  // Live level meter + silence hint from the same consented stream.
  try {
    const stream = mic.mediaStream;
    if (!stream) throw new Error("no stream");
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    levelTimer = setInterval(() => {
      analyser!.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
      if (peak > 0.05) lastLoudAt = Date.now();
      // Never auto-stop on silence — Windows voice typing's most hated move.
      const quiet = Date.now() - lastLoudAt > 10_000;
      set({
        level: peak,
        hint: quiet ? "Still listening — tap ✓ when done" : null,
      });
    }, 80);
  } catch {
    // no meter is fine — the state still shows
  }
}

async function teardownMeter() {
  if (levelTimer) clearInterval(levelTimer);
  levelTimer = null;
  analyser = null;
  await audioCtx?.close().catch(() => {});
  audioCtx = null;
}

export async function stopDictation(): Promise<string | null> {
  if (handle.state !== "listening" || !mic) return null;
  set({ state: "transcribing", level: 0, hint: null });
  await teardownMeter();
  const blob = await mic.stop();
  mic = null;
  if (!blob) {
    set({ state: "idle", error: "I didn't catch any audio." });
    return null;
  }
  try {
    await ensureModel(() => {});
    const t = await transcribe(blob);
    set({ state: "idle" });
    return t.text;
  } catch (e) {
    set({
      state: "idle",
      error:
        e instanceof SttError
          ? e.sentence
          : `Listening back broke — ${String(e).slice(0, 80)}`,
    });
    return null;
  }
}

export function cancelDictation(): void {
  void teardownMeter();
  mic?.discard();
  mic = null;
  set({ state: "idle", level: 0, hint: null });
}

export function dictationElapsedMs(): number {
  return handle.state === "listening" ? Date.now() - handle.startedAt : 0;
}
