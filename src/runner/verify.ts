// Stage 4 · Thorough mode: the model re-reads its own answer against the
// source before committing (temp 0). Stage 5 · Grounded verification: every
// delivered number must appear in the source text, or survive one temp-0
// arithmetic check — otherwise the run blocks with "I couldn't confirm that
// number."
import { chat, NUM_CTX_DRAFT } from "../providers";

const CORPUS_CAP = 20_000;

export async function thoroughPass(
  model: string,
  answer: string,
  corpus: string
): Promise<string> {
  // Placement: document at the top, question at the bottom, nothing
  // important in the middle.
  const res = await chat({
    model,
    messages: [
      {
        role: "user",
        content: `${corpus.slice(0, CORPUS_CAP)}\n\n---\nA first pass produced this answer:\n${answer}\n\nRe-read the source above and the answer. If every number and claim matches the source, repeat the answer EXACTLY. Otherwise output only the corrected answer, same format, keeping any OUTPUTS: line.`,
      },
    ],
    options: { num_ctx: NUM_CTX_DRAFT, temperature: 0, seed: 7 },
    think: false,
  });
  const out = res.content.trim();
  return out.length > 0 ? out : answer;
}

export interface VerifyResult {
  ok: boolean;
  unconfirmed: string | null; // the number that failed
  checkedLines: string[]; // "1,240 — sum of 415 + 612.50 + 212.50, checked"
}

function extractNumbers(answer: string): string[] {
  const matches = answer.match(/\$?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
  const out = new Set<string>();
  for (const m of matches) {
    const n = m.replace(/[$,%]/g, "").replace(/,/g, "");
    if (n.length === 0) continue;
    const num = Number(n);
    if (Number.isNaN(num)) continue;
    if (num >= 1900 && num <= 2100 && Number.isInteger(num)) continue; // years
    if (num < 10 && Number.isInteger(num)) continue; // trivial counts
    out.add(n);
  }
  return [...out];
}

// Plain code first: is the claimed number a sum of some subset of the
// numbers that appear in the source? (n capped; cents precision)
function subsetSumDerivation(target: number, corpus: string): string | null {
  const nums = (corpus.match(/\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((s) => Number(s.replace(/,/g, "")))
    .filter((n) => !Number.isNaN(n) && n > 0 && n < 1e9)
    .filter((n) => !(Number.isInteger(n) && n >= 1900 && n <= 2100)); // years
  const values = [...new Set(nums)].slice(0, 22);
  const targetC = Math.round(target * 100);
  const found = new Map<number, number[]>();
  found.set(0, []);
  for (const v of values) {
    const vc = Math.round(v * 100);
    const snapshot = [...found.entries()];
    for (const [sum, parts] of snapshot) {
      const next = sum + vc;
      if (next > targetC || found.has(next)) continue;
      const nextParts = [...parts, v];
      found.set(next, nextParts);
      if (next === targetC && nextParts.length > 1) {
        return nextParts.join(" + ");
      }
    }
    if (found.size > 200_000) break; // stay bounded
  }
  return null;
}

function roundedMatch(claimed: string, corpus: string): string | null {
  const decimals = (claimed.split(".")[1] ?? "").length;
  const target = Math.abs(Number(claimed));
  if (!Number.isFinite(target)) return null;
  const nums = corpus.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g) ?? [];
  for (const raw of nums) {
    const v = Math.abs(Number(raw));
    if (!Number.isFinite(v) || v === target) continue;
    if (Number(v.toFixed(decimals)) === target) return raw;
  }
  return null;
}

export async function verifyNumbers(
  model: string,
  answer: string,
  corpus: string,
  contextText = "" // the record's own sentence/steps/fill-ins — user-given numbers are not inventions
): Promise<VerifyResult> {
  const numbers = extractNumbers(answer);
  if (numbers.length === 0) return { ok: true, unconfirmed: null, checkedLines: [] };

  const flatCorpus = (corpus + "\n" + contextText).replace(/,/g, "");
  const checkedLines: string[] = [];

  for (const n of numbers) {
    if (flatCorpus.includes(n)) continue; // verbatim in the source — verified

    // A model saying "-0.78%" for a source value of -0.7789 is honest
    // rounding, not invention: accept when a source number rounds to the
    // claim at the claim's own precision.
    const rounded = roundedMatch(n, corpus);
    if (rounded) {
      checkedLines.push(`${n} ≈ ${rounded} in the source, rounded · checked in code`);
      continue;
    }

    const derivation = subsetSumDerivation(Number(n), corpus);
    if (derivation) {
      checkedLines.push(`${n} = ${derivation} · checked in code`);
      continue;
    }

    // One temp-0 check: is it derivable (a sum, a count) from the source?
    const res = await chat({
      model,
      messages: [
        {
          role: "user",
          content: `${corpus.slice(0, CORPUS_CAP)}\n\n---\nAn automation claims the number ${n}. Is ${n} exactly derivable from the source above (a sum, difference, count, or restatement)? Show the arithmetic if yes.`,
        },
      ],
      format: {
        type: "object",
        properties: {
          derivable: { type: "boolean" },
          how: { type: "string" },
        },
        required: ["derivable", "how"],
        additionalProperties: false,
      },
      options: { num_ctx: NUM_CTX_DRAFT, temperature: 0, seed: 7 },
      think: false,
    });
    try {
      const verdict = JSON.parse(res.content) as {
        derivable: boolean;
        how: string;
      };
      if (!verdict.derivable) {
        return { ok: false, unconfirmed: n, checkedLines };
      }
      checkedLines.push(`${n} — ${verdict.how.slice(0, 120)} · checked`);
    } catch {
      return { ok: false, unconfirmed: n, checkedLines };
    }
  }
  return { ok: true, unconfirmed: null, checkedLines };
}

// The OUTPUTS: line is the baton. Parse it off the answer.
export function parseOutputs(answer: string): {
  cleanAnswer: string;
  baton: Record<string, string | number> | null;
} {
  const m = answer.match(/OUTPUTS:\s*([^\n]*)/);
  const stripped = answer.replace(/\s*OUTPUTS:[^\n]*/g, "").trim();
  if (!m || /\(none\)/.test(m[1])) {
    return { cleanAnswer: stripped, baton: null };
  }
  const baton: Record<string, string | number> = {};
  for (const pair of m[1].split(";")) {
    const [k, ...rest] = pair.split("=");
    const v = rest.join("=").trim();
    if (!k.trim() || !v) continue;
    const num = Number(v.replace(/[$,]/g, ""));
    baton[k.trim()] = Number.isNaN(num) || v.match(/[A-Za-z]{2,}/) ? v : num;
  }
  return {
    cleanAnswer: answer.replace(/^OUTPUTS:.*$/m, "").trim(),
    baton: Object.keys(baton).length ? baton : null,
  };
}
