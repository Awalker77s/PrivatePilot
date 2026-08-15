// Stage 1 · Schema-constrained drafting. The drafting call sends
// format: <JSON schema> (compiled to a llama.cpp grammar — syntax guaranteed)
// AND embeds the same schema in the prompt with temperature 0 — Ollama's own
// documented recommendation. Config: temp 0 · seed 7 · num_ctx 16384.
import { chat, NUM_CTX_DRAFT } from "../../providers";
import type { ChatMessage } from "../../providers/types";
import type { Catalog } from "../catalog";
import { wireJsonSchema } from "./schema";
import { getSettings } from "../../storage/settings";
import { COIN_ALIASES, endpointMenu } from "../endpoints";

export interface DraftContext {
  userText: string;
  answers: { asking: string; answer: string }[]; // question-card answers, newest last
  // Watch-me: the recording is an input adapter, not a second pipeline.
  demo?: {
    transcript: string;
    evidence: string | null; // condensed vision enrichment, or null (words alone)
    frames: number;
  };
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
    "- Most jobs are ONLINE: fetch a price, a number, a page, or a status from the web and deliver the answer right in the app. Prefer that shape.",
    "- files.reads and files.writes stay EMPTY unless the person explicitly names files or folders. Online jobs touch no files.",
    "- sources: the bare hostnames the job will fetch from — propose them yourself. Use the known-good endpoints below when they fit, and put the FULL URL to fetch inside the steps so the runner knows exactly where to go. Any public site the person names is also fine: its own hostname.",
    "",
    "Known-good endpoints (free, no key, live-verified):",
    endpointMenu(),
    `Coin shorthand: ${Object.entries(COIN_ALIASES)
      .map(([k, v]) => `${k}→${v}`)
      .join(", ")}`,
    "",
    "- One automation unless the person's words name two distinct jobs handing off to each other (shortest chain wins).",
    "- 'then email me…', 'then text me…', 'then message me a summary' is ALWAYS its own second automation (the message-drafting job), chained after the data job — set chain.links mapping the first job's outputs to the second job's inputs by name.",
    '- "when it drops below N" / "when it crosses above N" / "alert me if…" is ALWAYS two automations: the first watches (trigger watch) and outputs the value; the second acts; the link between them carries onlyWhen {"field": <that output name>, "op": "crosses_below" or "crosses_above", "value": N}. Never fold the condition into the sentence alone.',
    "- Otherwise, fetching data and reporting the values is ONE job. Split only where one job's finished outputs feed a different kind of job ('then …').",
    "- 'Email me X' or 'send me X' means the automation drafts the message and delivers it as answer — the person presses Send themselves. Nothing sends itself.",
    '- If the person names a file, folder, or thing you cannot find in the catalog below, set question and leave automations empty. Never guess a path. question.asking is a short question a person can answer ("Which tracking sheet?"); question.term is their exact words for the thing.',
    "- When the person names a particular document (my tracking sheet, the budget file), writes must point at that exact file from the catalog — a bare folder is not specific enough. If no catalog file clearly matches, ask.",
    "- steps: 1-6 short imperative phrases; include exact URLs for fetches.",
    "- sentence: one plain sentence describing the whole job.",
    "- name: 2-4 words.",
    "- outputs: the named values the job hands back (e.g. price, headline, amount). Chains pass these by name.",
    "- inputs: only blanks that must be asked at run time; usually empty.",
    "- delivers: answer = a number/summary shown in the app (the usual case); files = it writes or edits files.",
    "- schedule: what the person asked for; manual if they didn't say.",
    "- effort: thorough only if the person wants care over speed.",
    "- When the request comes from a recorded demonstration: the narration is the authority for WHAT the job is; the screen evidence only supplies exact URLs, filenames, and values. Never invent beyond either.",
    "- A demonstration shows WHAT the person wants, not HOW the automation should get it. A person uses a search engine or a pretty webpage; a program must use the data source directly. If the goal matches a known-good endpoint above (a stock price, crypto price, weather, news, rates…), the steps MUST use that endpoint's exact URL — even when the person demonstrated it via Bing, Google, or a finance webpage.",
    "- NEVER put a search engine in sources or steps (bing.com, google.com, duckduckgo.com, search.yahoo.com) — search results pages don't work for programs and the run will fail.",
    "- Any concrete demonstrated value the person would likely vary next time (a month, a name, a search term, an amount) becomes an inputs[] entry whose example is the demonstrated value — and steps reference it as {input_name}.",
    "",
    `Folders in the catalog (only for jobs that name files): ${folders}`,
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
  let userContent = context.userText;
  if (context.demo) {
    userContent = [
      "I recorded myself doing this task once while explaining it out loud.",
      "WHAT I SAID (this is the authority on what the job is):",
      context.demo.transcript,
      ...(context.demo.evidence
        ? [
            "",
            "WHAT WAS ON MY SCREEN (evidence for exact URLs, files, and values — never invent beyond it):",
            context.demo.evidence,
          ]
        : []),
      ...(context.userText.trim()
        ? ["", "MY NOTE:", context.userText.trim()]
        : []),
    ].join("\n");
  }
  const messages: ChatMessage[] = [
    { role: "system", content: draftSystemPrompt(catalog) },
    { role: "user", content: userContent },
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
