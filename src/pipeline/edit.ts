// Edits are patches: "make it 7am" → the model returns a JSON Merge Patch
// (RFC 7396: null deletes a key; arrays are replaced whole, never
// element-edited) against the current record version. Unnamed fields
// untouchable. The card renders before→after with Keep / Put it back.
import { activeLocalModel, chat, NUM_CTX_DRAFT } from "../providers";
import type { AutomationRecord } from "../storage/types";
import { scheduleSentence } from "../ui/fmt";
import { buildCatalog } from "./catalog";
import { validateEditedAutomation } from "./draft/schema";

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
  "apps",
  "tools",
  "knowledge",
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
    case "apps":
      return (record.apps ?? []).join(" · ") || "(none)";
    case "tools":
      return (record.tools ?? []).join(" · ") || "(none)";
    case "knowledge":
      return (record.knowledge ?? []).join(" · ") || "(none)";
    default: {
      const v = (record as unknown as Record<string, unknown>)[key];
      return typeof v === "string" ? v : JSON.stringify(v);
    }
  }
}

// Common one-field edits do not need a model turn. Besides feeling instant,
// these deterministic patches cannot accidentally rewrite unrelated fields.
function deterministicEditPatch(
  auto: AutomationRecord,
  request: string
): Record<string, unknown> | null {
  const text = request.trim();

  const rename = text.match(
    /^\s*(?:rename|call)\s+(?:(?:it|this|the automation)\s+)?(?:to|as)\s+["']?(.+?)["']?[.!]?\s*$/i
  );
  if (rename?.[1]) return { name: rename[1].trim() };

  if (/\b(and|also|plus)\b/i.test(text)) return null;

  const watch = text.match(/\bevery\s+(\d{1,4})\s+minutes?\b/i);
  if (watch) {
    return {
      schedule: {
        trigger: "watch",
        everyMinutes: Math.max(5, Math.min(1440, Number(watch[1]))),
      },
    };
  }

  if (/\b(on demand|manually|manual)\b/i.test(text)) {
    return { schedule: { trigger: "manual" } };
  }

  const time = text.match(/\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/i);
  if (
    time &&
    !/\b(sentence|description|steps?|name|title)\b/i.test(text) &&
    /\b(schedule|reschedule|run|set|move|switch|make|change|adjust|update|at|daily|every day|morning)\b/i.test(text)
  ) {
    let hour = Number(time[1]);
    if (time[2].toLowerCase() === "pm" && hour < 12) hour += 12;
    if (time[2].toLowerCase() === "am" && hour === 12) hour = 0;
    return {
      schedule: { trigger: "daily", hour: Math.max(0, Math.min(23, hour)) },
    };
  }

  if (/\b(every day|daily|each morning|every morning)\b/i.test(text)) {
    return {
      schedule: {
        trigger: "daily",
        hour: auto.schedule.trigger === "daily" ? auto.schedule.hour : 8,
      },
    };
  }

  const effort = text.match(/\b(?:make|set|switch)(?:\s+it)?\s+(quick|thorough)\b/i);
  if (effort) return { effort: effort[1].toLowerCase() };
  return null;
}

async function finishEdit(
  auto: AutomationRecord,
  inputPatch: Record<string, unknown>,
  needsCatalog = true
): Promise<EditResult> {
  const patch = { ...inputPatch };
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

  try {
    if (!needsCatalog) {
      const changed = Object.keys(patch).map((key) => ({
        key,
        from: fieldLabel(key, auto),
        to: fieldLabel(key, after),
      }));
      return { ok: true, patch, before: auto, after, changed, failSentence: null };
    }
    const catalog = await buildCatalog();
    const verdict = validateEditedAutomation(after, catalog);
    if (!verdict.ok) {
      return {
        ok: false,
        patch: null,
        before: auto,
        after: null,
        changed: [],
        failSentence: `That edit doesn't hold together: ${verdict.issues[0]}${verdict.issues.length > 1 ? ` (and ${verdict.issues.length - 1} more)` : ""}`,
      };
    }
  } catch {
    // catalog unavailable — shape-only edits still apply
  }

  const changed = Object.keys(patch).map((key) => ({
    key,
    from: fieldLabel(key, auto),
    to: fieldLabel(key, after),
  }));
  return { ok: true, patch, before: auto, after, changed, failSentence: null };
}

export async function editAutomation(
  auto: AutomationRecord,
  request: string,
  model?: string
): Promise<EditResult> {
  const editable: Record<string, unknown> = {};
  for (const k of PATCHABLE) {
    editable[k] = (auto as unknown as Record<string, unknown>)[k];
  }

  const deterministic = deterministicEditPatch(auto, request);
  if (deterministic) return finishEdit(auto, deterministic, false);

  const selectedModel = model ?? (await activeLocalModel());
  if (!selectedModel) {
    return {
      ok: false,
      patch: null,
      before: auto,
      after: null,
      changed: [],
      failSentence: "The local AI isn't running — start Ollama, then try again.",
    };
  }

  const res = await chat({
    model: selectedModel,
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

  return finishEdit(auto, patch);
}

// A one-line what-changed summary between two versions — powers version
// history rows. Reuses the same field labels the edit card shows.
export function diffRecords(
  a: AutomationRecord,
  b: AutomationRecord
): { key: string; from: string; to: string }[] {
  const out: { key: string; from: string; to: string }[] = [];
  for (const key of PATCHABLE) {
    const fa = fieldLabel(key, a);
    const fb = fieldLabel(key, b);
    if (fa !== fb) out.push({ key, from: fa, to: fb });
  }
  return out;
}
