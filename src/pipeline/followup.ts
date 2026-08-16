// "Can you also give short summaries?" after a built card is ABOUT that card
// — but no regex can know it. Before a hinted follow-up is allowed to compile
// as a brand-new automation (or worse, get grabbed by a keyword template),
// one tiny local call THINKS about what was prompted: does this message
// change the last automation, ask about it, or ask for something new?
// Fast (single word, temp 0) and only runs when the message carries
// follow-up signals — clear cases keep their regex fast-paths.
// ROUTING IS APP MACHINERY: this call always runs on the LOCAL model, even
// when Borrow-cloud is on — a per-request-billed cloud call to decide where a
// message goes would spend the person's money on plumbing (and cloud thinking
// models overrun the tiny token cap and return "", silently degrading the
// router). The user's chosen brain still does the real work afterwards.
import { ollama, NUM_CTX_DRAFT } from "../providers";

export type FollowUpIntent = "edit" | "question" | "new";

// Signals that a message MIGHT be about the last card: a polite-request
// opener, an additive opener, or a verb-led elliptical instruction with no
// subject of its own. (NEW_TASK_RE is checked by the caller first.)
export const FOLLOWUP_HINT_RE =
  /^(can|could|would|will) (you|it|we)\b|^(also|and|now|then|plus|please|actually|instead)\b|^(add|include|give|show|make|put|use|keep|have|sort|format|shorten|expand|summariz\w*)\b/i;

// Words that carry no subject — a shared "the" proves nothing.
const STOP = new Set(
  `the a an and or of to in on for with from into at by is are was be it its
   this that these those my me i you your we us they them their some any all
   every each get give show make add also please can could would will just
   want need new now today daily morning every day week time about over under
   more less than then there here what when where how why who which do does
   did have has had not no yes one two three top best`.split(/\s+/)
);

// Does the message actually TALK ABOUT this automation? A small model asked
// "edit or new?" leans EDIT (the prompt names an automation, so it primes
// one), and an unchallenged EDIT on a genuinely new request is exactly the
// "it brought up an already-made one" failure. A pronoun aimed at it, or one
// real content word in common with what it does, is the evidence required.
// An ELLIPTICAL follow-up is incomplete without the previous turn ("also
// include the race results", "add the humidity"), so it is about the focus by
// grammar alone — no subject overlap needed. A self-contained request ("make a
// daily rundown of AI papers") must prove it refers to the card.
export const ELLIPTICAL_RE =
  /^(also|and|plus|then)\b|^(can|could|would|will) (you|we) (also|add|include|throw|put)\b|^(add|include|append|attach|throw in|put in)\b/i;

export function refersToFocus(
  text: string,
  focus: { name: string; sentence: string; steps?: string[]; sources?: string[] }
): boolean {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4 && !STOP.has(w))
    );
  const theirs = words(
    [focus.name, focus.sentence, ...(focus.steps ?? []), ...(focus.sources ?? [])].join(" ")
  );
  for (const word of words(text)) if (theirs.has(word)) return true;
  return false;
}

export async function classifyFollowUp(
  text: string,
  focus: { name: string; sentence: string },
  model: string
): Promise<FollowUpIntent | null> {
  try {
    const res = await ollama.chat({
      model,
      messages: [
        {
          role: "system",
          content: [
            "You route ONE chat message. The person just built this automation:",
            `  "${focus.name}" — ${focus.sentence}`,
            "Decide what their new message is:",
            "  EDIT — it changes, extends, or adds to THAT automation (even politely: \"can you also…\", \"add…\", \"make it…\").",
            "  QUESTION — it asks about that automation or its result.",
            "  NEW — it clearly asks for a different, unrelated job with its own subject.",
            "Reply with exactly one word: EDIT or QUESTION or NEW.",
            "",
            "Examples:",
            '  message: "can you also give short summaries for the top stories" -> EDIT',
            '  message: "make it run every morning" -> EDIT',
            '  message: "why did it only find three?" -> QUESTION',
            '  message: "check the weather in Detroit each morning" -> NEW',
            '  message: "add the price change too" -> EDIT',
            '  message: "now make one that watches my downloads folder" -> NEW',
          ].join("\n"),
        },
        { role: "user", content: `message: ${JSON.stringify(text)} ->` },
      ],
      // A roomy cap, not a tight one: gemma's template emits NOTHING when
      // num_predict is single-digit small (verified: 4 and 16 both returned
      // "" at done:length; 200 answered instantly). The reply is one word
      // regardless — the cap is a safety net, not a steering wheel.
      options: { num_ctx: NUM_CTX_DRAFT, temperature: 0, max_tokens: 64, seed: 7 },
      think: false,
    });
    const word = res.content.trim().toUpperCase();
    if (word.startsWith("EDIT")) return "edit";
    if (word.startsWith("QUESTION")) return "question";
    if (word.startsWith("NEW")) return "new";
    return null; // junk — the caller falls back to the compile path
  } catch {
    return null;
  }
}
