// Vision enrichment: 8–10 keyframes in ONE /api/chat message to the local
// vision model. Two traps handled: Ollama silently fuses consecutive
// same-size images into "video frames" (so every image gets a labeled text
// slot between it and the next), and some VL stacks return empty content on
// multi-image (a one-time two-square probe catches both). Facts only —
// the model reports what is visible, never inferred clicks.
import { z } from "zod";
import { ollama } from "../providers";
import { NUM_CTX_TOOLS } from "../providers";
import { getSettings, updateSettings } from "../storage/settings";
import { Keyframe, keyframeToBase64 } from "./keyframes";
import type { TranscriptSegment } from "./transcribe";

const EnrichmentSchema = z.object({
  frames: z.array(
    z.object({
      index: z.int(),
      app_or_site: z.string(),
      visible_url: z.string(),
      page_title: z.string(),
      key_ui_text: z.array(z.string()),
    })
  ),
  entities: z.object({
    urls: z.array(z.string()),
    files: z.array(z.string()),
    typed_values: z.array(z.string()),
  }),
  candidate_task_sentence: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
});

export type Enrichment = z.infer<typeof EnrichmentSchema>;

// One-time probe per model tag: two solid squares, count + colors. Catches
// the same-size image-merge bug and the empty-multi-image bug in one shot.
async function probeVision(model: string): Promise<boolean> {
  const cached = getSettings().visionProbe?.[model];
  if (cached !== undefined) return cached;

  const square = (color: string): string => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 64, 64);
    return c.toDataURL("image/jpeg", 0.9).split(",")[1];
  };

  let ok = false;
  try {
    const res = await ollama.chat({
      model,
      messages: [
        {
          role: "user",
          content:
            "IMAGE 1: [first image]\nIMAGE 2: [second image]\nHow many images did you receive, and what solid color fills each one?",
          images: [square("#ff0000"), square("#0000ff")],
        },
      ],
      format: z.toJSONSchema(
        z.object({ how_many: z.int(), colors: z.array(z.string()) }),
        { target: "draft-07" }
      ) as Record<string, unknown>,
      options: { num_ctx: 8192, temperature: 0 },
      think: false,
    });
    const parsed = JSON.parse(res.content) as {
      how_many: number;
      colors: string[];
    };
    const colorsSeen = parsed.colors.join(" ").toLowerCase();
    ok =
      parsed.how_many === 2 &&
      colorsSeen.includes("red") &&
      colorsSeen.includes("blue");
  } catch {
    ok = false;
  }
  await updateSettings((s) => {
    s.visionProbe = { ...(s.visionProbe ?? {}), [model]: ok };
  });
  return ok;
}

export class VisionUnavailable extends Error {
  constructor(public sentence: string) {
    super(sentence);
  }
}

function fmtT(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export async function enrichFrames(
  model: string,
  frames: Keyframe[],
  segments: TranscriptSegment[]
): Promise<Enrichment> {
  if (!(await probeVision(model))) {
    throw new VisionUnavailable(
      "I couldn't watch the screen, so I compiled from your words alone."
    );
  }

  const attempt = async (useFrames: Keyframe[]): Promise<Enrichment> => {
    const images = await Promise.all(useFrames.map(keyframeToBase64));
    // Interleaved labels — mandatory: consecutive same-size images otherwise
    // fuse into a single "video" in the runtime.
    const frameLines = useFrames
      .map((f, i) => `FRAME ${i + 1} (t=${fmtT(f.tMs)}): [image ${i + 1}]`)
      .join("\n");
    const narration = segments
      .map((s) => `[${fmtT(s.fromMs)}] ${s.text}`)
      .join("\n");
    const res = await ollama.chat({
      model,
      messages: [
        {
          role: "user",
          content: [
            `These are ${useFrames.length} ordered snapshots of one user demonstration, each labeled with its capture time, plus the user's spoken narration.`,
            frameLines,
            "",
            "NARRATION:",
            narration || "(none)",
            "",
            "For each frame report ONLY what is visible: the app or website, any URL in an address bar, the page or window title, and key labels, values, or buttons on screen. Then list every exact URL, filename, and typed value seen anywhere across the frames. Finally give ONE sentence describing the task being demonstrated. If something is unclear, write \"unclear\" — never guess.",
          ].join("\n"),
          images,
        },
      ],
      format: z.toJSONSchema(EnrichmentSchema, { target: "draft-07" }) as Record<
        string,
        unknown
      >,
      // Each 1280px frame ≈ ~1,200 tokens of image budget — the 4k default
      // would silently truncate; 32k holds 10 frames + narration.
      options: { num_ctx: NUM_CTX_TOOLS, temperature: 0.2, max_tokens: 1500 },
      think: false,
    });
    const parsed = EnrichmentSchema.safeParse(JSON.parse(res.content));
    if (!parsed.success) throw new Error("enrichment shape mismatch");
    return parsed.data;
  };

  try {
    return await withTimeout(attempt(frames), 90_000);
  } catch {
    // Retry once, thinner.
    try {
      return await withTimeout(attempt(frames.slice(0, 5)), 90_000);
    } catch {
      throw new VisionUnavailable(
        "I couldn't watch the screen, so I compiled from your words alone."
      );
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    ),
  ]);
}

// The condensed evidence block handed to the drafting prompt.
export function enrichmentEvidence(e: Enrichment): string {
  const lines: string[] = [];
  for (const f of e.frames) {
    const bits = [f.app_or_site, f.visible_url, f.page_title]
      .filter((s) => s && s !== "unclear")
      .join(" · ");
    if (bits) lines.push(`- frame ${f.index}: ${bits}`);
  }
  if (e.entities.urls.length) lines.push(`URLs seen: ${e.entities.urls.join(", ")}`);
  if (e.entities.files.length) lines.push(`Files seen: ${e.entities.files.join(", ")}`);
  if (e.entities.typed_values.length)
    lines.push(`Values typed or shown: ${e.entities.typed_values.join(", ")}`);
  lines.push(`What it looked like overall: ${e.candidate_task_sentence} (confidence ${e.confidence})`);
  return lines.join("\n");
}
