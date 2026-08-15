// App configuration (not one of the three data stores): compile memory
// (ask once, remember forever), runtime-allowed folders, and later the
// Featherless opt-in. Written with the same atomic pattern.
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { atomicWriteJson } from "./atomic";

export interface AppSettings {
  aliases: Record<string, string>; // "which tracking sheet?" → "~/Documents/invoices-2026.xlsx"
  pickedFolders: string[]; // real paths the user allowed at pick time
  featherless: {
    enabled: boolean;
    key: string | null;
    model: string;
  };
  // Watcher state: crossings are latched (fire once, re-arm on cross-back).
  watchLatches?: Record<
    string,
    { lastValue: number | null; armed: boolean; askedAlreadyTrue: boolean }
  >;
  lastWatchTick?: Record<string, number>;
  // One-time multi-image sanity probe result, per model tag.
  visionProbe?: Record<string, boolean>;
  // Connected apps — which local senses the person has allowed. Absent
  // means off: nothing looks into an app until the person says so.
  apps?: {
    computerAllowed?: boolean; // read what open app windows show
    outlookClassicAllowed?: boolean; // read classic Outlook on this PC
    spotifyAllowed?: boolean; // what's playing / pause / skip on this PC
    // Gmail over IMAP: the address lives here; the app password is DPAPI-
    // sealed in secrets.json and never in settings.
    gmail?: { address: string; connectedAt: number } | null;
  };
}

const DEFAULTS: AppSettings = {
  aliases: {},
  pickedFolders: [],
  featherless: { enabled: false, key: null, model: "Qwen/Qwen3-32B" },
  apps: {},
};

let settings: AppSettings = { ...DEFAULTS };
let loaded = false;

async function settingsPath(): Promise<string> {
  return join(await appDataDir(), "settings.json");
}

export async function loadSettings(): Promise<AppSettings> {
  if (!loaded) {
    try {
      const p = await settingsPath();
      if (await exists(p)) {
        settings = { ...DEFAULTS, ...JSON.parse(await readTextFile(p)) };
      }
    } catch {
      settings = { ...DEFAULTS };
    }
    loaded = true;
  }
  return settings;
}

export function getSettings(): AppSettings {
  return settings;
}

export async function updateSettings(
  mutate: (s: AppSettings) => void
): Promise<void> {
  await loadSettings();
  mutate(settings);
  await atomicWriteJson(await settingsPath(), settings);
}
