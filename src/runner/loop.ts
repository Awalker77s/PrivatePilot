// Stage 3 · The agentic tool loop. Four tools as JSON, one call per turn,
// cap 15 turns, 30-minute stall timeout, stream off. Sampling: temp 0.6 /
// top_p 0.95 / top_k 20. Small models sometimes emit the call as JSON text
// in content — recovered and logged, never dropped.
import { chat, NUM_CTX_DRAFT, NUM_CTX_TOOLS } from "../providers";
import type { ChatMessage, ToolCall, ToolDef } from "../providers/types";
import type { AutomationRecord } from "../storage/types";
import { readAnyFile } from "./readFile";
import { fetchPage } from "./fetchPage";
import { Sandbox, toSandboxPath } from "./sandbox";
import { readDir, writeTextFile, exists, mkdir } from "@tauri-apps/plugin-fs";
import { toolsFor } from "../connectors/registry";
import type { ToolContext, ToolSpec } from "../connectors/types";
import type { RunHandoff } from "../storage/types";
import { heavyToolsFor, heavyAllowed } from "../heavy/registry";
import { findBinary } from "../heavy/runTool";
import type { HeavyContext, HeavyToolSpec } from "../heavy/types";

const MAX_TURNS = 15;
// App connectors take one turn per read, and a mailbox has many — give
// those runs more room before the loop gives up.
const MAX_TURNS_APPS = 22;
const STALL_MS = 30 * 60 * 1000;
const CTX_GUARD = 0.85;

export interface LoopEvent {
  text: string; // "Tool loop — turn 6 · read 2 files"
}

export interface LoopOutcome {
  answer: string;
  turns: number;
  corpus: string; // everything read/fetched — grounded verification checks against this
  contextTrimmed: boolean;
  recoveredCalls: number;
  refusals: string[]; // designed refusal sentences (fence etc.)
  logLines: string[];
  stalled: boolean;
  // A connector said "needs you" or broke: the run stops here, held back —
  // the model never gets to answer from partial data.
  heldBack: string | null;
  handoffs: RunHandoff[];
  appsRead: number; // connector reads that returned data
  heavyRan: boolean; // a heavy tool did real work (staged into the sandbox)
}

const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List the files in one of the automation's folders.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Folder path like ~/Downloads" },
        },
        required: ["folder"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read one file (pdf, xlsx, csv, txt...). Returns its text content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path like ~/Downloads/invoice.pdf" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write a file. For a spreadsheet (.xlsx), write the COMPLETE new table as CSV lines (header first) — it becomes the sheet.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_page",
      description: "Fetch a web page or API from an allowed host, as text.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_page",
      description:
        "Open a page in a real invisible browser (JavaScript runs), wait for it to finish, and return what a person would see. Use when fetch_page returns empty or shell HTML, or for pages that only work in a browser (search answer boxes, finance pages, dashboards). Slower than fetch_page — prefer fetch_page for APIs.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rag_ask",
      description:
        "Search the automation's knowledge base (the person's filed documents) for the passages that answer a question. Returns numbered sources to answer FROM — cite them.",
      parameters: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
      },
    },
  },
];

// Tools are bound per record: file tools only when the record touches
// files, web tools only when it names sources, connector tools only for the
// apps it lists. A triage job sees 5 tools, not 15.
function bindTools(record: AutomationRecord, sandbox: Sandbox | null): {
  defs: ToolDef[];
  specs: ToolSpec[];
  heavy: HeavyToolSpec[];
} {
  const defs: ToolDef[] = [];
  const touchesFiles = sandbox !== null;
  const hasSources = record.sources.length > 0;
  const hasKnowledge = (record.knowledge ?? []).length > 0;
  for (const t of TOOLS) {
    const n = t.function.name;
    if ((n === "list_files" || n === "read_file" || n === "write_file") && !touchesFiles) continue;
    if ((n === "fetch_page" || n === "read_page") && !hasSources) continue;
    if (n === "rag_ask" && !hasKnowledge) continue;
    defs.push(t);
  }
  const specs = toolsFor(record.apps);
  for (const s of specs) defs.push(s.def);
  // Heavy tools bind only when the record lists them, the person allowed
  // heavy tasks, and a sandbox exists (they work in the copy).
  const heavy =
    sandbox && heavyAllowed() ? heavyToolsFor(record.tools) : [];
  for (const h of heavy) defs.push(h.def);
  // A record with nothing bound at all still gets the web pair, so the
  // model has a way to say it can't (never zero tools on a tools call).
  if (defs.length === 0) defs.push(...TOOLS.filter((t) => t.function.name === "fetch_page"));
  return { defs, specs, heavy };
}

