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
  // The sequence-shape rules ("don't fold the jobs together", "join them")
  // are worth two nudges, never a dead end: on the last pass they come off,
  // because a draft that answers the request imperfectly beats "the local AI
  // couldn't safely finish this". Whatever shape survives, session.ts draws
  // the missing links itself.
  const lenientSchema = buildWireSchema({
    ...catalog,
    chainIntent: false,
  });
  const argument: string[] = [];
  let fieldsFixed = 0;
  let content = firstContent;
  let attempts = 1;
  let usedEscapeHatch = false;

  // When the request touched no files, the catalog carries no file targets and
  // files.reads/writes compile to z.never(). A model that names a file anyway
  // has invented one — the closed catalog's whole point — and re-prompting it
  // burns two more passes to be told the same thing. Dropping the invented
  // path is the repair, and it is safe precisely because nothing on this
  // machine could have satisfied it. Seen in the wild on "make a sequence of
  // the bitcoin price and the weather in orlando", where a third automation
  // appeared with files.writes[0] set and killed all three drafts.
  const noFilesInPlay =
    catalog.readTargets.length === 0 && catalog.writeTargets.length === 0;
  // A full URL in `sources` is the model answering correctly in the wrong
  // format — it knows the host, it just wrote the whole address. Re-prompting
  // for that is a wasted pass and it recurs on almost every multi-job draft
  // ("https://api.coingecko.com/api/v3/simple/price" where api.coingecko.com
  // belongs). Take the hostname and move on; the fence still checks it.
  const bareHost = (value: string): string => {
    const raw = value.trim();
    if (!raw.includes("/") && !raw.includes(":")) return raw;
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
    } catch {
      return raw;
    }
  };

  const repairDraft = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const draft = value as { automations?: unknown };
    if (!Array.isArray(draft.automations)) return value;
    for (const automation of draft.automations) {
      const a = automation as {
        files?: { reads?: unknown; writes?: unknown };
        sources?: unknown;
      };
      if (Array.isArray(a.sources)) {
        a.sources = a.sources.map((s) => (typeof s === "string" ? bareHost(s) : s));
      }
      // The schema allows 1–6 steps. A branchy request ("check my gmail, if
      // someone wrote summarize it, if not check again") pushes the model past
      // six, and re-prompting does not shrink it — the request really does have
      // that many parts. Fold the overflow into the last step so every
      // instruction survives, rather than losing the tail to a truncation or
      // the whole draft to a refusal.
      const steps = (a as { steps?: unknown }).steps;
      if (Array.isArray(steps)) {
        const text = steps.filter((s): s is string => typeof s === "string");
        if (text.length > 6) {
          (a as { steps: string[] }).steps = [
            ...text.slice(0, 5),
            text.slice(5).join("; "),
          ];
        } else if (text.length === 0) {
          const sentence = (a as { sentence?: unknown }).sentence;
          if (typeof sentence === "string" && sentence.trim())
            (a as { steps: string[] }).steps = [sentence.trim()];
        }
      }
      // When the request touched no files the catalog carries no file targets,
      // so files.reads/writes compile to z.never(). A model that names a file
      // anyway has invented one — the closed catalog's whole point — and
      // dropping it is safe precisely because nothing on this machine could
      // have satisfied it.
      if (noFilesInPlay && a.files) {
        if (Array.isArray(a.files.reads) && a.files.reads.length) a.files.reads = [];
        if (Array.isArray(a.files.writes) && a.files.writes.length) a.files.writes = [];
        // Heavy tools only ever act on a sandbox copy of named folders, so a
        // heavy tool with no folders is not a smaller job — it is no job.
        // Clearing files without clearing these would trade one validator
        // complaint for another.
        if (Array.isArray((a as { tools?: unknown[] }).tools))
          (a as { tools: unknown[] }).tools = [];
      }
    }

    // A chain the model got slightly wrong in SHAPE should not cost the whole
    // draft — the automations are the expensive part and are usually right.
    // "Invalid input → at chain" ran three passes deep on "watch solana and
    // tell me if it drops below 75" because chainDraft is a strictObject: a
    // link is required to carry `map` (an ARRAY of {output,input} pairs, not a
    // record) and an explicit `onlyWhen`. Fill the missing pieces instead of
    // re-prompting, and only drop the chain when a link has no from/to at all,
    // since without those there is nothing to keep.
    const chainValue = (value as { chain?: unknown }).chain as
      | { name?: unknown; links?: unknown }
      | null
      | undefined;
    if (chainValue && typeof chainValue === "object") {
      if (typeof chainValue.name !== "string" || !chainValue.name.trim()) {
        const names = (draft.automations as { name?: string }[])
          .map((a) => a?.name)
          .filter(Boolean);
        chainValue.name = names.join(" → ") || "Sequence";
      }
      if (!Array.isArray(chainValue.links)) chainValue.links = [];
      const usable = (chainValue.links as unknown[]).filter(
        (l) =>
          l &&
          typeof l === "object" &&
          typeof (l as { from?: unknown }).from === "string" &&
          typeof (l as { to?: unknown }).to === "string"
      );
      // A link may only carry an output the next job actually takes as an
      // input. The model reliably invents one plausible extra pair ("price"
      // into a weather job); an unmatched name is a name for nothing. Dropping
      // it leaves the ORDER, which is what a sequence request asks for.
      const inputsOf = (name: string): Set<string> =>
        new Set(
          ((draft.automations as { name?: string; inputs?: { name?: string }[] }[])
            .find((a) => a?.name === name)?.inputs ?? [])
            .map((i) => i?.name)
            .filter(Boolean) as string[]
        );
      for (const link of usable) {
        const l = link as {
          to: string;
          map?: unknown;
          onlyWhen?: unknown;
        };
        if (l.onlyWhen === undefined) l.onlyWhen = null;
        if (!Array.isArray(l.map)) {
          l.map = [];
          continue;
        }
        const allowed = inputsOf(l.to);
        l.map = (l.map as { output?: unknown; input?: unknown }[]).filter(
          (pair) =>
            pair &&
            typeof pair.output === "string" &&
            typeof pair.input === "string" &&
            allowed.has(pair.input)
        );
      }
      chainValue.links = usable;
      if (!usable.length) (value as { chain: unknown }).chain = null;
    }
    return value;
  };

  for (let pass = 1; pass <= 3; pass++) {
    let parsed: unknown;
    let prettified: string;
    try {
      parsed = repairDraft(JSON.parse(content));
      const result = (pass === 3 ? lenientSchema : schema).safeParse(parsed);
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
