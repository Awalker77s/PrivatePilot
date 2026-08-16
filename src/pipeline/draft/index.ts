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
import { connectorMenu } from "../../connectors/registry";
import { heavyMenu } from "../../heavy/registry";

export interface DraftContext {
  userText: string;
  answers: { asking: string; answer: string }[]; // question-card answers, newest last
  // A condensed transcript of the conversation so far — follow-ups like
  // "make one for meta too" only make sense with it.
  history?: string;
  // Set by the coordination splitter: this text is ONE job by construction —
  // the validator refuses a draft with more than one automation (the 4B
  // mimics history patterns and invents themed siblings otherwise).
  singleJob?: boolean;
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
    "Apps on this computer an automation can look into (typed tools — write the exact call in the step, e.g. \"outlook_mail_recent since_hours=24 unread_only=true\"):",
    connectorMenu(catalog.apps),
    "- An automation that uses an app MUST list that app's id in apps (the fence). Mail, calendar, and music NEVER travel through URLs — no outlook.com, graph, or spotify.com in sources when the app is listed.",
    "- 'my Outlook / my calendar / my meetings' → apps [\"outlook\"] with outlook_* steps. 'my Gmail / my Google mail' → apps [\"gmail\"] with gmail_* steps. Plain 'my email / my inbox' → whichever of outlook/gmail is marked ready above (outlook if both). 'what's playing / pause / skip / Spotify' → apps [\"spotify\"]. Any other desktop app the person names (Discord, Teams, Notepad, a game…) or 'what's on my screen / what does X show' → apps [\"computer\"] with a read_app step naming the app.",
    "- Drafting an email or reply when Outlook or Gmail is listed = an outlook_draft / gmail_draft STEP inside the SAME automation (read → decide → draft is one job; the person presses Send). Reply through the app the message came from — never mix outlook and gmail in one automation, and never use outlook_draft for Gmail mail. Only 'then email/text ME a summary' with no app listed is a separate message-drafting job. Listing limits are ≤25.",
    "- Watchers on Outlook are fine every 5+ minutes; watchers on read_app should stay daily.",
    "",
    "Heavy tools an automation can run on files in its folders (real work — the app builds the command, the model only fills the blanks):",
    heavyMenu(),
    "- An automation that does real file work MUST list the heavy tool in tools (the fence) AND name the folders in files. Heavy tools never touch the web, and a watcher may NEVER run one.",
    "- 'rename/convert/zip/unzip/read a scanned or photographed document (OCR)' = a heavy tool + files fence + delivers files. Everything runs in a copy; the person keeps the results.",
    "",
    catalog.knowledgeBases.length > 0
      ? `Knowledge bases (searchable document collections) the person has built: ${catalog.knowledgeBases.join(", ")}.`
      : "Knowledge bases: none yet — one is created the first time documents are filed into a named base.",
    "- 'clean/scan/file documents INTO a <name> knowledge base' = tools [\"ocr_pdf\"] + files fence + knowledge [\"<name>\"] + delivers files. The cleaned text is indexed when the person presses Keep.",
    "- 'ask my <name> …' / 'what does my <name> say about …' / any question ABOUT filed documents = knowledge [\"<name>\"], NO tools, delivers answer, a step 'rag_ask the question'. The question the person will ask each time is an input named 'question'.",
    "",
    "- One automation unless the person's words name two distinct jobs (shortest chain wins).",
    "- Two SEPARATE jobs with no hand-off ('and another automation that…', 'also make one that…', 'and then one to check…') = draft BOTH automations and leave chain null. Only set chain.links when one job's outputs actually feed the next — a link whose map is empty and whose onlyWhen is null is invalid. EXCEPTION: 'if the result…, otherwise…' / 'depending on what it finds…' is NEVER independent jobs — that is ONE chain with steps (see BRANCHING below).",
    ...(catalog.chainIntent
      ? [
          "- THIS request explicitly asks for ONE connected sequence ('as a chain', 'as a sequence', 'connect them', 'one after the other'): draft each job AND set chain.links joining them in the order stated — never leave chain null here. Map outputs to inputs by name where one job's result feeds the next; when nothing passes between two jobs, a link with an empty map is allowed for pure ordering.",
          "- Each item listed there is its own automation, never one that does both: 'a sequence of the meta price and the orlando weather' = 2 automations + 1 link; three items = 3 automations + 2 links.",
        ]
      : []),
    `- The request below is ALWAYS a NEW job — draft it from the request's own words. These automations ALREADY EXIST: ${existing}. Never output one of those as a name, never copy its steps; a request that merely resembles one is still a different job (changes to an existing automation never reach you).`,
    "- 'then email me…', 'then text me…', 'then message me a summary' is ALWAYS its own second automation (the message-drafting job), chained after the data job — set chain.links mapping the first job's outputs to the second job's inputs by name.",
    '- "when it drops below N" / "when it crosses above N" / "alert me if…" is ALWAYS two automations: the first watches (trigger watch) and outputs the value; the second acts; the link between them carries onlyWhen {"field": <that output name>, "op": "crosses_below" or "crosses_above", "value": N}. Never fold the condition into the sentence alone.',
    "- Otherwise, fetching data and reporting the values is ONE job. Split only where one job's finished outputs feed a different kind of job ('then …').",
    '- BRANCHING ("if the result says X do A, otherwise do B", "depending on what it finds…", "if it fails then…"): use chain.steps INSTEAD of links (links stays []). Each step: {"id": "s1", "automation": <drafted name>, "after": [step ids it waits for, [] for the first], "needs": "all" (or "any" when it should fire after WHICHEVER branch came through), "when": "ran" (or "held"/"broke"/"failed"/"always"), "if_answer_contains": <word the earlier answer must mention, else null>, "if_answer_lacks": <word it must NOT mention, else null>, "map": [...outputs→inputs like links]}. Opposite branches are two steps after the same step: one if_answer_contains "X", the sibling if_answer_lacks "X". A step after a branch that may not run joins with needs "any".',
    '- OUTCOME branches (not about the answer TEXT but whether the earlier step WORKED): "if it fails / if the source is down / if it can\'t / if that breaks" = when "failed"; "if it works / once it succeeds" = when "ran". Use "failed" (not "broke") for "if it fails" — a step that can\'t reach its data stops as held, which "failed" covers and "broke" does not.',
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
    "- Prefer API endpoints. A search engine or JavaScript-heavy page (a Bing answer box, google.com/finance, a dashboard) is allowed ONLY as a rendered read: put its hostname in sources and write the step as 'read_page the URL …'. Never use a search page when a known-good endpoint covers the goal.",
    "- Watchers (trigger watch) must use API or plain-text sources — rendered reading is too slow to poll; if only a rendered page has the value, keep the schedule daily and say so in the sentence.",
    "- Any concrete demonstrated value the person would likely vary next time (a month, a name, a search term, an amount) becomes an inputs[] entry whose example is the demonstrated value — and steps reference it as {input_name}.",
    "",
    `Folders in the catalog (only for jobs that name files): ${folders}`,
    aliases ? `\nRemembered answers:\n${aliases}` : "",
    "",
    'Example: "check the top tech news and another automation to check the meta stock price" is TWO independent automations that share nothing: {"automations": [{...the news job...}, {...the stock job...}], "chain": null, "question": null}.',
    'Example: "every morning tell me which unread emails need me first" = {"automations": [{"name": "Morning inbox triage", "category": "Email", "steps": ["outlook_mail_recent since_hours=24 unread_only=true limit=20", "outlook_mail_read the two or three that look urgent", "answer with the ones that need a reply first"], "sources": [], "apps": ["outlook"], "files": {"reads": [], "writes": []}, "delivers": "answer", "schedule": {"trigger": "daily", "hour": 8}, "outputs": [{"name": "how_many"}], "inputs": [], ...}], "chain": null, "question": null}',
    'Example: "summarize my unread gmail and save a draft reply to the most urgent one" = ONE automation: "apps": ["gmail"], "steps": ["gmail_recent since_hours=24 unread_only=true limit=25", "gmail_read the ones that look urgent", "gmail_draft reply_to=<the most urgent id> body=<a short, polite reply>", "answer with the summary and say the draft is saved"], "category": "Email", "delivers": "answer" — the draft is a step, never a second automation.',
    'Example: "what is spotify playing right now" = one automation, "apps": ["spotify"], steps ["spotify_now_playing", "answer with the track and artist"], "sources": [], delivers answer, schedule manual. "what does my Discord window show" = "apps": ["computer"], steps ["read_app Discord", "answer with a short summary"].',
    'Example: "each week read new receipts in Downloads, add the totals to my ledger, then text me a recap" is TWO jobs — reading receipts AND writing their totals into the ledger is one job; the recap is the second. So: {"automations": [{"name": "Receipt totals", "files": {"reads": ["~/Downloads"], "writes": ["~/Documents/ledger.xlsx"]}, "outputs": [{"name": "vendor"}, {"name": "amount"}, {"name": "how_many"}], "delivers": "files", ...}, {"name": "Weekly recap", "inputs": [{"name": "amount", "label": "Total amount", "example": "1240"}, {"name": "how_many", "label": "How many receipts", "example": "3"}], "outputs": [], "files": {"reads": [], "writes": []}, "delivers": "answer", ...}], "chain": {"name": "Receipts then recap", "links": [{"from": "Receipt totals", "to": "Weekly recap", "map": [{"output": "amount", "input": "amount"}, {"output": "how_many", "input": "how_many"}], "onlyWhen": null}], "steps": []}, "question": null}',
    'Example (branching): "check my unread email each morning; if anything is urgent draft a reply and also summarize my calendar, otherwise just give me the headlines" = THREE automations (Inbox check, Urgent reply + calendar, Headlines) and: "chain": {"name": "Morning triage", "links": [], "steps": [{"id": "s1", "automation": "Inbox check", "after": [], "needs": "all", "when": "ran", "if_answer_contains": null, "if_answer_lacks": null, "map": []}, {"id": "s2", "automation": "Urgent reply and calendar", "after": ["s1"], "needs": "all", "when": "ran", "if_answer_contains": "urgent", "if_answer_lacks": null, "map": []}, {"id": "s3", "automation": "Headlines", "after": ["s1"], "needs": "all", "when": "ran", "if_answer_contains": null, "if_answer_lacks": "urgent", "map": []}]} — opposite branches test the same word, one contains, one lacks.',
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
  if (context.history) {
    userContent = `Our conversation so far (for context — the request below is what to act on):\n${context.history}\n\nNow they ask:\n${userContent}`;
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
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<{ content: string; ms: number }> {
  const res = await chat({
    model,
    messages,
    format: wireJsonSchema(catalog),
    options: {
      num_ctx: NUM_CTX_DRAFT,
      temperature: 0,
      seed: 7,
      max_tokens: 2048,
    },
    think: false, // thinking models spend the whole response thinking otherwise
    signal,
  });
  return { content: res.content, ms: res.totalMs };
}

// Escape hatch ("reason free, constrain late"): one unconstrained call to
// plan in loose prose, then one strict-schema call to transcribe the plan.
// Measured to beat brute re-prompting on small models.
export async function planFreeThenTranscribe(
  model: string,
  catalog: Catalog,
  context: DraftContext,
  signal?: AbortSignal
): Promise<{ content: string; ms: number }> {
  const plan = await chat({
    model,
    messages: [
      {
        role: "system",
        content:
          "Plan an automation in plain words: which real files/folders it reads and writes, the steps, what it hands back, any schedule. Be concrete and short.",
      },
      {
        role: "user",
        content: context.history
          ? `Context — our conversation so far:\n${context.history}\n\nThe request:\n${context.userText}`
          : context.userText,
      },
      ...context.answers.map(
        (a) =>
          ({
            role: "user",
            content: `Answer to "${a.asking}": ${a.answer}`,
          }) as ChatMessage
      ),
    ],
    options: {
      num_ctx: NUM_CTX_DRAFT,
      temperature: 0,
      seed: 7,
      max_tokens: 1024,
    },
    think: false,
    signal,
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
    options: {
      num_ctx: NUM_CTX_DRAFT,
      temperature: 0,
      seed: 7,
      max_tokens: 2048,
    },
    think: false,
    signal,
  });
  return { content: transcribe.content, ms: plan.totalMs + transcribe.totalMs };
}
