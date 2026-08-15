import { isTauri } from "@tauri-apps/api/core";

// Some packaged WebView2 builds do not expose globalThis.isTauri even though
// the native invoke bridge is present. The bridge is the authoritative signal.
export function isDesktopApp(): boolean {
  return isTauri() || "__TAURI_INTERNALS__" in globalThis;
}
