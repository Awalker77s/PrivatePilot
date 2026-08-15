// One schema source of truth: the AutomationRecord wire shape, built
// dynamically from the closed catalog so hallucinated paths are unsampleable.
// Converter-safety (llama.cpp schema→grammar has gaps): no regex shorthands,
// min/max only on integers, no properties mixed with anyOf in one type.
// Shape constraints beyond that live in refinements — validator-only.
import { z } from "zod";
import type { Catalog } from "../catalog";
import { CONNECTOR_IDS, allConnectorToolNames, connectorOfTool } from "../../connectors/registry";

export const CATEGORIES = [
  "Documents",
  "Email",
  "Web",
  "Notes",
  "Money",
  "Watch",
  "Files",
] as const;

export const CONDITION_OPS = [
  "crosses_above",
  "crosses_below",
  "moves_more_than_pct",
  "now_contains",
  "changed_at_all",
] as const;

function pathEnum(values: string[]) {
  // z.enum needs a non-empty tuple; an empty catalog leaves no file slots to
  // sample, which is exactly the point of a closed catalog.
  return values.length > 0
    ? z.enum(values as [string, ...string[]])
    : z.never();
}

export function buildWireSchema(catalog: Catalog) {
  const automationDraft = z.strictObject({
    name: z.string(),
    sentence: z.string(),
    category: z.enum(CATEGORIES),
    steps: z.array(z.string()),
    inputs: z.array(
      z.strictObject({
        name: z.string(),
        label: z.string(),
        example: z.string(),
      })
    ),
    outputs: z.array(z.strictObject({ name: z.string() })),
    files: z.strictObject({
      reads: z.array(pathEnum(catalog.readTargets)),
      writes: z.array(pathEnum(catalog.writeTargets)),
    }),
    sources: z.array(z.string()),
    // The apps fence — a closed enum, so an app that doesn't exist can't be
    // sampled at all (same trick as file paths).
    apps: z.array(z.enum(CONNECTOR_IDS)),
    delivers: z.enum(["answer", "files"]),
    schedule: z.union([
      z.strictObject({
        trigger: z.literal("daily"),
        hour: z.int().min(0).max(23),
      }),
      z.strictObject({
        trigger: z.literal("watch"),
        everyMinutes: z.int().min(5).max(1440),
      }),
      z.strictObject({ trigger: z.literal("manual") }),
    ]),
    effort: z.enum(["quick", "thorough"]),
  });

  const chainDraft = z.strictObject({
    name: z.string(),
    links: z.array(
      z.strictObject({
        from: z.string(),
        to: z.string(),
        // outputs → inputs by name; an array of pairs is grammar-safe where
        // a free-key record is not. Converted to the record shape at save.
        map: z.array(
          z.strictObject({ output: z.string(), input: z.string() })
        ),
        onlyWhen: z.union([
          z.strictObject({
            field: z.string(),
            op: z.enum(CONDITION_OPS),
            value: z.union([z.number(), z.string(), z.null()]),
          }),
          z.null(),
        ]),
      })
    ),
  });

  const questionDraft = z.strictObject({
    asking: z.string(), // the one thing it couldn't pin down, as a question
    kind: z.enum(["file", "folder", "website", "automation", "schedule", "other"]),
    term: z.string(), // the user's words it couldn't ground, verbatim
  });

  const wire = z
    .strictObject({
      automations: z.array(automationDraft),
      chain: z.union([chainDraft, z.null()]),
      question: z.union([questionDraft, z.null()]),
    })
    // ---- validator-only refinements (not part of the grammar) ----
    .superRefine((v, ctx) => {
      if (v.question === null && v.automations.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["automations"],
          message: "Draft at least one automation, or ask a question.",
        });
      }
      if (v.question !== null && v.automations.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["question"],
          message:
            "Either draft automations or ask one question — never both.",
        });
      }
      const names = new Set(v.automations.map((a) => a.name));
      v.automations.forEach((a, i) => {
        const words = a.name.trim().split(/\s+/).length;
        if (words < 1 || words > 4) {
          ctx.addIssue({
            code: "custom",
            path: ["automations", i, "name"],
            message: "Name the automation in 2–4 words.",
          });
        }
        if (a.steps.length < 1 || a.steps.length > 6) {
          ctx.addIssue({
            code: "custom",
            path: ["automations", i, "steps"],
            message: "Give 1–6 short steps.",
          });
        }
        if (a.sentence.trim().length === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["automations", i, "sentence"],
            message: "Write the one-sentence description.",
          });
        }
        for (const s of a.sources) {
          if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(s)) {
            ctx.addIssue({
              code: "custom",
              path: ["automations", i, "sources"],
              message: `"${s}" is not a bare hostname like api.coingecko.com.`,
            });
          }
        }
        // App tools in the steps must belong to an app in the fence, and
        // mail/music never travel through URLs when the app is listed.
        const stepText = a.steps.join("\n");
        for (const tool of allConnectorToolNames()) {
          if (new RegExp(`\\b${tool}\\b`).test(stepText)) {
            const owner = connectorOfTool(tool);
            if (owner && !a.apps.includes(owner)) {
              ctx.addIssue({
                code: "custom",
                path: ["automations", i, "apps"],
                message: `The steps call ${tool}, so apps must include "${owner}".`,
              });
            }
          }
        }
        for (const s of a.sources) {
          if (a.apps.includes("outlook") && /outlook|office|graph\.microsoft/i.test(s)) {
            ctx.addIssue({
              code: "custom",
              path: ["automations", i, "sources"],
              message: `Outlook is read through its app tools, not ${s} — remove it from sources.`,
            });
          }
          if (a.apps.includes("spotify") && /spotify/i.test(s)) {
            ctx.addIssue({
              code: "custom",
              path: ["automations", i, "sources"],
              message: `Spotify is read through its app tools, not ${s} — remove it from sources.`,
            });
          }
        }
      });
      // Independent automations are fine unchained — a chain is only for
      // hand-offs the person actually asked for.
      if (v.chain) {
        if (v.chain.links.length > 3) {
          ctx.addIssue({
            code: "custom",
            path: ["chain", "links"],
            message: "Chains cap at 3 hops.",
          });
        }
        const known = (n: string) =>
          names.has(n) || false; // existing automations join in later steps
        v.chain.links.forEach((l, i) => {
          if (l.map.length === 0 && l.onlyWhen === null) {
            ctx.addIssue({
              code: "custom",
              path: ["chain", "links", i],
              message:
                "This link carries nothing — map outputs to inputs, set onlyWhen, or leave the jobs independent with chain null.",
            });
          }
          if (l.from === l.to) {
            ctx.addIssue({
              code: "custom",
              path: ["chain", "links", i],
              message: "A link can't hand off to itself.",
            });
          }
          for (const [key, n] of [
            ["from", l.from],
            ["to", l.to],
          ] as const) {
            if (!known(n)) {
              ctx.addIssue({
                code: "custom",
                path: ["chain", "links", i, key],
                message: `"${n}" is not one of the drafted automation names.`,
              });
            }
          }
          const fromAuto = v.automations.find((a) => a.name === l.from);
          const toAuto = v.automations.find((a) => a.name === l.to);
          for (const pair of l.map) {
            if (
              fromAuto &&
              !fromAuto.outputs.some((o) => o.name === pair.output)
            ) {
              ctx.addIssue({
                code: "custom",
                path: ["chain", "links", i, "map"],
                message: `"${pair.output}" is not an output of "${l.from}".`,
              });
            }
            if (toAuto && !toAuto.inputs.some((inp) => inp.name === pair.input)) {
              ctx.addIssue({
                code: "custom",
                path: ["chain", "links", i, "map"],
                message: `"${pair.input}" is not an input of "${l.to}".`,
              });
            }
          }
        });
      }
    });

  return wire;
}

