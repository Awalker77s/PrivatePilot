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

  // Renames arrive with the automation's real name in the sentence at least
  // as often as with "it" — "rename Tesla Stock Check to Tesla Daily Watch"
  // must not fall through to the model (measured: the model turned exactly
  // that into a schedule patch).
  const rename =
    text.match(
      /^\s*(?:rename|call)\s+(?:.+?\s+)?(?:to|as)\s+["']?(.+?)["']?[.!]?\s*$/i
    ) ??
    text.match(
      /^\s*(?:change|set|update)\s+(?:the\s+|its\s+)?(?:name|title)(?:\s+of\s+.+?)?\s+to\s+["']?(.+?)["']?[.!]?\s*$/i
    ) ??
    text.match(/^\s*name\s+(?:it|this|that)\s+["']?(.+?)["']?[.!]?\s*$/i);
  if (rename?.[1]) return { name: rename[1].trim() };

  if (/\b(and|also|plus)\b/i.test(text)) return null;

  const watch = text.match(/\bevery\s+(\d{1,4})\s+minutes?\b/i);
  if (watch) {
    return {
      schedule: {
        trigger: "watch",
        everyMinutes: Math.max(1, Math.min(1440, Number(watch[1]))),
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

  // A bare hour — "every day at 10", "run it at 18:30". People drop the
  // am/pm constantly, and the old code fell through to the every-day branch
  // below and quietly used 8: you asked for 10 and got 8. Read it on a
  // 24-hour clock and show it on the card, where a wrong read is visible
  // before anything changes.
  const bareHour = text.match(/\b(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\b(?!\s*(?:am|pm))/i);
  if (
    bareHour &&
    // "at 8 in the evening" carries more than an hour — let the part-of-day
    // rule below read it, so evening/night can shift into the PM.
    !/\b(morning|afternoon|evening|night)\b/i.test(text) &&
    !/\b(sentence|description|steps?|name|title|minutes?|seconds?)\b/i.test(text) &&
    /\b(schedule|reschedule|run|runs|set|move|switch|make|change|adjust|update|daily|every day|each day|morning|evening|night)\b/i.test(
      text
    )
  ) {
    const hour = Number(bareHour[1]);
    if (Number.isFinite(hour) && hour >= 0 && hour <= 23) {
      return { schedule: { trigger: "daily", hour } };
    }
  }

  // "7 every morning", "8 in the evening" — the hour rides next to the part
  // of day instead of after "at". Evening/night shift a 1-11 into the PM.
  const partOfDay = text.match(
    /\b(\d{1,2})(?::\d{2})?\s*(?:o'?clock\s*)?(?:at\s+|in the\s+|every\s+|each\s+)?(morning|afternoon|evening|night)\b/i
  );
  if (partOfDay && !/\b(sentence|description|steps?|name|title)\b/i.test(text)) {
    let hour = Number(partOfDay[1]);
    const part = partOfDay[2].toLowerCase();
    if (part !== "morning" && hour < 12) hour += 12;
    if (Number.isFinite(hour) && hour >= 0 && hour <= 23) {
      return { schedule: { trigger: "daily", hour } };
    }
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

// Keys an automation cannot live without: a null-delete of one of these is a
// model mistake, refused with a sentence rather than crashed on downstream.
const REQUIRED_KEYS = new Set([
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

// Order-stable serialization for "did this key actually change" — plain
// JSON.stringify would call merged objects different on key order alone.
function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableValue(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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
  for (const k of Object.keys(patch)) {
    if (patch[k] === null && REQUIRED_KEYS.has(k)) {
      const sentence = `An automation always has a ${k} — say what it should BE instead of removing it.`;
      return {
        ok: false,
        patch: null,
        before: auto,
        after: null,
        changed: [],
        failSentence: sentence,
      };
    }
  }

  const after = applyMergePatch(
    auto as unknown as Record<string, unknown>,
    patch
  ) as unknown as AutomationRecord;

  // schedule is a discriminated union on trigger — merge-patching a shape
  // change leaves the old shape's keys behind ({trigger:"daily",
  // everyMinutes:30, hour:8}). A patch that changes trigger states a whole
  // new schedule: take it atomically. A tweak within the same shape
  // ({schedule:{hour:9}}) still merges.
  const schedPatch = patch.schedule;
  if (
    schedPatch &&
    typeof schedPatch === "object" &&
    !Array.isArray(schedPatch) &&
    "trigger" in schedPatch
  ) {
    (after as unknown as Record<string, unknown>).schedule = schedPatch;
  }

  // The card must show what actually CHANGED, not what the patch mentioned —
  // models echo unchanged fields ("steps": [...same...]), and a no-op row
  // both confuses the person and falsely demotes a tested draft card.
  const realKeys = Object.keys(patch).filter(
    (key) =>
      stableValue((auto as unknown as Record<string, unknown>)[key]) !==
      stableValue((after as unknown as Record<string, unknown>)[key])
  );
  if (realKeys.length === 0) {
    return {
      ok: false,
      patch: null,
      before: auto,
      after: null,
      changed: [],
      failSentence: "That matches what it already does — nothing to change.",
    };
  }

  try {
    if (!needsCatalog) {
      const changed = realKeys.map((key) => ({
        key,
        from: fieldLabel(key, auto),
        to: fieldLabel(key, after),
      }));
      return { ok: true, patch, before: auto, after, changed, failSentence: null };
    }
    const catalog = await buildCatalog();
    // Judge the edit on what IT changed — a flaw the record already had
    // (a {token} with no fill-in) must not block every future edit of it.
    const verdict = validateEditedAutomation(after, catalog, {
      name: auto.name,
      steps: auto.steps,
      inputs: auto.inputs,
      sources: auto.sources,
    });
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

  const changed = realKeys.map((key) => ({
    key,
    from: fieldLabel(key, auto),
    to: fieldLabel(key, after),
  }));
  return { ok: true, patch, before: auto, after, changed, failSentence: null };
}

export async function editAutomation(
  auto: AutomationRecord,
  request: string,
  model?: string,
  signal?: AbortSignal
): Promise<EditResult> {
  const editable: Record<string, unknown> = {};
  for (const k of PATCHABLE) {
    editable[k] = (auto as unknown as Record<string, unknown>)[k];
  }

  const deterministic = deterministicEditPatch(auto, request);
  // A deterministic rename still needs the catalog pass — "rename it to
  // Solana Watcher" when a Solana Watcher already exists must be refused,
  // not saved as a duplicate name.
  if (deterministic) return finishEdit(auto, deterministic, "name" in deterministic);

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
    signal,
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
