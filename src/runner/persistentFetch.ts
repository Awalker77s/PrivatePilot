// "Keep trying until you find it." A blocked source is a closed door, not a
// missing fact — so a run that meets one walks the ladder instead of coming
// back empty:
//
//   1. the SAME page in the real (offscreen) browser — a great deal of bot
//      protection is happy once a genuine browser asks;
//   2. a curated same-fact alternative (CoinGecko ↔ Coinbase, Nasdaq ↔
//      Yahoo, Google News ↔ HN/BBC) — see mirrors.ts for the two rules that
//      keep this from becoming "wander the web";
//   3. only then the designed sentence, which now says what was tried.
//
// A fence refusal, a bad URL, or a site that simply has no such page never
// enters the ladder — retrying those is noise.
import { fetchPage, hostnameOf, FetchOutcome } from "./fetchPage";
import { alternativesFor } from "./mirrors";

export interface PersistentOutcome extends FetchOutcome {
  // Hosts tried before this result, in order — the run log renders these so
  // a substituted number is never mysterious.
  attempts: string[];
  substituted: boolean;
}

export async function fetchPersistently(
  url: string,
  sources: string[],
  onNote?: (text: string) => void
): Promise<PersistentOutcome> {
  const firstHost = hostnameOf(url) ?? url;
  const attempts: string[] = [firstHost];
  const first = await fetchPage(url, sources);
  if (first.ok || !first.blocked) {
    return { ...first, attempts, substituted: false };
  }

  const tried: string[] = [`${firstHost} (${first.sentence ?? "blocked"})`];

  // 1 · the same page, through a real browser.
  onNote?.(`${firstHost} blocked the plain fetch — opening it in a browser instead…`);
  try {
    const { readRenderedPage } = await import("./renderPage");
    const rendered = await readRenderedPage(url, sources);
    if (rendered.ok) {
      return {
        ok: true,
        text: rendered.text,
        sentence: null,
        family: "ok",
        logLine: `${firstHost} refused a plain fetch, so I opened it in a real browser and read it there. ${rendered.logLine}`,
        attempts,
        substituted: false,
      };
    }
    tried.push(`${firstHost} in a browser (${rendered.sentence ?? "no luck"})`);
  } catch {
    tried.push(`${firstHost} in a browser (couldn't open it)`);
  }

  // 2 · the same fact from somewhere else.
  for (const alt of alternativesFor(url)) {
    attempts.push(alt.host);
    onNote?.(`Trying ${alt.host} instead — ${alt.why}…`);
    // The alternative is curated, not model-chosen: allow exactly that host.
    const out = await fetchPage(alt.url, [...sources, alt.host]);
    if (out.ok) {
      return {
        ok: true,
        text: out.text,
        sentence: null,
        family: "ok",
        logLine: `${firstHost} wouldn't answer (${first.sentence ?? "blocked"}), so I used ${alt.host} instead — ${alt.why}. ${out.logLine}`,
        attempts,
        substituted: true,
      };
    }
    tried.push(`${alt.host} (${out.sentence ?? "no luck"})`);
  }

  const sentence =
    tried.length > 1
      ? `Couldn't get this anywhere: ${tried.join("; ")}.`
      : (first.sentence ?? first.text);
  return {
    ok: false,
    text: sentence,
    sentence,
    family: first.family,
    logLine: sentence,
    blocked: true,
    attempts,
    substituted: false,
  };
}
