// Conversational memory, all deterministic. The chat's memory is a persisted
// artifact registry plus a focus pointer — never transcript replay, never a
// model-written summary (a 9B summarizing its own thread compounds its own
// errors; template-rendering from typed cards can't hallucinate). The model
// also never resolves a pronoun: "this automation" is rewritten to the real
// name app-side before any call.
import type { AutomationRecord, ChainRecord } from "../storage/types";
import type { ChatItem } from "./chatStore";

export interface EditTarget {
  record: AutomationRecord;
  builtItemId: number | null; // null = a saved record in the store
}

// A follow-up that tweaks something, not a request for something new.
export const DELTA_VERB_RE =
  /^\s*(?:About ".+?":\s*)?(?:(?:please|can you|could you|would you|i want you to)\s+)*(?:schedule|reschedule|rename|change|adjust|update|set|make|move|switch|pause|resume|turn|remove|delete|run|use)\b/i;
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
// "make a change / an adjustment / some tweaks" — a change REQUEST, not a new
// thing. NEW_TASK_RE's "make a…" branch would otherwise read it as a fresh
// job and bounce a studio edit into a junk compile.
export const CHANGE_NOUN_RE =
  /\bmake (?:me )?(?:a|an|some) (?:changes?|adjustments?|edits?|tweaks?|updates?|corrections?)\b/i;
// "add the weather to Morning Brief" — an ADD aimed AT a named automation is
// an edit of it, even though bare "add…" (no name) is usually a new build.
export const ADD_SHAPE_RE =
  /^(?:(?:please|can you|could you|would you)\s+)*(?:also\s+)?(?:add|include|append|attach)\b/i;

// Every word people use for "put these automations together" — chain,
// sequence, connect, link, combine, one after the other. Alone it's only a
// WORD ("supply chain news"); the chat tier requires two named automations
// or a plural pointer before it means anything.
// A chain WORD is not a chain REQUEST: "supply chain news" is a topic. Each
// alternative below is a shape people use to ASK for connection — an
// imperative connect verb, a chain noun in an asking position, or a phrase
// that only means sequencing.
export const CHAIN_TALK_RE = new RegExp(
  [
    // "connect A and B", "i want to connect these", "let's chain them"
    String.raw`^(?:\s*(?:please|can you|could you|would you|i want (?:you )?to|i'd like (?:you )?to|let'?s|now|also)\s+)*(?:connect|chain|link|combine|join|merge|string|hook)\b`,
    // "…as a chain", "…into one sequence"
    String.raw`\b(?:as|into) (?:a |one )?(?:chain|sequence|workflow)\b`,
    // "…make an automation for this a chain or a sequence" — the noun lands
    // at the end, which is how people actually tack the ask on.
    String.raw`\b(?:a|one) (?:chain|sequence|workflow)\b(?:\s+or\s+(?:a\s+)?(?:chain|sequence|workflow))?\s*[.!?]*\s*$`,
    // "chain them", "connect these", "link the two"
    String.raw`\b(?:chain|sequence|connect|link|combine|join|merge) (?:them|these|those|both|the two|together)\b`,
    // "make it a sequence", "turn these into a chain"
    String.raw`\b(?:make|turn|build|create) (?:it|this|them|these|those)?\s*(?:in)?to (?:a |one )?(?:chain|sequence|workflow)\b`,
    String.raw`\bmake (?:it|this|them|these) (?:a |one )?(?:chain|sequence)\b`,
    // "make a sequence from A and B", "build a workflow out of these" — the
    // thing being made IS the chain, whether what follows is names or a
    // pointer. (The tier still requires two real automations to act.)
    String.raw`\b(?:make|build|create|set up|put together)\s+(?:me\s+)?(?:a|one|an)\s+(?:chain|sequence|workflow)\b`,
    // "a chain of these", "a sequence out of Bitcoin Price and the note"
    String.raw`\b(?:a|one) (?:chain|sequence|workflow) (?:of|from|out of|with)\b`,
    // phrases that can only mean sequencing
    // "put them together" and "put Tesla Stock Check and Bitcoin Price
    // Fetch together" — but never "put together a summary of my invoices",
    // where `together` follows `put` directly and no "and" joins two things.
    String.raw`\bput (?:them|these|those|the two)\b[^.]{0,40}?\btogether\b`,
    String.raw`\bput\s+(?!together\b)[^.]{1,60}?\s+and\s+[^.]{1,60}?\s+together\b`,
    String.raw`\bstring (?:them|these|those) together\b`,
    String.raw`\bhook (?:them|these|those) (?:up|together)\b`,
    String.raw`\bone after (?:the other|another)\b`,
    String.raw`\bback to back\b`,
    String.raw`\bfeeds? (?:it |that |the result )?into\b`,
  ].join("|"),
  "i"
);
// "make a sequence from A and B", "build a chain out of these" — the thing
// being MADE is the sequence itself, so the new-automation guard must not
// swallow it. (NEW_TASK_RE fires on the bare "make a".)
export const MAKE_A_SEQUENCE_RE =
  /\b(?:make|build|create|set up|put together)\s+(?:me\s+)?(?:a|one|an)\s+(?:chain|sequence|workflow)\b/i;
