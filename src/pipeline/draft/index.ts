// Stage 1 · Schema-constrained drafting. The drafting call sends
// format: <JSON schema> (compiled to a llama.cpp grammar — syntax guaranteed)
// AND embeds the same schema in the prompt with temperature 0 — Ollama's own
// documented recommendation. Config: temp 0 · seed 7 · num_ctx 16384.
import { chat, NUM_CTX_DRAFT } from "../../providers";
import type { ChatMessage } from "../../providers/types";
import type { Catalog } from "../catalog";
import { wireJsonSchema } from "./schema";
import { getSettings } from "../../storage/settings";

export interface DraftContext {
  userText: string;
  answers: { asking: string; answer: string }[]; // question-card answers, newest last
}

export function draftSystemPrompt(catalog: Catalog): string {
  const schema = JSON.stringify(wireJsonSchema(catalog));
  const folders = catalog.folders
    .filter((f) => f.readable)
    .map((f) => f.display)
    .join(", ");
  const aliases = Object.entries(getSettings().aliases)
    .map(([k, v]) => `"${k}" means ${v}`)
    .join("\n");
  const existing = catalog.automationNames.join(", ") || "(none yet)";

  return [
    "You compile a person's plain-English request into automation records for Private Pilot, a local automation runner.",
    "Respond ONLY with JSON matching this schema:",
    schema,
    "",
    "Rules:",
    "- One automation unless the person's words name two distinct jobs handing off to each other (shortest chain wins).",
    "- A phrase like 'then email me a summary' or 'then tell me about it' IS a second job: draft one automation per job, and set chain.links mapping the first job's outputs to the second job's inputs by name.",
    "- Reading data and writing the result into a document is ONE job, not two. Split only where one job's finished outputs feed a different kind of job ('then …').",
    "- 'Email me X' or 'send me X' means the automation drafts the message and delivers it as answer — the person presses Send themselves. Nothing sends itself.",
    "- files.reads and files.writes may ONLY use paths from the catalog below. Reading a folder means new/matching files in it.",
    '- If the person names a file, folder, or thing you cannot find in the catalog, set question and leave automations empty. Never guess a path. question.asking is a short question a person can answer ("Which tracking sheet?"); question.term is their exact words for the thing.',
    "- When the person names a particular document (my tracking sheet, the budget file), writes must point at that exact file from the catalog — a bare folder is not specific enough. If no catalog file clearly matches, ask.",
    "- steps: 1-6 short imperative phrases a person could follow.",
    "- sentence: one plain sentence describing the whole job, mentioning the real file names.",
    "- name: 2-4 words.",
    "- outputs: the named values the job hands back (e.g. vendor, amount, how_many). Chains pass these by name.",
    "- inputs: only blanks that must be asked at run time; usually empty.",
    "- sources: bare hostnames of websites the person named (e.g. api.coingecko.com); empty if none.",
    "- delivers: answer = a number/summary shown in the app; files = it writes or edits files.",
    "- schedule: what the person asked for; manual if they didn't say.",
    "- effort: thorough only if the person wants care over speed.",
    "",
    `Folders in the catalog: ${folders}`,
    "The schema's enums list every real file path you may use — nothing else exists.",
    aliases ? `\nRemembered answers:\n${aliases}` : "",
    `\nExisting automations: ${existing}`,
    "",
    'Example: "each week read new receipts in Downloads, add the totals to my ledger, then text me a recap" is TWO jobs — reading receipts AND writing their totals into the ledger is one job; the recap is the second. So: {"automations": [{"name": "Receipt totals", "files": {"reads": ["~/Downloads"], "writes": ["~/Documents/ledger.xlsx"]}, "outputs": [{"name": "vendor"}, {"name": "amount"}, {"name": "how_many"}], "delivers": "files", ...}, {"name": "Weekly recap", "inputs": [{"name": "amount", "label": "Total amount", "example": "1240"}, {"name": "how_many", "label": "How many receipts", "example": "3"}], "outputs": [], "files": {"reads": [], "writes": []}, "delivers": "answer", ...}], "chain": {"name": "Receipts then recap", "links": [{"from": "Receipt totals", "to": "Weekly recap", "map": [{"output": "amount", "input": "amount"}, {"output": "how_many", "input": "how_many"}], "onlyWhen": null}]}, "question": null}',
  ].join("\n");
}

export function draftMessages(
  catalog: Catalog,
  context: DraftContext
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: draftSystemPrompt(catalog) },
    { role: "user", content: context.userText },
  ];
  for (const a of context.answers) {
    messages.push({
      role: "user",
      content: `To your question "${a.asking}" my answer is: ${a.answer}. Now draft the automation using it.`,
    });
  }
  return messages;
}

export async function draftCall(
  model: string,
  catalog: Catalog,
  messages: ChatMessage[]
): Promise<{ content: string; ms: number }> {
  const res = await chat({
    model,
    messages,
    format: wireJsonSchema(catalog),
    options: { num_ctx: NUM_CTX_DRAFT, temperature: 0, seed: 7 },
    think: false, // thinking models spend the whole response thinking otherwise
  });
  return { content: res.content, ms: res.totalMs };
}

// Escape hatch ("reason free, constrain late"): one unconstrained call to
// plan in loose prose, then one strict-schema call to transcribe the plan.
// Measured to beat brute re-prompting on small models.
export async function planFreeThenTranscribe(
  model: string,
  catalog: Catalog,
  context: DraftContext
): Promise<{ content: string; ms: number }> {
  const plan = await chat({
    model,
    messages: [
      {
        role: "system",
        content:
          "Plan an automation in plain words: which real files/folders it reads and writes, the steps, what it hands back, any schedule. Be concrete and short.",
      },
      { role: "user", content: context.userText },
      ...context.answers.map(
        (a) =>
          ({
            role: "user",
            content: `Answer to "${a.asking}": ${a.answer}`,
          }) as ChatMessage
      ),
    ],
    options: { num_ctx: NUM_CTX_DRAFT, temperature: 0, seed: 7 },
    think: false,
  });
  const transcribe = await chat({
    model,
    messages: [
      { role: "system", content: draftSystemPrompt(catalog) },
      { role: "user", content: context.userText },
      {
        role: "user",
        content: `Transcribe this plan into the schema exactly:\n${plan.content}`,
      },
    ],
    format: wireJsonSchema(catalog),
    options: { num_ctx: NUM_CTX_DRAFT, temperature: 0, seed: 7 },
    think: false,
  });
  return { content: transcribe.content, ms: plan.totalMs + transcribe.totalMs };
}
