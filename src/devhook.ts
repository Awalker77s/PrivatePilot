// Dev-only: expose internals on window so the build can be driven and
// verified over CDP against the real running app. Never ships — main.tsx
// imports this only under import.meta.env.DEV.
import { fetch as pluginFetch } from "@tauri-apps/plugin-http";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import * as providers from "./providers";
import * as ollama from "./providers/ollama";
import * as stores from "./storage/stores";
import * as atomic from "./storage/atomic";
import * as settings from "./storage/settings";
import * as catalog from "./pipeline/catalog";
import * as session from "./pipeline/session";
import * as chatStore from "./ui/chatStore";
import * as runner from "./runner/run";
import * as watchers from "./dispatcher/watchers";
import * as dispatcher from "./dispatcher";
import * as sandboxMod from "./runner/sandbox";
import * as diffMod from "./runner/diff";
import * as fetchMod from "./runner/fetchPage";
import * as renderMod from "./runner/renderPage";
import { invoke } from "@tauri-apps/api/core";
import * as connectors from "./connectors/registry";
import * as spotifyMod from "./connectors/spotify";
import * as computerMod from "./connectors/computer";
import * as outlookMod from "./connectors/outlook";
import * as gmailMod from "./connectors/gmail";
import * as heavyReg from "./heavy/registry";
import * as heavyRun from "./heavy/runTool";
import * as ragIndex from "./rag/index";
import * as ragAnswer from "./rag/answer";
import * as ragStore from "./rag/store";
import * as quickDraft from "./pipeline/quickDraft";

declare global {
  interface Window {
    __pp?: Record<string, unknown>;
  }
}

// Fixture path: the full Watch-me pipeline (frames → transcript → enrich →
// compile) with no human at the mic — real STT, real vision, real compile.
async function watchMeFixture(): Promise<void> {
  const narration = await (
    await fetch("/fixtures/watchme-narration.wav")
  ).blob();
  await chatStore.startWatchMe({
    frameUrls: [
      "/fixtures/frame1.png",
      "/fixtures/frame2.png",
      "/fixtures/frame3.png",
    ],
    narration,
  });
  await chatStore.stopWatchMe();
}

export function installDevHook() {
  window.__pp = {
    watchMeFixture,
    WebviewWindow,
    pluginFetch,
    providers,
    ollama,
    stores,
    atomic,
    settings,
    catalog,
    session,
    chatStore,
    runner,
    watchers,
    dispatcher,
    sandboxMod,
    diffMod,
    fetchMod,
    renderMod,
    invoke,
    connectors,
    spotifyMod,
    computerMod,
    outlookMod,
    gmailMod,
    heavyReg,
    heavyRun,
    ragIndex,
    ragAnswer,
    ragStore,
    quickDraft,
  };
}