export type WireDraft = z.infer<ReturnType<typeof buildWireSchema>>;
export type WireAutomation = WireDraft["automations"][number];

// ---- referential-integrity lints (validator-only, shared by the compile
// loop and chat edits — the wire grammar never grows) ----
export function lintAutomation(a: {
  steps: string[];
  sources: string[];
  inputs: { name: string }[];
  apps?: string[];
}): string[] {
  const issues: string[] = [];
  const stepText = a.steps.join("\n");
  // Every app tool named in a step must belong to an app in the fence.
  const apps = a.apps ?? [];
  for (const tool of allConnectorToolNames()) {
    if (new RegExp(`\\b${tool}\\b`).test(stepText)) {
      const owner = connectorOfTool(tool);
      if (owner && !apps.includes(owner)) {
        issues.push(
          `The steps call ${tool}, but "${owner}" isn't in apps — add it to the fence or take the step out.`
        );
      }
    }
  }
  // Mail and music never travel through URLs when an app is listed.
  if (apps.includes("outlook") && /https?:\/\/[^\s]*(outlook|office|graph\.microsoft)/i.test(stepText)) {
    issues.push("Outlook is read through its app tools, not through a URL — drop the outlook/graph URL from the steps.");
  }
  // Every hostname fetched in a step must be inside the fence.
  for (const m of stepText.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    const host = m[1].toLowerCase();
    const fenced = a.sources.some(
      (s) => host === s.toLowerCase() || host.endsWith(`.${s.toLowerCase()}`)
    );
    if (!fenced) {
      issues.push(
        `The steps fetch ${host}, but it isn't in sources — add it to the fence or take the step out.`
      );
    }
  }
  // Every {token} in steps must be a declared input, and inputs must be used.
  const tokens = [...stepText.matchAll(/\{([a-z0-9_]+)\}/gi)].map((m) => m[1]);
  for (const t of tokens) {
    if (!a.inputs.some((i) => i.name === t)) {
      issues.push(`Steps reference {${t}} but there is no fill-in named "${t}".`);
    }
  }
  for (const inp of a.inputs) {
    if (!tokens.includes(inp.name) && a.steps.length > 0) {
      // unused fill-ins are a smell, not a failure — surfaced softly
      issues.push(
        `The fill-in "${inp.name}" is never used in the steps — reference it as {${inp.name}} or remove it.`
      );
    }
  }
  return issues;
}

