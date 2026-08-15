// read_page: open the page in a real (offscreen, InPrivate) browser window,
// let its JavaScript finish, and read what a person would see. Text first;
// pixels + the local vision model only when text can't carry the answer.
// The fence governs where the automation may STEER — every off-fence
// navigation (including redirects) is cancelled and said out loud.
import { invoke } from "@tauri-apps/api/core";
import { fenceAllows, hostnameOf, FetchOutcome } from "./fetchPage";
import { visionReadPage } from "./visionRead";

const TEXT_CAP = 24_000;

interface RenderResult {
  text: string | null;
  png_b64: string | null;
  settled: boolean;
  fence_blocks: string[];
  final_url: string;
  settle_ms: number;
}

export interface RenderOutcome extends FetchOutcome {
  method: "text" | "vision" | null;
  settleMs: number;
  finalUrl: string | null;
}

const LOGIN_HINTS =
  /sign in to continue|log in to continue|please sign in|to continue to|enter your password|create an account to/i;
const CAPTCHA_HINTS =
  /verify you are human|unusual traffic|are you a robot|complete the captcha|press and hold/i;

export async function readRenderedPage(
  url: string,
  sources: string[]
): Promise<RenderOutcome> {
  const fail = (
    sentence: string,
    family: FetchOutcome["family"] = "on_purpose"
  ): RenderOutcome => ({
    ok: false,
    text: sentence,
    sentence,
    family,
    logLine: sentence,
    method: null,
    settleMs: 0,
    finalUrl: null,
  });

  if (/\s|%20/.test(url.trim())) {
    return fail(
      `That isn't a web address — read_page needs a full URL (got "${url.slice(0, 60)}").`
    );
  }
  const full = url.startsWith("http") ? url : `https://${url}`;
  const host = hostnameOf(full) ?? url;
  if (!fenceAllows(sources, full)) {
    return fail(
      `Refused — ${host} is not in this automation's sources. Nothing was opened.`
    );
  }

  let r: RenderResult;
  try {
    r = (await invoke("render_page", {
      url: full,
      sources,
      mode: "text",
      extraWaitMs: 0,
    })) as RenderResult;
  } catch (e) {
    const s = String(e);
    if (s.startsWith("Busy")) {
      return fail("Another page is being read right now — one at a time.", "on_purpose");
    }
    return fail(`${host} couldn't be opened — ${s.slice(0, 100)}`, "broke");
  }

  const text = (r.text ?? "").trim();
  const helpers = `Opened ${host} like a browser — pages pull in helpers from other sites; Private Pilot only ever steered inside this automation's sources.`;

  if (r.fence_blocks.length > 0 && text.length === 0) {
    const other = r.fence_blocks[0];
    return fail(
      `${host} sent the page on to ${other} — outside this automation's sources, so I closed it. Nothing read.`
    );
  }
  if (CAPTCHA_HINTS.test(text.slice(0, 4000))) {
    return fail(
      `${host} challenged the request with a puzzle meant for humans. I don't solve those.`
    );
  }
  if (LOGIN_HINTS.test(text.slice(0, 4000)) && text.length < 2500) {
    return fail(
      `${host} wants a sign-in before it will show this page. Private Pilot visits sites as a stranger — it never carries your logins. Pick a public source, or sign in yourself and read it there.`
    );
  }

  if (text.length >= 200) {
    const kept = text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text;
    const settleNote = r.settled
      ? `waited ${(r.settle_ms / 1000).toFixed(1)}s for the page to finish`
      : `${host} was still busy after ${(r.settle_ms / 1000).toFixed(0)}s — I read the page as it stood`;
    return {
      ok: true,
      text: kept,
      sentence: null,
      family: "ok",
      logLine: `Read ${host} like a browser (${settleNote}) — kept ${kept.length.toLocaleString()} characters of rendered text. ${helpers}`,
      method: "text",
      settleMs: r.settle_ms,
      finalUrl: r.final_url,
    };
  }

  // Text was blank or a shell — the vision rung: screenshot + local VLM.
  let shot: RenderResult;
  try {
    shot = (await invoke("render_page", {
      url: full,
      sources,
      mode: "screenshot",
      extraWaitMs: 1500,
    })) as RenderResult;
  } catch (e) {
    return fail(
      `${host} never finished drawing the page — there was nothing to read. (${String(e).slice(0, 60)})`,
      "broke"
    );
  }
  if (!shot.png_b64) {
    return fail(
      `${host} never finished drawing the page — there was nothing to read.`,
      "broke"
    );
  }
  const vision = await visionReadPage(shot.png_b64, host);
  if (!vision.ok) {
    return fail(vision.sentence, vision.family);
  }
  return {
    ok: true,
    text: vision.transcription,
    sentence: null,
    family: "ok",
    logLine: `Read a snapshot of ${host}'s rendered page with the local vision model (two reads agreed). ${helpers}`,
    method: "vision",
    settleMs: shot.settle_ms,
    finalUrl: shot.final_url,
  };
}