function systemPrompt(
  record: AutomationRecord,
  inputValues: Record<string, string>,
  specs: ToolSpec[],
  heavy: HeavyToolSpec[]
): string {
  const roots = [...new Set([...record.files.reads, ...record.files.writes])].join(", ") || "none";
  const sources = record.sources.join(", ") || "none";
  const apps = (record.apps ?? []).join(", ") || "none";
  const outputs = record.outputs.map((o) => o.name).join(", ");
  const inputs = Object.entries(inputValues)
    .map(([k, v]) => `${k} = ${v}`)
    .join("; ");
  const appTools = specs.map((s) => s.def.function.name).join(", ");
  const heavyTools = heavy.map((h) => h.def.function.name).join(", ");
  const now = new Date();
  const today = now.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return [
    `You run "${record.name}" inside Private Pilot's sandbox. Right now it is ${today}.`,
    `The job: ${record.sentence}`,
    `Steps: ${record.steps.join(" → ")}`,
    inputs ? `Given values: ${inputs}` : "",
    `Folders and files you may touch: ${roots}. Websites you may fetch: ${sources}. Apps you may look into: ${apps}${appTools ? ` (tools: ${appTools})` : ""}.`,
    specs.length > 0
      ? "App tools return rows of real data from this computer — quote them; never fetch mail or music through URLs. Ids like m1 come from a listing in THIS run — never make one up, and in your final answer name messages by sender and subject, never by id. A draft is saved for the person to send; you never send."
      : "",
    specs.some((s) => /mail_recent|mail_search/.test(s.def.function.name))
      ? "INBOX TRIAGE: after ONE listing, judge urgency from each message's sender and subject alone. Open a message (…_read) ONLY if you will act on it — draft a reply or describe its details. NEVER open newsletters, promotions, receipts, social or security-alert emails — you already know from the subject that they need no reply. Open at most 3 messages total, then answer. Reading everything wastes the run."
      : "",
    heavy.length > 0
      ? `Heavy tools you may run on files in your folders: ${heavyTools}. They do real work (rename, zip, read scanned documents) in a COPY — the person keeps or discards the results. Give only the folders/files and options; the app builds the command. After a heavy tool succeeds, answer plainly what it did.`
      : "",
    (record.knowledge ?? []).length > 0
      ? `To answer a question about the person's filed documents, call rag_ask{question} ONCE — it returns numbered passages from their "${(record.knowledge ?? [])[0]}" documents. Then answer ONLY from those passages, cite each fact like [1], and if the answer isn't in them reply exactly: "I couldn't find that in your documents." Use no outside knowledge.`
      : "",
    "You are in a loop and can make multiple tool calls before answering. Call exactly one tool per turn.",
    "If the job is to draft, send, or email a message: your final answer IS the message — a subject line, then the body, nothing else. The app shows a Send button; you never send anything yourself and must not say so.",
    "If a fetch is refused, empty, or rate-limited: NEVER invent or guess a value, never output 0 as a stand-in. Say you couldn't read it and end with OUTPUTS: (none).",
    "Answer briefly unless the job asks for more. Never describe your tools or limitations.",
    "Make the answer easy to scan: lead with the key result, then use Markdown bullets when reporting 3 or more items. Put every item on its own line, use **bold** for its name or label, and never cram a list into one paragraph.",
    "When the job is done, answer in plain words: what you did and the key values. If the job defines outputs, end with one line exactly like:",
    outputs ? `OUTPUTS: ${record.outputs.map((o) => `${o.name}=<value>`).join("; ")}` : "OUTPUTS: (none)",
    "",
    "Example session A — job: total the amounts in two receipts into the ledger:",
    "  turn 1 → list_files {\"folder\": \"~/Downloads\"}",
    "  turn 2 → read_file {\"path\": \"~/Downloads/receipt-1.pdf\"}",
    "  turn 3 → read_file {\"path\": \"~/Downloads/receipt-2.pdf\"}",
    "  turn 4 → read_file {\"path\": \"~/Documents/ledger.xlsx\"}",
    "  turn 5 → write_file {\"path\": \"~/Documents/ledger.xlsx\", \"content\": \"Date, Vendor, Amount\\n2026-08-01, Acme, 258\\n2026-08-14, Bolt, 119.5\\n2026-08-14, Iris, 42\"}",
    "  turn 6 → final answer: \"Added 2 receipts to the ledger — $161.50 total. OUTPUTS: amount=161.50; how_many=2\"",
    "Example session B — job: read a price from an API and report it:",
    "  turn 1 → fetch_page {\"url\": \"https://api.example-prices.com/v1/price\"}",
    "  turn 2 → final answer: \"The price is $63,384. OUTPUTS: price=63384\"",
    "Example session C — a file refuses to read:",
    "  turn 1 → read_file {\"path\": \"~/Downloads/broken.pdf\"}",
    "  tool says: Refused broken.pdf — it isn't a text format this tool can read.",
    "  turn 2 → final answer: \"Couldn't read broken.pdf, so I stopped rather than guess. OUTPUTS: (none)\"",
    ...(specs.length > 0
      ? [
          "Example session D — job: the unread mail that needs me first:",
          "  turn 1 → outlook_mail_recent {\"since_hours\": 24, \"unread_only\": true, \"limit\": 20}",
          "  turn 2 → outlook_mail_read {\"id\": \"<an id from the listing>\"}",
          "  turn 3 → final answer: \"5 unread since yesterday; the two that need you: … OUTPUTS: how_many=5\"",
          "Example session E — job: what's playing:",
          "  turn 1 → spotify_now_playing {}",
          "  turn 2 → final answer: \"Spotify is playing \\\"…\\\" by … (paused). OUTPUTS: title=…\"",
        ]
      : []),
  ]
    .filter(Boolean)
    .join("\n");
}

