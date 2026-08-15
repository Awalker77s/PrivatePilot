// Watch-me capture: screen keyframes + narration, pure web APIs (WebView2 is
// Evergreen Chromium — getDisplayMedia's picker rendered in the window IS the
// consent moment; the mic gets WebView2's one-time bubble). Everything stays
// in JS memory; nothing touches disk until the narration WAV, which is
// deleted the moment transcription returns.

export type ScreenFailure = "denied" | "unsupported" | "no_frames";
export type MicFailure = "denied" | "unsupported" | "no_audio";

// The seam that makes the whole feature testable without a human: the
// pipeline consumes FrameSource, and a fixture source replays PNGs.
export interface FrameSource {
  start(onFrame: (frame: ImageBitmap, tMs: number) => void): Promise<void>;
  stop(): void;
  onEnded?: () => void; // user can stop the share from Windows' own UI
}

export class CaptureError extends Error {
  constructor(
    public kind: ScreenFailure | MicFailure,
    public sentence: string
  ) {
    super(sentence);
  }
}

const FRAME_EVERY_MS = 2000;

export class DisplayFrameSource implements FrameSource {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  onEnded?: () => void;

  async start(onFrame: (frame: ImageBitmap, tMs: number) => void): Promise<void> {
    if (!navigator.mediaDevices || !("getDisplayMedia" in navigator.mediaDevices)) {
      throw new CaptureError(
        "unsupported",
        "This computer's webview can't share the screen — I'll compile from your words alone."
      );
    }
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5 } },
        audio: false,
      });
    } catch {
      throw new CaptureError(
        "denied",
        "No screen was shared — I'll compile from your words alone."
      );
    }
    const track = this.stream.getVideoTracks()[0];
    track.addEventListener("ended", () => this.onEnded?.());

    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.srcObject = this.stream;
    this.video = video;
    await video.play().catch(() => {});

    // Wait for the first real frame before sampling.
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new CaptureError(
              "no_frames",
              "The shared screen never sent a frame — I'll compile from your words alone."
            )
          ),
        6000
      );
      (video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => void;
      }).requestVideoFrameCallback?.(() => {
        clearTimeout(timeout);
        resolve();
      }) ??
        video.addEventListener("loadeddata", () => {
          clearTimeout(timeout);
          resolve();
        });
    });

    const grab = async () => {
      if (!this.video || this.video.videoWidth === 0) return;
      try {
        const bitmap = await createImageBitmap(this.video);
        onFrame(bitmap, Date.now() - started);
      } catch {
        // a single missed grab is not an event
      }
    };
    await grab(); // always keep the first frame
    this.timer = setInterval(grab, FRAME_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
  }
}

// Dev/test source: replays fixture images on a fake 2s clock.
export class FixtureFrameSource implements FrameSource {
  onEnded?: () => void;
  constructor(private urls: string[]) {}
  async start(onFrame: (frame: ImageBitmap, tMs: number) => void): Promise<void> {
    let t = 0;
    for (const url of this.urls) {
      const blob = await (await fetch(url)).blob();
      const bitmap = await createImageBitmap(blob);
      onFrame(bitmap, t);
      t += FRAME_EVERY_MS;
    }
  }
  stop(): void {}
}

export class MicRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  async start(): Promise<void> {
    if (!navigator.mediaDevices || !("getUserMedia" in navigator.mediaDevices)) {
      throw new CaptureError(
        "unsupported",
        "This computer's webview can't reach a microphone."
      );
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      throw new CaptureError(
        "denied",
        name === "NotReadableError"
          ? "The microphone is busy in another app."
          : "The microphone wasn't allowed — check Windows Settings › Privacy › Microphone."
      );
    }
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm",
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(1000);
  }

  async stop(): Promise<Blob | null> {
    const recorder = this.recorder;
    if (!recorder) return null;
    const done = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    if (recorder.state !== "inactive") recorder.stop();
    await done;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    const blob = new Blob(this.chunks, { type: "audio/webm" });
    this.chunks = [];
    return blob.size > 0 ? blob : null;
  }

  discard(): void {
    this.recorder?.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}