// Re-validate a record after a chat edit's merge patch: the same shape and
// catalog grounding the compiler enforces, so an edit can't smuggle in an
// unfenced host or an uncataloged path.
export function validateEditedAutomation(
  record: {
    name: string;
    sentence: string;
    category: string;
    steps: string[];
    inputs: { name: string; label: string; example: string }[];
    outputs: { name: string }[];
    files: { reads: string[]; writes: string[] };
    sources: string[];
    apps?: string[];
    delivers: string;
    schedule: unknown;
    effort: string;
  },
  catalog: Catalog
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const single = buildWireSchema(catalog);
  const probe = {
    automations: [
      {
        name: record.name,
        sentence: record.sentence,
        category: record.category,
        steps: record.steps,
        inputs: record.inputs,
        outputs: record.outputs,
        files: record.files,
        sources: record.sources,
        apps: record.apps ?? [],
        delivers: record.delivers,
        schedule: record.schedule,
        effort: record.effort,
      },
    ],
    chain: null,
    question: null,
  };
  const result = single.safeParse(probe);
  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push(issue.message);
    }
  }
  issues.push(...lintAutomation(record));
  return { ok: issues.length === 0, issues };
}

export function wireJsonSchema(catalog: Catalog): Record<string, unknown> {
  // The same schema goes on the wire (format:) and into the prompt — grammar
  // guarantees shape, the prompt copy improves content.
  return z.toJSONSchema(buildWireSchema(catalog), {
    target: "draft-07",
  }) as Record<string, unknown>;
}
