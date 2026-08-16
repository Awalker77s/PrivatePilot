// One way to turn a list of automations into a sequence, used by every path
// that makes one: connecting saved automations by name in chat, and now the
// quick compile path when the request asks for a sequence of jobs that do
// not exist yet ("a sequence of the price of meta and the weather of
// orlando" — two new automations AND the line joining them, from one
// sentence).
//
// Links are sequential and carry any output whose name matches the next
// job's input. Most freshly-built pairs share nothing, and that is fine: an
// explicit sequence request is asking for ORDER, which a link with an empty
// map expresses exactly.
import { newId } from "../storage/stores";
import {
  mergePermissionManifests,
  normalizeAutomation,
} from "../storage/revisions";
import type {
  AutomationRecord,
  ChainLink,
  ChainRecord,
  ChainStep,
} from "../storage/types";

// The order of a sequence is the order the person said it. Templates match
// in their own order ("the solana price and the world news" can come back
// news-first), which would run the line backwards. Sort by where each job's
// own words first appear in the request; anything not found keeps its place.
export function orderByMention(
  records: AutomationRecord[],
  text: string
): AutomationRecord[] {
  const lower = text.toLowerCase();
  const GENERIC = new Set([
    "price", "prices", "check", "checker", "fetch", "news", "headlines",
    "weather", "stock", "rate", "rates", "watch", "watcher", "summary",
    "report", "note", "the", "and", "of", "a", "sequence", "chain",
  ]);
  const at = (record: AutomationRecord): number => {
    const words = record.name
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !GENERIC.has(w));
    const hits = words
      .map((w) => lower.indexOf(w))
      .filter((i) => i >= 0);
    return hits.length ? Math.min(...hits) : Number.MAX_SAFE_INTEGER;
  };
  return records
    .map((record, i) => ({ record, i, at: at(record) }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.record);
}

// Outputs of one job that match inputs of the next, by name. Both chain
// shapes carry the same map, so both build it the same way.
function mapBetween(
  from: AutomationRecord | undefined,
  to: AutomationRecord
): Record<string, string> {
  if (!from) return {};
  return Object.fromEntries(
    to.inputs
      .filter((input) => from.outputs.some((o) => o.name === input.name))
      .map((input) => [input.name, input.name])
  );
}

// The end of a sequence. In links form that is the job nothing leads away
// from; in steps form it is every step no other step waits on — plural when
// the workflow branched, which is why an appended step can need "any".
function tailOf(chain: ChainRecord): string[] {
  if (chain.steps?.length) {
    const waited = new Set(chain.steps.flatMap((s) => s.after));
    const ends = chain.steps.filter((s) => !waited.has(s.id)).map((s) => s.id);
    return ends.length ? ends : [chain.steps[chain.steps.length - 1].id];
  }
  const froms = new Set(chain.links.map((l) => l.from));
  const ends = chain.links.map((l) => l.to).filter((to) => !froms.has(to));
  return ends.length ? [ends[ends.length - 1]] : [];
}