// Connector args are validated + coerced before anything runs; a bad call
// goes back to the model as a plain sentence and costs a turn, never a crash.
function argError(spec: ToolSpec, issues: { path: PropertyKey[]; message: string }[]): string {
  const what = issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`)
    .join("; ");
  const props = Object.keys(
    (spec.def.function.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  );
  return `That call to ${spec.def.function.name} needs fixing — ${what}. Its fields are: ${props.join(", ") || "(none)"}.`;
}

async function listSandboxFiles(sandbox: Sandbox, folderDisplay: string): Promise<string> {
  const sb = toSandboxPath(sandbox, folderDisplay);
  if (!sb) return `Refused — ${folderDisplay} is outside this automation's folders.`;
  if (!(await exists(sb))) return `${folderDisplay} is empty.`;
  const entries = await readDir(sb);
  const names = entries
    .filter((e) => e.isFile)
    .map((e) => `${folderDisplay}/${e.name}`);
  return names.length ? names.join("\n") : `${folderDisplay} is empty.`;
}

export async function runToolLoop(
  record: AutomationRecord,
  model: string,
  sandbox: Sandbox | null, // null = an online automation touching no files
  inputValues: Record<string, string>,
  onEvent: (e: LoopEvent) => void,
  contextNote?: string
): Promise<LoopOutcome> {
  const startedAt = Date.now();
  const bound = bindTools(record, sandbox);
  // Online jobs carry no file corpus, so 16k is ample and substantially
  // quicker on CPU-only machines. File jobs retain the full 32k window.
  const contextSize = sandbox ? NUM_CTX_TOOLS : NUM_CTX_DRAFT;
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        systemPrompt(record, inputValues, bound.specs, bound.heavy) +
        (contextNote
          ? `\nContext: ${contextNote} Any condition in the job's own wording has ALREADY been decided — do not re-check it, just do the job.`
          : ""),
    },
    { role: "user", content: `Do the job now. ${record.sentence}` },
  ];
  const outcome: LoopOutcome = {
    answer: "",
    turns: 0,
    corpus: "",
    contextTrimmed: false,
    recoveredCalls: 0,
    refusals: [],
    logLines: [],
    stalled: false,
    heldBack: null,
    handoffs: [],
    appsRead: 0,
    heavyRan: false,
  };
  let filesRead = 0;
  let filesWritten = 0;
  const toolCtx: ToolContext = {
    runNote: (line) => onEvent({ text: `Tool loop — ${line}` }),
    memory: new Map<string, unknown>([["inputs.values", Object.values(inputValues)]]),
    // A connector (gmail_save_attachment) can drop a file into the sandbox's
    // first write root so a heavy tool can then work on it.
    writeSandboxFile: sandbox
      ? async (name, bytes) => {
          // Only a declared WRITE folder — never a read-only root fallback,
          // which would land the file somewhere the record can't write.
          const root = sandbox.roots.find((r) =>
            record.files.writes.some(
              (w) => w === r.display || r.display.startsWith(w) || w.startsWith(r.display + "/")
            )
          );
          if (!root) return null;
          const sep = root.sandboxPath.includes("\\") ? "\\" : "/";
          const path = `${root.sandboxPath}${sep}${name}`;
          const { writeFile } = await import("@tauri-apps/plugin-fs");
          await writeFile(path, bytes);
          return `${root.display}/${name}`;
        }
      : undefined,
  };
  const specByName = new Map(bound.specs.map((s) => [s.def.function.name, s]));
  const heavyByName = new Map(bound.heavy.map((h) => [h.def.function.name, h]));
  const heavyCtx: HeavyContext | null = sandbox
    ? {
        runNote: (line) => onEvent({ text: `Tool loop — ${line}` }),
        sandbox,
        binary: findBinary,
        toSandbox: (display) => toSandboxPath(sandbox, display),
      }
    : null;
  const boundNames = bound.defs.map((d) => d.function.name).join(", ");
  const maxTurns =
    bound.specs.length > 0 || bound.heavy.length > 0 ? MAX_TURNS_APPS : MAX_TURNS;
  // A run that writes files needs room to emit whole-file content in one call.
  const writesFiles = (record.files?.writes?.length ?? 0) > 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (Date.now() - startedAt > STALL_MS) {
      outcome.stalled = true;
      outcome.answer = "";
      return outcome;
    }
    outcome.turns = turn;
    onEvent({
      text: `Tool loop — turn ${turn}${filesRead ? ` · read ${filesRead} file${filesRead === 1 ? "" : "s"}` : ""}${filesWritten ? ` · wrote ${filesWritten}` : ""}`,
    });

    // Truncation guard: estimate tokens (chars/4); over 85% of num_ctx →
    // drop the oldest tool results (never the system prompt).
    let estTokens = messages.reduce((n, m) => n + m.content.length, 0) / 4;
    while (estTokens > contextSize * CTX_GUARD) {
      const idx = messages.findIndex(
        (m, i) => i > 1 && m.role === "tool" && m.content !== "(forgotten)"
      );
      if (idx < 0) break;
      messages[idx] = { ...messages[idx], content: "(forgotten)" };
      outcome.contextTrimmed = true;
      estTokens = messages.reduce((n, m) => n + m.content.length, 0) / 4;
    }

    const res = await chat({
      model,
      messages,
      tools: bound.defs, // per-record binding — NO format, never both
      options: {
        num_ctx: contextSize,
        temperature: 0.6,
        top_p: 0.95,
        top_k: 20,
        // A file-writing run must emit the COMPLETE new content (e.g. a whole
        // CSV) in one tool call — 512 tokens truncates a ~40-row table into
        // garbage. Answer-only runs stay tight for speed.
        max_tokens: writesFiles ? 4096 : 1024,
      },
      think: false, // thinking models otherwise spend whole turns saying nothing
    });

    // Recovered calls: (1) tool_calls non-empty → execute; (2) content parses
    // as JSON with name+arguments → execute and log; (3) final answer.
    let calls: ToolCall[] = res.toolCalls;
    if (calls.length === 0) {
      const recovered = tryRecoverCall(res.content);
      if (recovered) {
        calls = [recovered];
        outcome.recoveredCalls++;
        outcome.logLines.push("Recovered a tool call the model wrote as text.");
      }
    }

    if (calls.length === 0) {
      const answer = res.content.trim();
      if (answer.length === 0 && turn < maxTurns) {
        // An empty turn is never an answer — nudge once, honestly logged.
        outcome.logLines.push("An empty turn — asked it to answer in words.");
        messages.push({
          role: "user",
          content:
            "Answer now in plain words: what you did and the key values, ending with the OUTPUTS line.",
        });
        continue;
      }
      outcome.answer = answer;
      return outcome;
    }

    messages.push({
      role: "assistant",
      content: res.content ?? "",
      tool_calls: calls,
    });

    for (const call of calls) {
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      let result: string;
      const NO_FILES =
        "This automation touches no files — it works online. Use fetch_page, or answer.";
      try {
        if (name === "list_files") {
          result = sandbox
            ? await listSandboxFiles(sandbox, String(args.folder ?? ""))
            : NO_FILES;
        } else if (name === "read_file") {
          const display = String(args.path ?? "");
          const sb = sandbox ? toSandboxPath(sandbox, display) : null;
          if (!sandbox) {
            result = NO_FILES;
          } else
          if (!sb) {
            result = `Refused — ${display} is outside this automation's folders.`;
            outcome.refusals.push(result);
          } else {
            const r = await readAnyFile(sb);
            filesRead++;
            outcome.logLines.push(r.logLine);
            outcome.corpus += `\n\n=== ${display} ===\n${r.text}`;
            // Placement rule (lost-in-the-middle): document at the top,
            // metadata after, the job restated last.
            result = `${r.text}\n---\n${r.logLine}\nThe job remains: ${record.sentence}`;
          }
        } else if (name === "write_file") {
          const display = String(args.path ?? "");
          const sb = sandbox ? toSandboxPath(sandbox, display) : null;
          if (!sandbox) {
            result = NO_FILES;
          } else if (!sb) {
            result = `Refused — ${display} is outside this automation's folders.`;
            outcome.refusals.push(result);
          } else if (!underWriteFence(display, record.files.writes)) {
            // A folder declared for READING is not a place to write — writing
            // there would stage (and Keep would apply) an edit to a file the
            // automation was only meant to look at.
            result = `Refused — ${display} is in a read-only folder for this automation. It writes into: ${record.files.writes.join(", ") || "(nowhere — no write folder was set)"}.`;
            outcome.refusals.push(result);
          } else {
            await writeSandboxFile(sb, display, String(args.content ?? ""));
            filesWritten++;
            const line = `Wrote ${display} (${String(args.content ?? "").length.toLocaleString()} characters) — in the sandbox copy.`;
            outcome.logLines.push(line);
            result = `${line}\nThe job remains: ${record.sentence}`;
          }
        } else if (name === "fetch_page") {
          const f = await fetchPage(String(args.url ?? ""), record.sources);
          outcome.logLines.push(f.logLine);
          if (f.ok) outcome.corpus += `\n\n=== ${args.url} ===\n${f.text}`;
          if (!f.ok && f.family === "on_purpose") outcome.refusals.push(f.text);
          result = f.ok
            ? `${f.text}\n---\n${f.logLine}\nThe job remains: ${record.sentence}`
            : f.text;
        } else if (name === "read_page") {
          onEvent({ text: `Tool loop — reading a page like a browser…` });
          const { readRenderedPage } = await import("./renderPage");
          const f = await readRenderedPage(String(args.url ?? ""), record.sources);
          outcome.logLines.push(f.logLine);
          if (f.ok)
            outcome.corpus += `\n\n=== rendered ${args.url}${f.method === "vision" ? " (vision read)" : ""} ===\n${f.text}`;
          if (!f.ok && f.family === "on_purpose") outcome.refusals.push(f.text);
          result = f.ok
            ? `${f.text}\n---\n${f.logLine}\nThe job remains: ${record.sentence}`
            : f.text;
        } else if (name === "rag_ask" && (record.knowledge ?? []).length > 0) {
          const kb = (record.knowledge ?? [])[0] ?? "";
          const question = String(args.question ?? "").trim() || record.sentence;
          onEvent({ text: `Tool loop — searching "${kb}"…` });
          const { retrieve } = await import("../rag/ask");
          const r = await retrieve(kb, question);
          if (!r.ok) {
            // Nothing to answer from — held back with the honest sentence.
            outcome.heldBack = r.sentence;
            outcome.answer = "";
            return outcome;
          }
          // Total/sum questions: extract amounts with the model, sum in code,
          // and hand the model the verified total (never its own arithmetic).
          let ragContext = r.context;
          const { asksForTotal, computeVerifiedTotal } = await import("../rag/totals");
          if (asksForTotal(question)) {
            const verified = await computeVerifiedTotal(r.sources, model);
            if (verified) ragContext = `${r.context}\n\n${verified}`;
          }
          outcome.corpus += `\n\n=== ${kb} (your documents) ===\n${ragContext}`;
          outcome.appsRead++;
          outcome.logLines.push(
            `Searched "${kb}" — the top ${r.sources.length} matching passage${r.sources.length === 1 ? "" : "s"} from your filed documents.`
          );
          result = `Answer ONLY from these numbered passages of the person's own documents. Cite each fact like [1]. If a line marked "COMPUTED IN CODE" is present, use that exact total — it is the trustworthy sum. Otherwise you MAY add/compare/count the numbers that appear here and cite every passage used. If the answer isn't here, reply exactly: "I couldn't find that in your documents."\n\n${ragContext}\n\nThe question: ${question}`;
        } else if (specByName.has(name)) {
          const spec = specByName.get(name)!;
          const parsed = spec.params.safeParse(args);
          if (!parsed.success) {
            result = argError(spec, parsed.error.issues);
            outcome.logLines.push(`${name}: the model's arguments didn't fit — asked it to fix them.`);
          } else {
            const r = await spec.run(parsed.data as Record<string, unknown>, toolCtx);
            outcome.logLines.push(r.logLine);
            if (r.ok) {
              outcome.appsRead++;
              if (r.corpusText) outcome.corpus += `\n\n=== ${name} ===\n${r.corpusText}`;
              if (r.handoff) outcome.handoffs.push(r.handoff);
              result = `${r.text}\n---\n${r.logLine}\nThe job remains: ${record.sentence}`;
            } else if (r.family === "on_purpose") {
              outcome.refusals.push(r.text);
              result = r.text;
            } else {
              // needs_you / broke from an app: stop here, held back. The
              // model never answers from partial app data.
              outcome.heldBack = r.text;
              outcome.answer = "";
              return outcome;
            }
          }
        } else if (heavyByName.has(name) && heavyCtx) {
          const tool = heavyByName.get(name)!;
          const parsed = tool.params.safeParse(args);
          if (!parsed.success) {
            result = argError(
              { def: tool.def } as ToolSpec,
              parsed.error.issues
            );
            outcome.logLines.push(`${name}: the arguments didn't fit — asked it to fix them.`);
          } else {
            const r = await tool.run(parsed.data as Record<string, unknown>, heavyCtx);
            outcome.logLines.push(r.logLine);
            outcome.heavyRan ||= r.ok;
            if (r.ok) {
              if (r.corpusText) outcome.corpus += `\n\n=== ${name} ===\n${r.corpusText}`;
              filesWritten++;
              result = `${r.text}\n---\n${r.logLine}\nThe job remains: ${record.sentence}`;
            } else if (r.family === "on_purpose") {
              outcome.refusals.push(r.text);
              result = r.text;
            } else {
              // A heavy tool that needs you (allow / get the toolkit) or broke
              // stops the run — never a green answer over half-done work.
              outcome.heldBack = r.text;
              outcome.answer = "";
              return outcome;
            }
          }
        } else {
          result = `There is no tool named ${name}. The tools are ${boundNames}.`;
        }
      } catch (e) {
        result = `The tool broke: ${String(e)}`;
        outcome.logLines.push(result);
      }
      messages.push({ role: "tool", content: result, tool_name: name });
    }
  }

  // 15 turns without a final answer.
  outcome.answer = "";
  return outcome;
}

