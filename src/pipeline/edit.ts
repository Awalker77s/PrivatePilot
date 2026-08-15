// Edits are patches: "make it 7am" → the model returns a JSON Merge Patch
// (RFC 7396: null deletes a key; arrays are replaced whole, never
// element-edited) against the current record version. Unnamed fields
// untouchable. The card renders before→after with Keep / Put it back.
import { chat, NUM_CTX_DRAFT } from "../providers";
import type { AutomationRecord } from "../storage/types";
import { scheduleSentence } from "../ui/fmt";

// Only these keys may be patched — the model can't rename ids or forge runs.
const PATCHABLE = new Set([
  "name",
  "sentence",
  "category",
  "steps",
  "inputs",
  "outputs",
  "files",
  "formats",
  "sources",
  "delivers",
  "schedule",
  "effort",
]);

export interface EditResult {
  ok: boolean;
  patch: Record<string, unknown> | null;
  before: AutomationRecord;
  after: AutomationRecord | null;
  changed: { key: string; from: string; to: string }[];
  failSentence: string | null;
}

export function applyMergePatch<T>(target: T, patch: unknown): T {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return patch as T;
  }
  const out: Record<string, unknown> = {
    ...(typeof target === "object" && target !== null && !Array.isArray(target)
      ? (target as Record<string, unknown>)
      : {}),
  };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete out[k];
    else out[k] = applyMergePatch(out[k], v);
  }
  return out as T;
}

function fieldLabel(key: string, record: AutomationRecord): string {
  switch (key) {
    case "schedule":
      return scheduleSentence(record.schedule);
    case "steps":
      return record.steps.join(" → ");
    case "files":
      return [...record.files.reads, ...record.files.writes]
        .map((p) => p.split("/").pop())
        .join(" · ");
    case "inputs":
      return record.inputs.map((i) => i.name).join(" · ") || "(none)";
    case "outputs":
      return record.outputs.map((o) => o.name).join(" · ") || "(none)";
    case "sources":
      return record.sources.join(" · ") || "(none)";
    default: {
      const v = (record as unknown as Record<string, unknown>)[key];
      return typeof v === "string" ? v : JSON.stringify(v);
    }
  }
}

export async function editAutomation(
  auto: AutomationRecord,
  request: string,
  model: string
): Promise<EditResult> {
  const editable: Record<string, unknown> = {};
  for (const k of PATCHABLE) {
    editable[k] = (auto as unknown as Record<string, unknown>)[k];
  }

  const res = await chat({
    model,
    messages: [
      {
        role: "system",
        content: [
          "You edit one automation record in Private Pilot.",
          "Respond ONLY with a JSON Merge Patch (RFC 7396) against the record below: include ONLY the fields that change. null deletes a key. Arrays are replaced whole — return the complete new array.",
          "schedule shapes: {\"trigger\":\"daily\",\"hour\":8} or {\"trigger\":\"watch\",\"everyMinutes\":15} or {\"trigger\":\"manual\"}.",
          "Change nothing the person didn't ask for.",
          "",
          "The current record:",
          JSON.stringify(editable, null, 1),
        ].join("\n"),
      },
      { role: "user", content: request },
    ],
    format: { type: "object" },
    options: { num_ctx: NUM_CTX_DRAFT, temperature: 0, seed: 7 },
    think: false,
  });

  let patch: Record<string, unknown>;
  try {
    patch = JSON.parse(res.content) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      patch: null,
      before: auto,
      after: null,
      changed: [],
      failSentence: "The edit didn't come back readable — say it another way?",
    };
  }

  // Unnamed fields untouchable.
  for (const k of Object.keys(patch)) {
    if (!PATCHABLE.has(k)) delete patch[k];
  }
  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      patch: null,
      before: auto,
      after: null,
      changed: [],
      failSentence:
        "That didn't change anything I'm allowed to touch — name, schedule, steps, files, sources, or effort.",
    };
  }

  const after = applyMergePatch(
    auto as unknown as Record<string, unknown>,
    patch
  ) as unknown as AutomationRecord;

  const changed = Object.keys(patch).map((key) => ({
    key,
    from: fieldLabel(key, auto),
    to: fieldLabel(key, after),
  }));

  return { ok: true, patch, before: auto, after, changed, failSentence: null };
}
