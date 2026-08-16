// "What can this automation do?" — answered from the record, never guessed.
// The person opened an automation (Library → studio, or named it in chat) and
// asked a QUESTION rather than giving an instruction. The edit patcher is the
// wrong tool for that (it would try to patch a question into the record and
// fail). Here: render the record + its recent runs as grounded context and
// let the local model answer conversationally — so understanding, upgrading,
// and chaining an automation is all just talking.
import { chat, NUM_CTX_DRAFT } from "../providers";
import type { AutomationRecord, RunRecord } from "../storage/types";
import { getState } from "../storage/stores";
import { scheduleSentence } from "../ui/fmt";

export interface ExplainResult {
  ok: boolean;
  answer: string;
  failSentence: string | null;
}

// The record as a compact, readable spec — every fence spelled out, nothing
// invented. This is the ONLY thing the model may answer from.
export function renderSpec(a: AutomationRecord): string {
  const lines: string[] = [];
  lines.push(`Name: ${a.name}`);
  if (a.sentence) lines.push(`One-liner: ${a.sentence}`);
  lines.push(`Runs: ${scheduleSentence(a.schedule)}`);
  lines.push(`Steps, in order:`);
  a.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  lines.push(
    `Delivers: ${a.delivers === "files" ? "files (changes staged in a copy until Keep is pressed)" : "a written answer"}`
  );
  if (a.files?.reads?.length) lines.push(`Reads folders/files: ${a.files.reads.join(", ")}`);
  if (a.files?.writes?.length) lines.push(`Writes into (via sandbox + Keep): ${a.files.writes.join(", ")}`);
  if (a.sources?.length) lines.push(`Websites it may read: ${a.sources.join(", ")}`);
  if (a.apps?.length) lines.push(`Connected apps it uses: ${a.apps.join(", ")}`);
  if (a.tools?.length) lines.push(`Heavy tools it may run: ${a.tools.join(", ")}`);
  if (a.knowledge?.length) lines.push(`Knowledge bases (your indexed documents): ${a.knowledge.join(", ")}`);
  if (a.inputs?.length)
    lines.push(`Fill-ins asked each run: ${a.inputs.map((i) => i.name).join(", ")}`);
  if (a.outputs?.length)
    lines.push(`Named outputs it hands to chained automations: ${a.outputs.map((o) => o.name).join(", ")}`);
  lines.push(`Effort: ${a.effort === "thorough" ? "thorough (double-checks its work)" : "quick"}`);
  if (a.revision) lines.push(`Revision: #${a.revision.number}`);
  return lines.join("\n");
}

function renderRuns(runs: RunRecord[]): string {
  if (runs.length === 0) return "It hasn't run yet.";
  return runs
    .map((r) => {
      const when = new Date(r.finishedAt ?? r.startedAt).toLocaleString();
      const what = (r.answer ?? r.summary ?? "").replace(/\s+/g, " ").slice(0, 200);
      return `- ${when} · ${r.status} · ${r.cause}${what ? ` · ${what}` : ""}`;
    })
    .join("\n");
}

// What the person can DO by talking — so "what can I do with this?" gets a
// real, actionable answer instead of a spec dump.
const CAPABILITIES = [
  "Things the person can say to you about this automation (mention the relevant ones when asked):",
  "- Change anything by saying it: the schedule, the steps, the folders, the sources, the name.",
  "- Run it now (\"run it\").",
  "- Chain it: \"after this runs, run <another automation>\" — and branches are allowed: \"if the result mentions X, run A; otherwise run B\".",
  "- Add senses: connected apps (Gmail, Outlook, Spotify, open windows), heavy tools (OCR scans/PDFs, rename, zip), knowledge bases for answering questions from documents.",
  "Hard rules it always keeps: nothing sends itself (email stays a draft); file changes stage in a copy until Keep is pressed; it never invents values; everything runs locally.",
].join("\n");

const SYSTEM = [
  "You are Private Pilot, answering a question about ONE saved automation the person owns.",
  "Answer ONLY from the SPEC, RUN HISTORY, and CAPABILITIES below — never invent fields, sites, apps, or history.",
  "Be conversational and concrete. 2–6 sentences, or a short list when listing steps.",
  "If asked what it does or can do: walk through what actually happens when it runs, in plain words, then one sentence on how they could extend it.",
  "If asked about a past run, use the run history. If the history doesn't show it, say so.",
  "If the question isn't answerable from this automation, say what you'd need.",
].join("\n");

export async function explainAutomation(
  auto: AutomationRecord,
  question: string,
  model: string,
  history?: string,
  signal?: AbortSignal
): Promise<ExplainResult> {
  const runs = getState()
    .runs.records.filter((r) => r.automationId === auto.id)
    .slice(-4)
    .reverse();
  const user = [
    `SPEC of "${auto.name}":`,
    renderSpec(auto),
    "",
    "RUN HISTORY (newest first):",
    renderRuns(runs),
    "",
    CAPABILITIES,
    ...(history ? ["", "Recent conversation:", history.slice(-1500)] : []),
    "",
    `The person asks: ${question}`,
  ].join("\n");
  try {
    const res = await chat({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      options: { num_ctx: NUM_CTX_DRAFT, temperature: 0.3 },
      think: false,
      signal,
    });
    const answer = res.content.trim();
    if (!answer) {
      return { ok: false, answer: "", failSentence: "The model came back empty — ask again in other words." };
    }
    return { ok: true, answer, failSentence: null };
  } catch (e) {
    if (signal?.aborted) throw e;
    const sentence =
      e instanceof Error && "sentence" in e
        ? (e as { sentence: string }).sentence
        : "The local AI didn't answer.";
    return { ok: false, answer: "", failSentence: sentence };
  }
}