function tryRecoverCall(content: string): ToolCall | null {
  const t = content.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try {
    let obj = JSON.parse(t) as Record<string, unknown> | Record<string, unknown>[];
    if (Array.isArray(obj)) obj = obj[0] as Record<string, unknown>;
    const name = (obj.name ?? (obj.function as Record<string, unknown>)?.name) as
      | string
      | undefined;
    const argsRaw =
      obj.arguments ??
      obj.parameters ??
      (obj.function as Record<string, unknown>)?.arguments;
    if (!name) return null;
    const args =
      typeof argsRaw === "string"
        ? (JSON.parse(argsRaw) as Record<string, unknown>)
        : ((argsRaw ?? {}) as Record<string, unknown>);
    return { function: { name, arguments: args } };
  } catch {
    return null;
  }
}

// A write target must sit inside a folder the record declared for WRITING —
// not merely one it may read. Compares the display path against files.writes
// (a file entry, or a folder that contains it).
function underWriteFence(display: string, writes: string[]): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const d = norm(display);
  return writes.some((w) => {
    const wn = norm(w);
    return d === wn || d.startsWith(wn + "/");
  });
}

// Writes land in the sandbox. Spreadsheet targets take CSV text and become
// real workbooks so the diff and the Keep both stay meaningful.
async function writeSandboxFile(
  sandboxPath: string,
  display: string,
  content: string
): Promise<void> {
  const dir = sandboxPath.replace(/[\\/][^\\/]+$/, "");
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  const ext = display.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "xlsx" || ext === "xlsm") {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    for (const line of content.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      ws.addRow(parseCsvLine(line).map((c) => parseCell(c)));
    }
    const buf = await wb.xlsx.writeBuffer();
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(sandboxPath, new Uint8Array(buf as ArrayBuffer));
  } else {
    await writeTextFile(sandboxPath, content);
  }
}

// RFC-4180 CSV: a quoted field may contain commas and "" (an escaped quote).
// A naive split(",") shifts every cell after a quoted "Acme, Inc" one column
// right — corrupting exactly the workbook the diff previews and Keep applies.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseCell(v: string): string | number {
  // A leading-zero string (zip codes, ids like "00123") must stay text — Excel
  // would drop the zeros if it became a number.
  if (/^0\d/.test(v)) return v;
  if (/^-?\$?[\d,]+(\.\d+)?$/.test(v)) {
    const n = Number(v.replace(/[$,]/g, ""));
    if (!Number.isNaN(n)) return n;
  }
  return v;
}
