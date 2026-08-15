// Keyframe selection: every ~2s frame gets a 64-bit dHash; keep a frame only
// if it differs enough from the last kept one (or is first/last). Cap 10 —
// on overflow, evict the frame whose transition added the least. The counter
// the UI shows is real, and burn() nulls every byte.

export interface Keyframe {
  blob: Blob; // 1280px-wide JPEG
  thumbUrl: string; // small data URL for the consent strip
  tMs: number;
  hash: bigint;
  dropped: boolean; // user dropped it from the consent strip
}

const MAX_FRAMES = 10;
const HAMMING_KEEP = 8;
const TARGET_WIDTH = 1280;
const THUMB_WIDTH = 168;

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

function dHash(bitmap: ImageBitmap): bigint {
  const c = document.createElement("canvas");
  c.width = 9;
  c.height = 8;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, 9, 8);
  const { data } = ctx.getImageData(0, 0, 9, 8);
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 9 + x) * 4;
      const j = (y * 9 + x + 1) * 4;
      const l1 = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      const l2 = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
      hash = (hash << 1n) | (l1 > l2 ? 1n : 0n);
    }
  }
  return hash;
}

async function downscale(
  bitmap: ImageBitmap,
  width: number,
  quality: number
): Promise<Blob> {
  const scale = Math.min(1, width / bitmap.width);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve, reject) =>
    c.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      quality
    )
  );
}

async function thumbDataUrl(bitmap: ImageBitmap): Promise<string> {
  const blob = await downscale(bitmap, THUMB_WIDTH, 0.6);
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(blob);
  });
}

export class KeyframeStore {
  frames: Keyframe[] = [];
  onChange: (() => void) | null = null;

  get held(): number {
    return this.frames.filter((f) => !f.dropped).length;
  }

  async offer(bitmap: ImageBitmap, tMs: number): Promise<void> {
    const hash = dHash(bitmap);
    const last = this.frames[this.frames.length - 1];
    // Keep iff first, or different enough from the last kept frame.
    if (last && hamming(last.hash, hash) < HAMMING_KEEP) {
      bitmap.close();
      return;
    }
    const [blob, thumbUrl] = await Promise.all([
      downscale(bitmap, TARGET_WIDTH, 0.75),
      thumbDataUrl(bitmap),
    ]);
    bitmap.close();
    this.frames.push({ blob, thumbUrl, tMs, hash, dropped: false });

    if (this.frames.length > MAX_FRAMES) {
      // Evict the middle frame with the smallest transition distance —
      // first and last always survive.
      let evictIdx = 1;
      let smallest = Infinity;
      for (let i = 1; i < this.frames.length - 1; i++) {
        const d =
          hamming(this.frames[i - 1].hash, this.frames[i].hash) +
          hamming(this.frames[i].hash, this.frames[i + 1].hash);
        if (d < smallest) {
          smallest = d;
          evictIdx = i;
        }
      }
      this.frames.splice(evictIdx, 1);
    }
    this.onChange?.();
  }

  drop(tMs: number): void {
    const f = this.frames.find((f) => f.tMs === tMs);
    if (f) {
      f.dropped = true;
      this.onChange?.();
    }
  }

  kept(): Keyframe[] {
    return this.frames.filter((f) => !f.dropped);
  }

  // Deletion as a UI event: every reference nulled, counter hits zero.
  burn(): void {
    this.frames = [];
    this.onChange?.();
  }
}

export async function keyframeToBase64(frame: Keyframe): Promise<string> {
  const buf = await frame.blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
