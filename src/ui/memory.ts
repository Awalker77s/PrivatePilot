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
// Anaphora aimed at the focus card. A BARE "that" is a relative pronoun far
// more often than a demonstrative ("a job THAT moves old downloads"), and a
// trailing "it" is usually a new object ("put it on my drive") — so a bare
// pronoun only counts when it is the change-verb's object.
export const DEIXIS_RE =
  /\b(?:this|that)\s+(?:automation|one|chain)\b|\b(?:the (?:first|second|last) one|them|both)\b|\b(?:schedule|reschedule|rename|change|adjust|update|set|move|switch|pause|resume|remove|delete|run|use|make|keep)\s+(?:it|this|that)\b/i;
export const TIMEY_RE =
  /\b(time|schedule|daily|hourly|every (day|morning|evening|night|hour|week)|at \d{1,2}(:\d{2})?\s*(am|pm)?|\d{1,2}\s*(am|pm))\b/i;
// A reference to an existing SCHEDULE FIELD (not a new object) — this is what
// lets a bare "change the time to 9am" edit the focus, while "set up a daily
// backup of my Documents folder" (a new deliverable, no field reference) does
// not hijack it. Without this gate, TIMEY alone turned any schedule-flavored
// NEW request into an edit of the last card.
export const SCHEDULE_FIELD_RE =
  /\b(the |its )?(time|schedule|hour|day|frequency|cadence)\b/i;
// Words that mean "something new", which must never be hijacked into an edit.
export const NEW_TASK_RE =
  /\b(another automation|a new automation|an automation (that|to|which|for|about)|a second automation|one more automation|make (me )?(an?|a new)|create (me )?(an?|a new)|build (me )?(an?)|set up (an?|a new)|a copy of|a version of|duplicate)\b/i;
// "Make a VARIANT of an existing automation" — meaningful only when a real
// automation name is also present (otherwise "a second batch of scans" is just
// an object). Used to send "create a second Morning Brief" to a fresh compile
// instead of editing the original.
export const COPY_INTENT_RE =
  /\b(a second|another|a separate|a copy of|a version of|duplicate|for the weekend|for weekends)\b/i;

// A question ABOUT an automation ("what can this do?", "when does it run?",
// "why did it fail?") — answered from the record, never sent to the patcher.
// "Can you change the time?" is still an edit: a delta verb wins over the
// question form, because the person wants the change, not an essay.
const QUESTION_FORM_RE =
  /^(what|what's|whats|how|why|when|where|which|who|tell me|explain|describe|walk me through|help me understand|show me what|summarize)\b|^(does|do|did|can|could|is|are|was|will|would|should)\s+(i|you|it|this|that|they|we)\b|\?\s*$/i;
export function isQuestionAbout(text: string): boolean {
  const t = text.trim();
  if (NEW_TASK_RE.test(t)) return false;
  if (DELTA_VERB_RE.test(t)) return false; // "can you set it to 9am?" = edit
  return QUESTION_FORM_RE.test(t);
}

// "…and another automation to check meta" names two independent jobs — split
// before drafting so the model only ever sees one job per call.
// A coordinator only when a genuine second JOB follows: "automation" (a
// connector after it is optional), or the pronoun "one" REQUIRING a connector
// ("another one THAT checks…"). Bare "a new one" — "merge the old log and a
// new one into an archive" — is an ordinary object, not a second job, so it
// must not split.
const SPLIT_RE =
  /(?:,\s*)?\b(?:and then|and|plus|also|then)\s+(?:make\s+|create\s+|build\s+)?(?:another|a second|one more|a new)\s+(?:automation(?:\s+(?:to|that|which|for))?|one\s+(?:to|that|which|for))\s+/i;

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
  // Whole-word match, not bare substring: an automation named "Log" must not
  // match inside "blog" or "logged", and "Morning Brief" matches "the morning
  // brief" but the word boundary keeps it from firing on unrelated prose.
  return dedupeByName(
    all.filter((x) => nameAppears(x.record.name, t))
  );
}

function nameAppears(name: string, lowerText: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // \b around the whole phrase; tolerate internal whitespace runs.
  const re = new RegExp(`\\b${escaped.replace(/\s+/g, "\\s+")}\\b`, "i");
  return re.test(lowerText);
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
  // NOT "that": anaphoric "that" is handled by the phrase branch above, while
  // relativizer "that" ("a digest that tracks papers") would be mangled.
  return text.replace(/\b(?:this|it)\b/i, phrase);
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
