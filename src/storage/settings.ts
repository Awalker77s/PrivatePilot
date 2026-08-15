// App configuration (not one of the three data stores): compile memory
// (ask once, remember forever), runtime-allowed folders, and later the
// Featherless opt-in. Written with the same atomic pattern.
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { atomicWriteJson } from "./atomic";
import { isDesktopApp } from "../platform";

export interface AppSettings {
  aliases: Record<string, string>; // "which tracking sheet?" → "~/Documents/invoices-2026.xlsx"
  pickedFolders: string[]; // real paths the user allowed at pick time
  localModel: string | null; // null = prefer the documented local default
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
  permissions?: {
    fullAccess: boolean;
    // revisionId -> immutable content hash. A changed revision cannot reuse
    // an approval merely because its automation kept the same name or id.
    approvedRevisions: Record<string, { contentHash: string; approvedAt: number }>;
    approvedWorkflowRevisions: Record<
      string,
      { contentHash: string; approvedAt: number }
    >;
    approvedDirectories: string[];
  };
}

const DEFAULTS: AppSettings = {
  aliases: {},
  pickedFolders: [],
  localModel: null,
  featherless: { enabled: false, key: null, model: "Qwen/Qwen3-32B" },
  permissions: {
    fullAccess: false,
    approvedRevisions: {},
    approvedWorkflowRevisions: {},
    approvedDirectories: [],
  },
};

const BROWSER_SETTINGS_KEY = "private-pilot:settings";
let settings: AppSettings = isDesktopApp()
  ? mergeDefaults()
  : mergeDefaults({ localModel: "qwen3.5:4b" });
let loaded = false;

function mergeDefaults(raw?: Partial<AppSettings>): AppSettings {
  return {
    ...DEFAULTS,
    ...(raw ?? {}),
    featherless: {
      ...DEFAULTS.featherless,
      ...(raw?.featherless ?? {}),
    },
    permissions: {
      ...DEFAULTS.permissions!,
      ...(raw?.permissions ?? {}),
      approvedRevisions: {
        ...DEFAULTS.permissions!.approvedRevisions,
        ...(raw?.permissions?.approvedRevisions ?? {}),
      },
      approvedWorkflowRevisions: {
        ...DEFAULTS.permissions!.approvedWorkflowRevisions,
        ...(raw?.permissions?.approvedWorkflowRevisions ?? {}),
      },
      approvedDirectories: [
        ...(raw?.permissions?.approvedDirectories ?? []),
      ],
    },
  };
}

async function settingsPath(): Promise<string> {
  return join(await appDataDir(), "settings.json");
}

export async function loadSettings(): Promise<AppSettings> {
  if (!loaded) {
    try {
      if (!isDesktopApp()) {
        const saved = localStorage.getItem(BROWSER_SETTINGS_KEY);
        settings = saved
          ? mergeDefaults(JSON.parse(saved) as Partial<AppSettings>)
          : mergeDefaults({ localModel: "qwen3.5:4b" });
      } else {
        const p = await settingsPath();
        if (await exists(p)) {
          settings = mergeDefaults(
            JSON.parse(await readTextFile(p)) as Partial<AppSettings>
          );
        }
      }
    } catch {
      settings = isDesktopApp()
        ? mergeDefaults()
        : mergeDefaults({ localModel: "qwen3.5:4b" });
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
  if (isDesktopApp()) {
    await atomicWriteJson(await settingsPath(), settings);
  } else {
    localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(settings));
  }
}
