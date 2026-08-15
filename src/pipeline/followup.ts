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
