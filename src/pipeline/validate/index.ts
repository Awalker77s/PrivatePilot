// Stage 2 · Validator loop. Parse → Zod validate → re-prompt with exactly
// three parts: z.prettifyError(err) verbatim, the model's previous JSON, and
// "Fix only the fields listed. Change nothing else." Max 3 attempts, then a
// question card — never a crash. Constrained decoding can produce
// valid-but-wrong output; the counters prove the loop earns its keep.
import { z } from "zod";
import { chat, NUM_CTX_DRAFT } from "../../providers";
import type { ChatMessage } from "../../providers/types";
import type { Catalog } from "../catalog";
import { buildWireSchema, WireDraft, wireJsonSchema } from "../draft/schema";
import { planFreeThenTranscribe, DraftContext } from "../draft";

export interface ValidateOutcome {
  ok: boolean;
  draft: WireDraft | null;
  attempts: number; // total model drafts consumed
  fieldsFixed: number; // issues surfaced across re-prompts
  argument: string[]; // the validator's argument with the model, for the UI
  lastError: string | null;
}

export async function validateLoop(
  model: string,
  catalog: Catalog,
  baseMessages: ChatMessage[],
  firstContent: string,
  context: DraftContext,
  onProgress: (text: string) => void,
  signal?: AbortSignal
): Promise<ValidateOutcome> {
  const schema = buildWireSchema(catalog);
  const argument: string[] = [];
  let fieldsFixed = 0;
  let content = firstContent;
  let attempts = 1;
  let usedEscapeHatch = false;

  for (let pass = 1; pass <= 3; pass++) {
    let parsed: unknown;
    let prettified: string;
    try {
      parsed = JSON.parse(content);
      const result = schema.safeParse(parsed);
      if (result.success) {
        argument.push(
          pass === 1
            ? "Draft 1 — clean on the first pass."
            : `Draft ${pass} — clean.`
        );
        return {
          ok: true,
          draft: result.data,
          attempts,
          fieldsFixed,
          argument,
          lastError: null,
        };
      }
      prettified = z.prettifyError(result.error);
      const issueCount = result.error.issues.length;
      fieldsFixed += issueCount;
      argument.push(
        `Draft ${pass} — ${issueCount} field${issueCount === 1 ? "" : "s"} wrong → asking it to fix them`
      );
    } catch (e) {
      prettified = `The response was not valid JSON: ${String(e)}`;
      fieldsFixed += 1;
      const snippet =
        content.trim().length === 0
          ? "(empty response)"
          : `starts "${content.trim().slice(0, 60)}…"`;
      argument.push(
        `Draft ${pass} — not valid JSON ${snippet} → asking again`
      );
    }

    if (pass === 3) {
      return {
        ok: false,
        draft: null,
        attempts,
        fieldsFixed,
        argument,
        lastError: prettified,
      };
    }

    // Escape hatch: schema-constrained drafting failed twice → reason free,
    // constrain late.
    if (pass === 2 && !usedEscapeHatch) {
      usedEscapeHatch = true;
      onProgress("Validator — letting it think in plain words first…");
      try {
        const res = await planFreeThenTranscribe(model, catalog, context, signal);
        content = res.content;
        attempts++;
        argument.push("Tried again the long way — plan first, then transcribe.");
        continue;
      } catch {
        // fall through to the normal re-prompt
      }
    }

    onProgress(`Validator — attempt ${pass + 1} of 3…`);
    const fixMessages: ChatMessage[] = [
      ...baseMessages,
      { role: "assistant", content },
      {
        role: "user",
        content: `${prettified}\n\nYour previous JSON:\n${content}\n\nFix only the fields listed. Change nothing else.`,
      },
    ];
    const res = await chat({
      model,
      messages: fixMessages,
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
    content = res.content;
    attempts++;
  }

  return {
    ok: false,
    draft: null,
    attempts,
    fieldsFixed,
    argument,
    lastError: "unreachable",
  };
}