// "them / these / both / together" — the message points at automations the
// thread already knows instead of naming them.
export const PLURAL_REF_RE = /\b(?:them|these|those|both|the two|together)\b/i;
// "…and call it Morning Combo" — a name for the sequence, said in passing.
export const SEQUENCE_NAME_RE =
  /\b(?:call|name) (?:it|this|the (?:chain|sequence|workflow))\s+["']?(.+?)["']?[.!]?\s*$/i;

// A sequence named in the message ("what does the Bitcoin Morning Briefing
// do?"). Longest name first so "Solana Watch and Alert Chain" wins over a
// shorter sequence whose name is a prefix of it.
export function findChainByName(
  text: string,
  chains: ChainRecord[]
): ChainRecord | null {
  const hits = chains.filter((c) => {
    const n = c.name.trim();
    if (!n) return false;
    const escaped = n
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text);
  });
  return hits.sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

// What a sequence IS, straight from the record — the members in run order,
// what each hand-off carries, and where it reaches. No model: a sequence
// question is answered by reading, not by generating.
export function describeChain(
  chain: ChainRecord,
  saved: AutomationRecord[]
): string {
  const nameOf = (id: string) =>
    saved.find((r) => r.id === id)?.name ?? id;
  const lines: string[] = [];
  if (chain.steps?.length) {
    const order = chain.steps.map((s) => nameOf(s.automationId));
    lines.push(
      `**${chain.name}** routes on results across ${order.length} automations: ${order.join(", ")}.`
    );
    for (const s of chain.steps) {
      if (s.after.length === 0) {
        lines.push(`- Starts with **${nameOf(s.automationId)}**.`);
        continue;
      }
      const afterNames = s.after
        .map((id) => chain.steps!.find((x) => x.id === id))
        .map((x) => (x ? nameOf(x.automationId) : "an earlier step"))
        .join(" and ");
      const when =
        s.when === "failed"
          ? "if that doesn't work"
          : s.when === "broke"
            ? "if that breaks"
            : s.when === "held"
              ? "if that is held back"
              : s.when === "always"
                ? "either way"
                : "once that runs";
      const test = s.ifAnswerContains
        ? `, and only when the result mentions “${s.ifAnswerContains}”`
        : s.ifAnswerLacks
          ? `, and only when the result does NOT mention “${s.ifAnswerLacks}”`
          : "";
      lines.push(
        `- Then **${nameOf(s.automationId)}** — after ${afterNames}, ${when}${test}.`
      );
    }
  } else {
    const order: string[] = [];
    for (const l of chain.links) {
      if (order.length === 0) order.push(l.from);
      order.push(l.to);
    }
    lines.push(
      `**${chain.name}** runs ${order.map(nameOf).join(" → ")}, one after the other.`
    );
    for (const l of chain.links) {
      const carried = Object.keys(l.map);
      lines.push(
        `- **${nameOf(l.from)}** hands **${nameOf(l.to)}** ${carried.length ? carried.join(", ") : "nothing — it just runs next"}${
          l.onlyWhen
            ? `, and only when ${l.onlyWhen.field} ${l.onlyWhen.op.replace(/_/g, " ")} ${l.onlyWhen.value ?? ""}`
            : ""
        }.`
      );
    }
  }
  const hosts = chain.permissions?.network.hosts ?? [];
  lines.push(
    hosts.length
      ? `It reaches ${hosts.join(", ")}. Run it from the Automations tab; it stops after ${chain.timeoutMinutes} minutes.`
      : `No external access. Run it from the Automations tab; it stops after ${chain.timeoutMinutes} minutes.`
  );
  return lines.join("\n");
}

// Where a name first appears in the text — orders "connect B and A" as
// B-then-A. Names absent from the text sort last, keeping their given order.
export function mentionIndex(text: string, name: string): number {
  const escaped = name
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const m = new RegExp(`\\b${escaped}\\b`, "i").exec(text);
  return m ? m.index : Number.MAX_SAFE_INTEGER;
}

// The automations the thread was just working with, oldest first — what
// "connect these" points at. The newest multi-automation card is already a
// group and wins outright; otherwise the two newest distinct records.
export function recentAutomationRecords(
  items: ChatItem[],
  saved: AutomationRecord[]
): AutomationRecord[] {
  const seen: AutomationRecord[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "built" && it.state !== "discarded") {
      const records = it.result.automations.map(
        (a) => saved.find((r) => r.id === a.id) ?? a
      );
      if (records.length >= 2 && seen.length === 0) return records;
      for (const r of records) {
        if (!seen.some((x) => x.id === r.id)) seen.push(r);
      }
    } else if (it.kind === "edit" && it.result.after) {
      const r = saved.find((x) => x.id === it.autoId) ?? it.result.after;
      if (!seen.some((x) => x.id === r.id)) seen.push(r);
    } else if (it.kind === "answer") {
      const r = saved.find((x) => x.name === it.autoName);
      if (r && !seen.some((x) => x.id === r.id)) seen.push(r);
    }
    if (seen.length >= 2) break;
  }
  return seen.slice(0, 2).reverse();
}

