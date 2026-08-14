// Dev-only: expose internals on window so the build can be driven and
// verified over CDP against the real running app. Never ships — main.tsx
// imports this only under import.meta.env.DEV.
import { fetch as pluginFetch } from "@tauri-apps/plugin-http";
import * as providers from "./providers";
import * as ollama from "./providers/ollama";
import * as stores from "./storage/stores";
import * as atomic from "./storage/atomic";

declare global {
  interface Window {
    __pp?: Record<string, unknown>;
  }
}

export function installDevHook() {
  window.__pp = {
    pluginFetch,
    providers,
    ollama,
    stores,
    atomic,
  };
}
