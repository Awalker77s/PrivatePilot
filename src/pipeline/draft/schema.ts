// One schema source of truth: the AutomationRecord wire shape, built
// dynamically from the closed catalog so hallucinated paths are unsampleable.
// Converter-safety (llama.cpp schema→grammar has gaps): no regex shorthands,
// min/max only on integers, no properties mixed with anyOf in one type.
// Shape constraints beyond that live in refinements — validator-only.
import { z } from "zod";
import type { Catalog } from "../catalog";
import { CONNECTOR_IDS, allConnectorToolNames, connectorOfTool } from "../../connectors/registry";
import { HEAVY_TOOL_IDS, heavyToolNames } from "../../heavy/registry";

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
    // The heavy-tools fence — same closed-enum trick.
    tools: z.array(z.enum(HEAVY_TOOL_IDS)),
    // Knowledge bases (named document collections) this job reads or fills.
    // Free strings: the person creates KBs by name; the runner validates one
    // exists at run time and refuses honestly otherwise.
    knowledge: z.array(z.string()),
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
    // Branching (use INSTEAD of links when the person's words route on
    // results: "if…, otherwise…, depending on…"): a flat step list. Each step
    // names the automations it runs after, the outcome that lets it fire, and
    // an optional test on the earlier step's answer.
    steps: z.array(
      z.strictObject({
        id: z.string(), // "s1", "s2", …
        automation: z.string(), // a drafted automation's name
        after: z.array(z.string()), // step ids; [] = the first step
        needs: z.enum(["all", "any"]), // "any" = fire after whichever came through
        // "failed" = the earlier step didn't work (held or broke) — use it for
        // "if it fails / if it's down". "ran" = it succeeded.
        when: z.enum(["ran", "held", "broke", "failed", "always"]),
        if_answer_contains: z.union([z.string(), z.null()]),
        if_answer_lacks: z.union([z.string(), z.null()]),
        map: z.array(
          z.strictObject({ output: z.string(), input: z.string() })
        ),
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
      // Two automations sharing a name collapse at assemble (nameToId is
      // last-wins), so a chain runs one twice and orphans the other. Reject.
      // The prompt says never re-create an existing automation; this is the
      // enforcement. Without it a small model can echo a saved automation's
      // name, the draft validates clean, and the person is handed the
      // already-made one (two records sharing a name also make the older
      // unreachable to name lookup).
      const taken = new Set(
        catalog.automationNames.map((existing) => existing.trim().toLowerCase())
      );
      v.automations.forEach((a, i) => {
        if (taken.has(a.name.trim().toLowerCase())) {
          ctx.addIssue({
            code: "custom",
            path: ["automations", i, "name"],
            message: `"${a.name}" already exists. This request is a DIFFERENT job — draft it from the request's own words and give it its own name.`,
          });
        }
      });
      const lowerNames = v.automations.map((a) => a.name.trim().toLowerCase());
      v.automations.forEach((a, i) => {
        if (lowerNames.indexOf(a.name.trim().toLowerCase()) !== i) {
          ctx.addIssue({
            code: "custom",
            path: ["automations", i, "name"],
            message: `Two automations are both named "${a.name}" — give each a distinct name.`,
          });
        }
      });
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
          if (a.apps.includes("gmail") && /gmail|googleapis|google\.com/i.test(s)) {
            ctx.addIssue({
              code: "custom",
              path: ["automations", i, "sources"],
              message: `Gmail is read through its app tools, not ${s} — remove it from sources.`,
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
        // Heavy tools: named in a step ⇒ must be in the tools fence; a job
        // with heavy tools acts on files, so it needs a files fence; and a
        // watcher may NEVER run a heavy tool.
        for (const tool of heavyToolNames()) {
          if (new RegExp(`\\b${tool}\\b`).test(stepText) && !a.tools.includes(tool as (typeof HEAVY_TOOL_IDS)[number])) {
            ctx.addIssue({
              code: "custom",
              path: ["automations", i, "tools"],
              message: `The steps use ${tool}, so tools must include "${tool}".`,
            });
          }
        }
        if (a.tools.length > 0) {
          if (a.files.reads.length === 0 && a.files.writes.length === 0) {
            ctx.addIssue({
              code: "custom",
              path: ["automations", i, "files"],
              message: "A job that uses heavy tools must name the folders it works on in files.",
            });
          }
          if (a.schedule.trigger === "watch") {
            ctx.addIssue({
              code: "custom",
              path: ["automations", i, "schedule"],
              message: "Watchers check values — they never run heavy tools. Make it daily, or run it yourself.",
            });
          }
        }
      });
      // A coordination-split segment is ONE job by construction — a draft
      // with siblings is the model mimicking history, not the request.
      if (catalog.singleJob && v.automations.length > 1) {
        ctx.addIssue({
          code: "custom",
          path: ["automations"],
          message: `This request is ONE job — draft exactly one automation (you drafted ${v.automations.length}). Remove the others; do not invent companions from the conversation history.`,
        });
      }
      // The person's words routed on a result ("if…, otherwise…, depending
      // on…") — several jobs with no chain.steps is the drafter missing the
      // routing, not a choice. Insist, with the shape spelled out.
      // Branching must be expressed as steps. Plain links run BOTH branches
      // unconditionally every time — so branch-intent with no steps is wrong
      // whether links are empty or not.
      if (
        catalog.branchIntent &&
        v.automations.length > 1 &&
        (v.chain === null || v.chain.steps.length === 0)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["chain"],
          message:
            'The person said the next automation depends on an earlier RESULT ("if…, otherwise…"). Express this with chain.steps (links MUST be []): the first job {"id": "s1", "after": [], …}; each branch after it with if_answer_contains or if_answer_lacks naming the word the result is tested for. Plain links would run every branch every time.',
        });
      }
      // The person explicitly asked for ONE connected sequence ("as a
      // chain", "connect them") — several jobs arriving unchained is the
      // drafter dropping the ask. Insist. (Branch-intent wins when both
      // fire: its steps ARE a chain.)
      if (
        catalog.chainIntent &&
        !catalog.branchIntent &&
        v.automations.length > 1 &&
        (v.chain === null ||
          (v.chain.links.length === 0 && v.chain.steps.length === 0))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["chain"],
          message:
            'The person asked for these jobs to run as ONE connected sequence ("as a chain/sequence", "connect them"). Set chain.links joining the automations in the order stated — map outputs to inputs by name where one feeds the next; an empty map is allowed when nothing passes. Do not leave chain null.',
        });
      }
      // Independent automations are fine unchained — a chain is only for
      // hand-offs the person actually asked for.
      if (v.chain) {
        if (v.chain.links.length > 0 && v.chain.steps.length > 0) {
          ctx.addIssue({
            code: "custom",
            path: ["chain"],
            message: "Use links (a straight line) OR steps (branching) — never both.",
          });
        }
        if (v.chain.steps.length > 0) {
          const steps = v.chain.steps;
          if (steps.length > 8) {
            ctx.addIssue({
              code: "custom",
              path: ["chain", "steps"],
              message: "Branching chains cap at 8 steps.",
            });
          }
          const stepIds = new Set(steps.map((s) => s.id));
          if (stepIds.size !== steps.length) {
            ctx.addIssue({
              code: "custom",
              path: ["chain", "steps"],
              message: "Two steps share an id — give every step its own (s1, s2, …).",
            });
          }
          if (!steps.some((s) => s.after.length === 0)) {
            ctx.addIssue({
              code: "custom",
              path: ["chain", "steps"],
              message: "One step must have after: [] — the chain needs a first step.",
            });
          }
          steps.forEach((s, i) => {
            if (!names.has(s.automation)) {
              ctx.addIssue({
                code: "custom",
                path: ["chain", "steps", i, "automation"],
                message: `"${s.automation}" is not one of the drafted automation names.`,
              });
            }
            for (const dep of s.after) {
              if (!stepIds.has(dep)) {
                ctx.addIssue({
                  code: "custom",
                  path: ["chain", "steps", i, "after"],
                  message: `Step ${s.id} waits for "${dep}", which isn't a step id in this chain.`,
                });
              }
              if (dep === s.id) {
                ctx.addIssue({
                  code: "custom",
                  path: ["chain", "steps", i, "after"],
                  message: `Step ${s.id} can't wait for itself.`,
                });
              }
            }
            // Map pairs must reference REAL names — an output on the dep this
            // step draws from, an input on this step's own automation. A
            // misnamed output silently arrives empty at run time otherwise.
            const stepAuto = v.automations.find((a) => a.name === s.automation);
            const depStep = steps.find((x) => x.id === s.after[0]);
            const depAuto = depStep && v.automations.find((a) => a.name === depStep.automation);
            for (const pair of s.map) {
              if (depAuto && !depAuto.outputs.some((o) => o.name === pair.output)) {
                ctx.addIssue({
                  code: "custom",
                  path: ["chain", "steps", i, "map"],
                  message: `"${pair.output}" is not an output of "${depStep!.automation}" (step ${s.after[0]}).`,
                });
              }
              if (stepAuto && !stepAuto.inputs.some((inp) => inp.name === pair.input)) {
                ctx.addIssue({
                  code: "custom",
                  path: ["chain", "steps", i, "map"],
                  message: `"${pair.input}" is not an input of "${s.automation}".`,
                });
              }
            }
            if (s.after.length === 0 && (s.if_answer_contains || s.if_answer_lacks)) {
              ctx.addIssue({
                code: "custom",
                path: ["chain", "steps", i],
                message: "A first step has no earlier result to test — drop the if_answer condition or add after.",
              });
            }
          });
          // Kahn's on the draft shape — a circle is refused with names.
          const indeg = new Map(steps.map((s) => [s.id, s.after.filter((d) => stepIds.has(d)).length]));
          const queue = steps.filter((s) => (indeg.get(s.id) ?? 0) === 0).map((s) => s.id);
          let settled = 0;
          while (queue.length) {
            const id = queue.shift()!;
            settled++;
            for (const s of steps) {
              if (!s.after.includes(id)) continue;
              const d = (indeg.get(s.id) ?? 0) - 1;
              indeg.set(s.id, d);
              if (d === 0) queue.push(s.id);
            }
          }
          if (settled !== steps.length) {
            ctx.addIssue({
              code: "custom",
              path: ["chain", "steps"],
              message: "These steps circle back on each other — chains flow one way.",
            });
          }
        }
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
          // A link that carries nothing is usually the model inventing a
          // chain — EXCEPT when the person explicitly asked for one
          // ("run A then B as a sequence"): pure ordering is then the point.
          if (!catalog.chainIntent && l.map.length === 0 && l.onlyWhen === null) {
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
  // NOTE: an input NOT referenced by a {token} is intentionally allowed — a
  // chain-fed automation receives its inputs through the chain map by name
  // (the prompt's own receipts example does this). Flagging it as an error
  // permanently blocked every edit of such an automation, so it's dropped.
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
    tools?: string[];
    knowledge?: string[];
    delivers: string;
    schedule: unknown;
    effort: string;
  },
  catalog: Catalog,
  // The record BEFORE the patch. An edit is judged on what it changed — a
  // flaw the record already had (a {token} with no fill-in, say) must not
  // make every future edit of it fail with a complaint about something the
  // person didn't touch.
  before?: {
    name?: string;
    steps: string[];
    inputs: { name: string }[];
    sources: string[];
  }
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  // The record being edited is itself in automationNames — building the
  // schema from the unfiltered catalog would make every edit fail the new
  // "already exists" check. Filter out the record's OWN identity (its name
  // BEFORE the patch): filtering by the after-name would exempt exactly the
  // collision a rename-into-existing must hit.
  const ownName = (before?.name ?? record.name).trim().toLowerCase();
  const single = buildWireSchema({
    ...catalog,
    automationNames: catalog.automationNames.filter(
      (n) => n.trim().toLowerCase() !== ownName
    ),
  });
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
        tools: record.tools ?? [],
        knowledge: record.knowledge ?? [],
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
  // Only lint problems this edit INTRODUCED block it — anything the record
  // already had stays the record's problem, not this change's.
  const wasWrong = before
    ? new Set(
        lintAutomation({
          steps: before.steps,
          inputs: before.inputs.map((i) => ({ name: i.name })),
          sources: before.sources,
        })
      )
    : new Set<string>();
  issues.push(...lintAutomation(record).filter((issue) => !wasWrong.has(issue)));
  return { ok: issues.length === 0, issues };
}

export function wireJsonSchema(catalog: Catalog): Record<string, unknown> {
  // The same schema goes on the wire (format:) and into the prompt — grammar
  // guarantees shape, the prompt copy improves content.
  return z.toJSONSchema(buildWireSchema(catalog), {
    target: "draft-07",
  }) as Record<string, unknown>;
}