// "…to <Name>" / "…on <Name>": the name sits behind a preposition, so the
// sentence acts ON that automation rather than merely mentioning its topic.
export function nameAfterPreposition(text: string, name: string): boolean {
  const escaped = name
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`\\b(?:to|into|onto|on|in)\\s+(?:the\\s+)?${escaped}\\b`, "i").test(
    text
  );
}

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
      if (it.builtItemId !== null) {
        // The edit card's host draft may have moved on: once SAVED, the
        // record lives in the store — patching the card's frozen copy would
        // change chat memory while the Library (and the scheduler) keep the
        // old version. A discarded host is no focus at all.
        const host = items.find(
          (x) => x.kind === "built" && x.id === it.builtItemId
        ) as (ChatItem & { kind: "built" }) | undefined;
        if (host?.state === "saved") {
          const live = saved.find((r) => r.id === it.autoId);
          return [{ record: live ?? it.result.after, builtItemId: null }];
        }
        if (host?.state === "discarded") continue;
        return [{ record: it.result.after, builtItemId: it.builtItemId }];
      }
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

// "check my gmail, if someone emailed me, summarize the email" — one sentence
// that is really two jobs and a condition between them. A 4B will not take
// this apart (rules, examples and larger local models were all tried), but it
// does not have to: the seam is in the words. Split here, hand the model ONE
// job at a time — which it does reliably — and let the app draw the link.
//   check   → the automation that runs first
//   then    → the automation that runs when the check finds something
//   contains→ the word the check's answer is tested for
export function splitConditional(
  text: string
): { check: string; then: string; contains: string } | null {
  const m = text.match(
    /^(.*?)[,;]?\s*\bif\b\s+([^,]{3,90}?)\s*,\s*([^,.;]{3,140})/i
  );
  if (!m) return null;
  const check = m[1]
    .replace(
      /^\s*(?:please\s+)?(?:make|build|create|set up)\s+(?:me\s+)?(?:a|an|one)\s+(?:chain|sequence|workflow|automation)\s+(?:to|that|which)?\s*/i,
      ""
    )
    .trim();
  const cond = m[2].trim();
  const then = m[3].trim();
  if (check.length < 3 || then.length < 3) return null;
  // The tested word: prefer something the action and the condition share, so
  // the predicate is about the thing the check actually reports on.
  const STOP = new Set([
    "the", "and", "for", "with", "that", "this", "them", "it", "me", "my",
    "has", "have", "sent", "get", "got", "was", "were", "any", "some",
    "someone", "somebody", "there", "been", "into", "from", "past", "last",
    "new", "summarize", "summarise", "tell", "give", "send", "check", "make",
  ]);
  const words = (s: string) =>
    s.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? [];
  const actionWords = words(then).filter((w) => !STOP.has(w));
  const condWords = new Set(words(cond));
  const checkWords = new Set(words(check));
  const shared = actionWords.find(
    (w) => condWords.has(w) || checkWords.has(w)
  );
  const contains = (shared ?? actionWords[actionWords.length - 1] ?? "").replace(
    /s$/,
    ""
  );
  if (!contains) return null;
  return { check, then, contains };
}
