// The vision rung of read_page: the local model transcribes what the
// rendered page shows — verbatim, labels + values, "unclear" over guessing.
// A 9B model can misread digits, so every read runs TWICE at two different
// scales and numbers must agree exactly; a coin flip is never delivered.
import { z } from "zod";
import { ollama } from "../providers";
import { NUM_CTX_TOOLS, activeLocalModel } from "../providers";

const ReadSchema = z.object({
  values: z.array(
    z.strictObject({
      label: z.string(),
      value: z.string(),
    })
  ),
  page_summary: z.string(),
});

export type VisionReadResult =
  | { ok: true; transcription: string }
  | { ok: false; sentence: string; family: "broke" | "on_purpose" };

async function rescale(pngB64: string, width: number): Promise<string> {
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("bad png"));
    img.src = `data:image/png;base64,${pngB64}`;
  });
  const scale = Math.min(1, width / img.width);
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85).split(",")[1];
}

async function readOnce(model: string, imageB64: string): Promise<z.infer<typeof ReadSchema> | null> {
  try {
    const res = await ollama.chat({
      model,
      messages: [
        {
          role: "user",
          content:
            "This is a snapshot of a rendered web page. Transcribe ONLY what is visible: every labeled value, number, price, or status you can read, verbatim (label + exact value). If a value is unclear, write \"unclear\" — never guess a digit. Then one sentence on what the page shows.",
          images: [imageB64],
        },
      ],
      format: z.toJSONSchema(ReadSchema, { target: "draft-07" }) as Record<
        string,
        unknown
      >,
      options: { num_ctx: NUM_CTX_TOOLS, temperature: 0, max_tokens: 900 },
      think: false,
    });
    const parsed = ReadSchema.safeParse(JSON.parse(res.content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function numbersOf(read: z.infer<typeof ReadSchema>): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of read.values) {
    const m = v.value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (m) out.set(v.label.toLowerCase().trim(), m[0]);
  }
  return out;
}

export async function visionReadPage(
  pngB64: string,
  host: string
): Promise<VisionReadResult> {
  const model = await activeLocalModel();
  if (!model) {
    return {
      ok: false,
      family: "broke",
      sentence: "No local model to read the page with.",
    };
  }

  // Two reads, two scales — vary the INPUT, not just the seed: a temp-0
  // rerun of the same pixels repeats the same misread.
  const [a, b] = await Promise.all([
    rescale(pngB64, 1280).then((img) => readOnce(model, img)),
    rescale(pngB64, 960).then((img) => readOnce(model, img)),
  ]);
  if (!a || !b) {
    return {
      ok: false,
      family: "broke",
      sentence: `The vision model couldn't read ${host}'s page.`,
    };
  }

  const numsA = numbersOf(a);
  const numsB = numbersOf(b);
  const agreed: string[] = [];
  let disagreement: string | null = null;
  for (const [label, valA] of numsA) {
    const valB = numsB.get(label);
    if (valB === undefined) continue;
    if (valA === valB) {
      agreed.push(`${label}: ${valA}`);
    } else if (!disagreement) {
      disagreement = `The two picture reads differ on ${label} (${valA} vs ${valB}). I don't deliver a coin flip.`;
    }
  }

  if (agreed.length === 0) {
    return {
      ok: false,
      family: "broke",
      sentence:
        disagreement ??
        `I read ${host}'s page twice and couldn't pin down any value — the answer isn't legible to me.`,
    };
  }

  const lines = [
    `Values read from the rendered page (two independent reads agreed):`,
    ...agreed.map((l) => `- ${l}`),
    ...(disagreement ? [`(Dropped one value: ${disagreement})`] : []),
    `Page: ${a.page_summary}`,
  ];
  return { ok: true, transcription: lines.join("\n") };
}
