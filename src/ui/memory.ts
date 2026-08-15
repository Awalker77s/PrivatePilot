// Conversational memory, all deterministic. The chat's memory is a persisted
// artifact registry plus a focus pointer — never transcript replay, never a
// model-written summary (a 9B summarizing its own thread compounds its own
// errors; template-rendering from typed cards can't hallucinate). The model
// also never resolves a pronoun: "this automation" is rewritten to the real
// name app-side before any call.
import type { AutomationRecord } from "../storage/types";
import type { ChatItem } from "./chatStore";

export interface EditTarget {
  record: AutomationRecord;
  builtItemId: number | null; // null = a saved record in the store
}

// A follow-up that tweaks something, not a request for something new.
export const DELTA_VERB_RE =
  /\b(schedule|reschedule|rename|change|adjust|update|set|make it|move|switch|pause|resume|turn (it |this )?(on|off)|remove|delete|run (it|this|that)|use)\b/i;
export const DEIXIS_RE =
  /\b(this|that|it|that one|the (first|second|last) one|them|both)\b/i;
export const TIMEY_RE =
  /\b(time|schedule|daily|hourly|every (day|morning|evening|night|hour|week)|at \d{1,2}(:\d{2})?\s*(am|pm)?|\d{1,2}\s*(am|pm))\b/i;
// Words that mean "something new", which must never be hijacked into an edit.
export const NEW_TASK_RE =
  /\b(another automation|a new automation|an automation (that|to|which)|a second automation|one more automation|make me (an|a new)|create (an|a new)|build (me )?(an|a))\b/i;

// "…and another automation to check meta" names two independent jobs — split
// before drafting so the model only ever sees one job per call.
const SPLIT_RE =
  /(?:,\s*)?\b(?:and then|and|plus|also|then)\s+(?:make\s+|create\s+|build\s+)?(?:another|a second|one more|a new)\s+(?:automation|one)\s*(?:to|that|which|for)?\s+/i;

export function splitCoordination(text: string): string[] {
  const parts = text
    .split(new RegExp(SPLIT_RE.source, "gi"))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 1 ? parts : [text];
}

// The edit-target search space: unsaved drafts on built cards first-class,
// searched alongside saved records. Newest mention of a name wins a tie.
export function draftRegistry(
  items: ChatItem[],
  saved: AutomationRecord[]
): EditTarget[] {
  const out: EditTarget[] = saved.map((record) => ({
    record,
    builtItemId: null,
  }));
  for (const it of items) {
    if (it.kind !== "built" || it.state === "discarded" || it.state === "saved")
      continue;
    for (const record of it.result.automations)
      out.push({ record, builtItemId: it.id });
  }
  return out;
}

export function dedupeByName(list: EditTarget[]): EditTarget[] {
  const m = new Map<string, EditTarget>();
  for (const x of list) m.set(x.record.name.toLowerCase(), x);
  return [...m.values()];
}

export function findTargetsByName(
  text: string,
  items: ChatItem[],
  saved: AutomationRecord[]
): EditTarget[] {
  const t = text.toLowerCase();
  const all = draftRegistry(items, saved);
  const aboutMatch = text.match(/^About "(.+?)":/);
  if (aboutMatch) {
    const named = all.filter(
      (x) => x.record.name.toLowerCase() === aboutMatch[1].toLowerCase()
    );
    if (named.length > 0) return dedupeByName(named);
  }
  return dedupeByName(all.filter((x) => t.includes(x.record.name.toLowerCase())));
}

export function findTargetNamed(
  name: string,
  items: ChatItem[],
  saved: AutomationRecord[]
): EditTarget | null {
  const n = name.trim().toLowerCase();
  const hits = dedupeByName(
    draftRegistry(items, saved).filter(
      (x) => x.record.name.toLowerCase() === n
    )
  );
  return hits[0] ?? null;
}

// What "this" points at: the newest edit card's target, else the newest
// non-discarded built card's automations. Saved cards resolve to the live
// store records so a patch lands on the current version.
export function focusTargets(
  items: ChatItem[],
  saved: AutomationRecord[]
): EditTarget[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "edit" && it.result.after) {
      if (it.builtItemId !== null)
        return [{ record: it.result.after, builtItemId: it.builtItemId }];
      const live = saved.find((r) => r.id === it.autoId);
      return [{ record: live ?? it.result.after, builtItemId: null }];
    }
    if (it.kind === "built" && it.state !== "discarded") {
      if (it.state === "saved") {
        return it.result.automations.map((a) => ({
          record: saved.find((r) => r.id === a.id) ?? a,
          builtItemId: null,
        }));
      }
      return it.result.automations.map((record) => ({
        record,
        builtItemId: it.id,
      }));
    }
  }
  return [];
}

// CQR-style rewrite: the pronoun becomes the real name before any model call.
export function rewriteDeixis(text: string, name: string): string {
  const phrase = `the automation "${name}"`;
  const out = text.replace(
    /\b(?:this|that|the)\s+(?:automation|one|chain)\b/i,
    phrase
  );
  if (out !== text) return out;
  return text.replace(/\b(?:this|that|it)\b/i, phrase);
}

// The digest that rides into DraftContext.history — template-rendered from
// typed cards, hard-capped, newest last (small models attend to the edges).
const DIGEST_MAX = 4500;
const SENTENCE_MAX = 120;
const TURN_MAX = 300;

export function renderHistory(
  items: ChatItem[],
  saved: AutomationRecord[]
): string | undefined {
  const autoLines: string[] = [];
  const seen = new Set<string>();
  for (let i = items.length - 1; i >= 0 && autoLines.length < 10; i--) {
    const it = items[i];
    if (it.kind !== "built" || it.state === "discarded") continue;
    for (const a of it.result.automations) {
      const key = a.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      autoLines.unshift(
        `- "${a.name}" — ${it.state === "saved" ? "saved" : "unsaved draft"} — ${a.sentence.slice(0, SENTENCE_MAX)}`
      );
    }
  }
  const userLines = items
    .filter((i) => i.kind === "user")
    .slice(-3)
    .map((i) => `- ${(i as ChatItem & { kind: "user" }).text.slice(0, TURN_MAX)}`);

  const focus = focusTargets(items, saved);
  const parts: string[] = [];
  if (autoLines.length > 0) {
    parts.push(
      "Automations already built this session (never re-create these):",
      ...autoLines
    );
  }
  if (focus.length > 0) {
    parts.push(
      `In focus: ${focus
        .map(
          (f) =>
            `"${f.record.name}" (${f.builtItemId === null ? "saved" : "unsaved draft"})`
        )
        .join(", ")}`
    );
  }
  if (userLines.length > 0) parts.push("Recent messages:", ...userLines);
  if (parts.length === 0) return undefined;
  let block = parts.join("\n");
  if (block.length > DIGEST_MAX) block = block.slice(-DIGEST_MAX);
  return block;
}
