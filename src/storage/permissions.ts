import type { AutomationRecord, ChainRecord } from "./types";
import { getSettings, updateSettings } from "./settings";
import { normalizeAutomation } from "./revisions";
import { normalizeWorkflow } from "./revisions";

export type PermissionAction =
  | { kind: "filesystem.read" | "filesystem.write"; path: string }
  | { kind: "network"; host: string }
  | { kind: "command"; executable: string; arguments: string[]; cwd: string }
  | { kind: "application"; applicationId: string; action: string }
  | { kind: "capability"; capability: string };

export type PermissionDecision = "allow" | "deny" | "prompt";

function pathInside(path: string, scope: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const normalizedScope = scope.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
}

// This is the single policy contract the future terminal/app executor calls
// before acting. "deny" means the action is outside the compiled manifest;
// "prompt" means it is declared but this revision has no persistent grant.
export function evaluateAction(
  record: AutomationRecord,
  action: PermissionAction
): PermissionDecision {
  const normalized = normalizeAutomation(record);
  const manifest = normalized.permissions!;
  let declared = false;
  switch (action.kind) {
    case "filesystem.read":
      declared =
        manifest.filesystem.mode === "full" ||
        manifest.filesystem.reads.some((scope) => pathInside(action.path, scope));
      break;
    case "filesystem.write":
      declared =
        manifest.filesystem.mode === "full" ||
        manifest.filesystem.writes.some((scope) => pathInside(action.path, scope));
      break;
    case "network":
      declared = manifest.network.hosts.some(
        (host) =>
          action.host.toLowerCase() === host.toLowerCase() ||
          action.host.toLowerCase().endsWith(`.${host.toLowerCase()}`)
      );
      break;
    case "command":
      declared = manifest.commands.some(
        (command) =>
          command.executable.toLowerCase() === action.executable.toLowerCase() &&
          command.arguments.length === action.arguments.length &&
          command.arguments.every((argument, index) => argument === action.arguments[index]) &&
          command.workingDirectories.some((scope) => pathInside(action.cwd, scope))
      );
      break;
    case "application":
      declared = manifest.applications.some(
        (application) =>
          application.applicationId === action.applicationId &&
          application.actions.includes(action.action)
      );
      break;
    case "capability":
      declared = manifest.capabilities.includes(action.capability);
      break;
  }
  if (!declared) return "deny";
  return isRevisionApproved(normalized) ? "allow" : "prompt";
}

function permissionSettings() {
  return (
    getSettings().permissions ?? {
      fullAccess: false,
      approvedRevisions: {},
      approvedWorkflowRevisions: {},
      approvedDirectories: [],
    }
  );
}

export function isRevisionApproved(record: AutomationRecord): boolean {
  const normalized = normalizeAutomation(record);
  const revision = normalized.revision!;
  const settings = permissionSettings();
  if (settings.fullAccess) return true;
  return settings.approvedRevisions[revision.id]?.contentHash === revision.contentHash;
}

export async function approveRevision(record: AutomationRecord): Promise<void> {
  const normalized = normalizeAutomation(record);
  const revision = normalized.revision!;
  await updateSettings((settings) => {
    settings.permissions ??= {
      fullAccess: false,
      approvedRevisions: {},
      approvedWorkflowRevisions: {},
      approvedDirectories: [],
    };
    settings.permissions.approvedRevisions[revision.id] = {
      contentHash: revision.contentHash,
      approvedAt: Date.now(),
    };
  });
}

export async function revokeRevision(record: AutomationRecord): Promise<void> {
  const revisionId = normalizeAutomation(record).revision!.id;
  await updateSettings((settings) => {
    if (settings.permissions) delete settings.permissions.approvedRevisions[revisionId];
  });
}

export async function setFullAccess(enabled: boolean): Promise<void> {
  await updateSettings((settings) => {
    settings.permissions ??= {
      fullAccess: false,
      approvedRevisions: {},
      approvedWorkflowRevisions: {},
      approvedDirectories: [],
    };
    settings.permissions.fullAccess = enabled;
  });
}

export async function revokeAllRevisionApprovals(): Promise<void> {
  await updateSettings((settings) => {
    if (settings.permissions) {
      settings.permissions.approvedRevisions = {};
      settings.permissions.approvedWorkflowRevisions = {};
    }
  });
}

export function isWorkflowApproved(workflow: ChainRecord): boolean {
  const normalized = normalizeWorkflow(workflow);
  const settings = permissionSettings();
  if (settings.fullAccess) return true;
  return (
    settings.approvedWorkflowRevisions?.[normalized.revision!.id]?.contentHash ===
    normalized.revision!.contentHash
  );
}

export async function approveWorkflowRevision(
  workflow: ChainRecord
): Promise<void> {
  const normalized = normalizeWorkflow(workflow);
  await updateSettings((settings) => {
    settings.permissions ??= {
      fullAccess: false,
      approvedRevisions: {},
      approvedWorkflowRevisions: {},
      approvedDirectories: [],
    };
    settings.permissions.approvedWorkflowRevisions ??= {};
    settings.permissions.approvedWorkflowRevisions[normalized.revision!.id] = {
      contentHash: normalized.revision!.contentHash,
      approvedAt: Date.now(),
    };
  });
}

export async function revokeWorkflowRevision(
  workflow: ChainRecord
): Promise<void> {
  const revisionId = normalizeWorkflow(workflow).revision!.id;
  await updateSettings((settings) => {
    if (settings.permissions?.approvedWorkflowRevisions)
      delete settings.permissions.approvedWorkflowRevisions[revisionId];
  });
}

export function permissionCounts(): {
  fullAccess: boolean;
  revisions: number;
  directories: number;
} {
  const settings = permissionSettings();
  return {
    fullAccess: settings.fullAccess,
    revisions:
      Object.keys(settings.approvedRevisions).length +
      Object.keys(settings.approvedWorkflowRevisions ?? {}).length,
    directories: new Set([
      ...settings.approvedDirectories,
      ...getSettings().pickedFolders,
    ]).size,
  };
}
