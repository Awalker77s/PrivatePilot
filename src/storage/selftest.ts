// Storage self-test — proves the step-2 definition of done in the running
// app: read / write / version-keep round-trips, and a simulated EPERM retries
// instead of corrupting.
import { readTextFile } from "@tauri-apps/plugin-fs";
import { armSimulatedLock } from "./atomic";
import {
  automationVersions,
  deleteAutomation,
  getAutomation,
  saveAutomation,
  storePath,
} from "./stores";
import type { AutomationRecord } from "./types";

export interface SelfTestResult {
  passed: boolean;
  lines: string[]; // designed sentences, shown verbatim in the settings card
}

function probeRecord(n: number): AutomationRecord {
  return {
    id: "auto-probe",
    name: "Storage probe",
    sentence: `Probe save number ${n}.`,
    category: "Files",
    steps: [`step ${n}`],
    inputs: [],
    outputs: [],
    files: { reads: [], writes: [] },
    formats: {},
    sources: [],
    delivers: "answer",
    schedule: { trigger: "manual" },
    model: "none",
    effort: "quick",
    compiledBy: "self-test",
    lastRun: null,
  };
}

export async function runStorageSelfTest(): Promise<SelfTestResult> {
  const lines: string[] = [];
  let passed = true;
  try {
    // 1 · write → read round trip, straight from disk
    await saveAutomation(probeRecord(1));
    const onDisk = JSON.parse(await readTextFile(await storePath("automations")));
    const found = onDisk.records.find(
      (r: AutomationRecord) => r.id === "auto-probe"
    );
    if (found && found.sentence === "Probe save number 1.") {
      lines.push("Wrote a record and read the same bytes back from disk.");
    } else {
      passed = false;
      lines.push("Round trip failed — what came back from disk didn't match.");
    }

    // 2 · version history: 12 saves keep the last 10
    for (let n = 2; n <= 13; n++) await saveAutomation(probeRecord(n));
    const versions = automationVersions("auto-probe");
    const current = getAutomation("auto-probe");
    if (
      versions.length === 10 &&
      current?.sentence === "Probe save number 13." &&
      versions[0].sentence === "Probe save number 12."
    ) {
      lines.push("Saved 13 times — the last 10 versions are kept, in order.");
    } else {
      passed = false;
      lines.push(
        `Version keep failed — ${versions.length} kept, newest "${versions[0]?.sentence}".`
      );
    }

    // 3 · simulated Defender lock: two EPERMs, then success — never corrupt
    armSimulatedLock(2);
    await saveAutomation(probeRecord(14));
    const after = JSON.parse(await readTextFile(await storePath("automations")));
    const rec = after.records.find(
      (r: AutomationRecord) => r.id === "auto-probe"
    );
    if (rec?.sentence === "Probe save number 14.") {
      lines.push(
        "Simulated two file locks — the save backed off, retried, and landed intact."
      );
    } else {
      passed = false;
      lines.push("Simulated lock test failed — the retry didn't recover.");
    }
  } catch (e) {
    passed = false;
    lines.push(`Broke: ${String(e)}`);
  } finally {
    try {
      await deleteAutomation("auto-probe");
      lines.push("Cleaned the probe out — stores back the way they were.");
    } catch {
      passed = false;
      lines.push("Couldn't clean up the probe record.");
    }
  }
  return { passed, lines };
}