// Grow a sequence that already exists, rather than rebuilding it from
// scratch. "also add the tesla check to that one" is how people actually
// extend a workflow, and rebuilding would drop the chain's history and its
// pinned member revisions. Returns null when there is nothing new to add.
export function appendToSequence(
  chain: ChainRecord,
  additions: AutomationRecord[],
  lookup: (id: string) => AutomationRecord | undefined
): ChainRecord | null {
  const present = new Set(
    chain.steps?.length
      ? chain.steps.map((s) => s.automationId)
      : chain.links.flatMap((l) => [l.from, l.to])
  );
  // A job already in the chain would be a second visit, which the dispatcher
  // rejects as a cycle. Silently skipping it is the honest read of "add X"
  // when X is already there.
  const fresh = additions
    .filter((a, i) => additions.findIndex((x) => x.id === a.id) === i)
    .filter((a) => !present.has(a.id))
    .map((a) => normalizeAutomation(a));
  if (!fresh.length) return null;

  const next: ChainRecord = {
    ...chain,
    links: [...chain.links],
    steps: chain.steps ? [...chain.steps] : undefined,
  };

  if (next.steps?.length) {
    let anchors = tailOf(chain);
    let previousId = anchors.length === 1 ? stepAutomationId(next.steps, anchors[0]) : undefined;
    let n = next.steps.length;
    for (const add of fresh) {
      const id = `s${++n}`;
      next.steps.push({
        id,
        automationId: add.id,
        after: anchors,
        // Joining several branch ends means "after whichever one ran".
        needs: anchors.length > 1 ? "any" : "all",
        when: "ran",
        ifAnswerContains: null,
        ifAnswerLacks: null,
        map: mapBetween(previousId ? lookup(previousId) : undefined, add),
      } satisfies ChainStep);
      anchors = [id];
      previousId = add.id;
    }
  } else {
    let previousId = tailOf(chain)[0];
    for (const add of fresh) {
      if (previousId) {
        next.links.push({
          from: previousId,
          to: add.id,
          map: mapBetween(lookup(previousId), add),
          onlyWhen: null,
        });
      }
      previousId = add.id;
    }
  }

  const members = [...present]
    .map((id) => lookup(id))
    .filter((m): m is AutomationRecord => Boolean(m))
    .map((m) => normalizeAutomation(m))
    .concat(fresh);
  next.components = members.map((m) => ({
    automationId: m.id,
    revisionId: m.revision!.id,
    revisionNumber: m.revision!.number,
  }));
  next.permissions = mergePermissionManifests(members);
  return next;
}

function stepAutomationId(steps: ChainStep[], stepId: string): string | undefined {
  return steps.find((s) => s.id === stepId)?.automationId;
}

export function sequenceFrom(
  members: AutomationRecord[],
  name?: string | null
): ChainRecord | null {
  // The same automation twice would be a cycle, and was never the ask.
  const unique = members.filter(
    (m, i) => members.findIndex((x) => x.id === m.id) === i
  );
  if (unique.length < 2) return null;
  const normalized = unique.map((m) => normalizeAutomation(m));
  const links: ChainLink[] = [];
  for (let i = 0; i < normalized.length - 1; i++) {
    const from = normalized[i];
    const to = normalized[i + 1];
    links.push({
      from: from.id,
      to: to.id,
      map: Object.fromEntries(
        to.inputs
          .filter((input) => from.outputs.some((o) => o.name === input.name))
          .map((input) => [input.name, input.name])
      ),
      onlyWhen: null,
    });
  }
  return {
    id: newId("chain"),
    name: name?.trim() || normalized.map((m) => m.name).join(" → "),
    links,
    timeoutMinutes: 30,
    createdAt: Date.now(),
    components: normalized.map((m) => ({
      automationId: m.id,
      revisionId: m.revision!.id,
      revisionNumber: m.revision!.number,
    })),
    permissions: mergePermissionManifests(normalized),
  };
}

// A two-job conditional, built in code: the check runs first, the consequence
// runs after it ONLY when the check's answer mentions the tested word. Uses
// steps rather than links because plain links run every member every time,
// which is precisely not what "if it found something" means.
export function conditionalSequenceFrom(
  check: AutomationRecord,
  then: AutomationRecord,
  contains: string,
  name?: string | null
): ChainRecord | null {
  if (!check || !then || check.id === then.id) return null;
  const a = normalizeAutomation(check);
  const b = normalizeAutomation(then);
  const steps: ChainStep[] = [
    {
      id: "s1",
      automationId: a.id,
      after: [],
      needs: "all",
      when: "ran",
      ifAnswerContains: null,
      ifAnswerLacks: null,
      map: {},
    },
    {
      id: "s2",
      automationId: b.id,
      after: ["s1"],
      needs: "all",
      when: "ran",
      ifAnswerContains: contains.trim() || null,
      ifAnswerLacks: null,
      map: mapBetween(a, b),
    },
  ];
  return {
    id: newId("chain"),
    name: name?.trim() || `${a.name} → ${b.name}`,
    links: [],
    steps,
    timeoutMinutes: 30,
    createdAt: Date.now(),
    components: [a, b].map((m) => ({
      automationId: m.id,
      revisionId: m.revision!.id,
      revisionNumber: m.revision!.number,
    })),
    permissions: mergePermissionManifests([a, b]),
  };
}
