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
import type { AutomationRecord, ChainLink, ChainRecord } from "../storage/types";

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
