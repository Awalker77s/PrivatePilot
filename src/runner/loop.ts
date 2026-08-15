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

const MAX_TURNS = 15;
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
];

function systemPrompt(record: AutomationRecord, inputValues: Record<string, string>): string {
  const roots = [...new Set([...record.files.reads, ...record.files.writes])].join(", ") || "none";
  const sources = record.sources.join(", ") || "none";
  const outputs = record.outputs.map((o) => o.name).join(", ");
  const inputs = Object.entries(inputValues)
    .map(([k, v]) => `${k} = ${v}`)
    .join("; ");
  return [
    `You run "${record.name}" inside Private Pilot's sandbox.`,
    `The job: ${record.sentence}`,
    `Steps: ${record.steps.join(" → ")}`,
    inputs ? `Given values: ${inputs}` : "",
    `Folders and files you may touch: ${roots}. Websites you may fetch: ${sources}.`,
    "You are in a loop and can make multiple tool calls before answering. Call exactly one tool per turn.",
    "If the job is to draft, send, or email a message: your final answer IS the message — a subject line, then the body, nothing else. The app shows a Send button; you never send anything yourself and must not say so.",
    "If a fetch is refused, empty, or rate-limited: NEVER invent or guess a value, never output 0 as a stand-in. Say you couldn't read it and end with OUTPUTS: (none).",
    "Answer in at most three sentences unless the job asks for more. Never describe your tools or limitations.",
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
  ]
    .filter(Boolean)
    .join("\n");
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
  // Online jobs carry no file corpus, so 16k is ample and substantially
  // quicker on CPU-only machines. File jobs retain the full 32k window.
  const contextSize = sandbox ? NUM_CTX_TOOLS : NUM_CTX_DRAFT;
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        systemPrompt(record, inputValues) +
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
  };
  let filesRead = 0;
  let filesWritten = 0;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
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
      tools: TOOLS, // NO format — never both
      options: {
        num_ctx: contextSize,
        temperature: 0.6,
        top_p: 0.95,
        top_k: 20,
        max_tokens: 512,
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
      if (answer.length === 0 && turn < MAX_TURNS) {
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
        } else {
          result = `There is no tool named ${name}. The tools are list_files, read_file, write_file, fetch_page, read_page.`;
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
      ws.addRow(line.split(",").map((c) => parseCell(c.trim())));
    }
    const buf = await wb.xlsx.writeBuffer();
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(sandboxPath, new Uint8Array(buf as ArrayBuffer));
  } else {
    await writeTextFile(sandboxPath, content);
  }
}

function parseCell(v: string): string | number {
  if (/^-?\$?[\d,]+(\.\d+)?$/.test(v)) {
    const n = Number(v.replace(/[$,]/g, ""));
    if (!Number.isNaN(n)) return n;
  }
  return v;
}
