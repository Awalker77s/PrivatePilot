// When a question asks for a total/sum across documents, we do NOT trust the
// model's arithmetic (a small model extracts numbers well but adds them
// badly). Instead: the model EXTRACTS the one total amount from each source
// (its strength), and the SUM is computed here in code (its weakness). The
// verified total is handed back as a fact the answer must use — and because
// it's now in the corpus, the runner's number-verification accepts it.
import { chat } from "../providers";
import type { RagSource } from "./ask";

const TOTAL_INTENT = /\b(total|totals|sum|summed|altogether|combined|in all|how much (did|have) .*(spend|spent|cost|pay|paid)|grand total)\b/i;

export function asksForTotal(question: string): boolean {
  return TOTAL_INTENT.test(question);
}

interface Extracted {
  n: number;
  amount: number;
  currency: string;
}

// Ask the model ONLY to read the final total off each source, as strict JSON.
export async function computeVerifiedTotal(
  sources: RagSource[],
  model: string
): Promise<string | null> {
  const context = sources.map((s) => `[${s.n}] ${s.text}`).join("\n\n");
  let res;
  try {
    res = await chat({
      model,
      messages: [
        {
          role: "system",
          content:
            "For each numbered document below that is a receipt, invoice, or bill, read the single FINAL total amount paid (the grand total, not a line item or subtotal). Respond with ONLY a JSON array like [{\"n\":1,\"amount\":80.91,\"currency\":\"RM\"}] — one entry per document that has a clear total, omit any that don't. Numbers only, no symbols in amount.",
        },
        { role: "user", content: context },
      ],
      format: {
        type: "array",
        items: {
          type: "object",
          properties: {
            n: { type: "integer" },
            amount: { type: "number" },
            currency: { type: "string" },
          },
          required: ["n", "amount", "currency"],
        },
      } as unknown as Record<string, unknown>,
      options: { num_ctx: 8192, temperature: 0 },
      think: false,
    });
  } catch {
    return null;
  }
  let rows: Extracted[];
  try {
    rows = JSON.parse(res.content) as Extracted[];
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // Sum in code, per currency. This is the number the app stands behind.
  const byCurrency = new Map<string, { sum: number; parts: string[] }>();
  for (const r of rows) {
    const amt = Number(r.amount);
    if (!Number.isFinite(amt)) continue;
    const cur = (r.currency || "").toString().trim() || "";
    const entry = byCurrency.get(cur) ?? { sum: 0, parts: [] };
    entry.sum += amt;
    entry.parts.push(`${amt.toFixed(2)}${cur ? " " + cur : ""} [${r.n}]`);
    byCurrency.set(cur, entry);
  }
  if (byCurrency.size === 0) return null;

  const lines: string[] = [];
  for (const [cur, e] of byCurrency) {
    lines.push(
      `${e.parts.join(" + ")} = ${e.sum.toFixed(2)}${cur ? " " + cur : ""}`
    );
  }
  // A trustworthy fact the model must quote verbatim; it lands in the corpus
  // so number-verification accepts the derived total.
  return `COMPUTED IN CODE (trustworthy — use this exact total): ${lines.join("; ")}.`;
}
