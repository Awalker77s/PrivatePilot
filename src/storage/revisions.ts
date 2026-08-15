import type {
  AutomationRecord,
  AutomationRevisionMeta,
  ChainRecord,
  PermissionManifest,
  WorkflowRevisionMeta,
} from "./types";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function shortHash(value: unknown): string {
  const text = stableJson(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

export function workflowContentHash(workflow: ChainRecord): string {
  return shortHash({
    links: workflow.links,
    // A changed branch (condition, dependency, member) is a different
    // workflow — it must never inherit an old approval.
    steps: workflow.steps ?? [],
    components: workflow.components ?? [],
    permissions: workflow.permissions,
    timeoutMinutes: workflow.timeoutMinutes,
  });
}

function workflowRevisionId(
  workflow: ChainRecord,
  number: number,
  hash: string
): string {
  return `wrev-${workflow.id}-${number}-${hash}`;
}

export function normalizeWorkflow(
  workflow: ChainRecord,
  fallbackNumber = 1
): ChainRecord {
  const contentHash = workflowContentHash(workflow);
  const number = workflow.revision?.number ?? fallbackNumber;
  return {
    ...workflow,
    createdAt: workflow.createdAt ?? Date.now(),
    revision: workflow.revision
      ? { ...workflow.revision, contentHash }
      : {
          id: workflowRevisionId(workflow, number, contentHash),
          number,
          contentHash,
          status: "published",
          createdAt: workflow.createdAt ?? Date.now(),
        },
  };
}

export function publishWorkflowRevision(
  incoming: ChainRecord,
  previous?: ChainRecord
): ChainRecord {
  const normalized = normalizeWorkflow(
    incoming,
    previous?.revision?.number ?? 1
  );
  const old = previous ? normalizeWorkflow(previous) : undefined;
  const changed = !!old && workflowContentHash(old) !== workflowContentHash(normalized);
  const number = changed
    ? (old?.revision?.number ?? 0) + 1
    : (old?.revision?.number ?? normalized.revision?.number ?? 1);
  const contentHash = workflowContentHash(normalized);
  const revision: WorkflowRevisionMeta = {
    id:
      changed || !old
        ? workflowRevisionId(normalized, number, contentHash)
        : old.revision!.id,
    number,
    contentHash,
    status: "published",
    createdAt: changed || !old ? Date.now() : old.revision!.createdAt,
  };
  return { ...normalized, revision };
}

export function permissionManifestFor(
  record: Pick<AutomationRecord, "files" | "sources">
): PermissionManifest {
  const reads = [...new Set(record.files.reads)].sort();
  const writes = [...new Set(record.files.writes)].sort();
  return {
    filesystem: {
      mode: reads.length || writes.length ? "scoped" : "none",
      reads,
      writes,
    },
    network: { hosts: [...new Set(record.sources)].sort() },
    commands: [],
    applications: [],
    capabilities: [],
  };
}

export function automationContentHash(record: AutomationRecord): string {
  return shortHash({
    sentence: record.sentence,
    steps: record.steps,
    inputs: record.inputs,
    outputs: record.outputs,
    files: record.files,
    formats: record.formats,
    sources: record.sources,
    delivers: record.delivers,
    schedule: record.schedule,
    model: record.model,
    effort: record.effort,
    permissions: record.permissions ?? permissionManifestFor(record),
  });
}

function revisionId(record: AutomationRecord, number: number, hash: string) {
  return `rev-${record.id}-${number}-${hash}`;
}

export function draftRevisionFor(record: AutomationRecord): AutomationRevisionMeta {
  const contentHash = automationContentHash(record);
  const number = record.revision?.number ?? 1;
  return {
    id: revisionId(record, number, contentHash),
    number,
    contentHash,
    status: "draft",
    createdAt: Date.now(),
  };
}

export function normalizeAutomation(
  record: AutomationRecord,
  fallbackNumber = 1
): AutomationRecord {
  const permissions = record.permissions ?? permissionManifestFor(record);
  const withPermissions = { ...record, permissions };
  const contentHash = automationContentHash(withPermissions);
  const number = record.revision?.number ?? fallbackNumber;
  return {
    ...withPermissions,
    library: record.library ?? {
      description: record.sentence,
      tags: [],
      archivedAt: null,
    },
    revision: record.revision
      ? { ...record.revision, contentHash }
      : {
          id: revisionId(record, number, contentHash),
          number,
          contentHash,
          status: "published",
          createdAt: record.origin?.at ?? Date.now(),
        },
  };
}

export function publishRevision(
  incoming: AutomationRecord,
  previous?: AutomationRecord
): AutomationRecord {
  const normalized = normalizeAutomation(incoming, previous?.revision?.number ?? 1);
  const previousNormalized = previous ? normalizeAutomation(previous) : undefined;
  const changed =
    !!previousNormalized &&
    previousNormalized.revision?.contentHash !== normalized.revision?.contentHash;
  const number = changed
    ? (previousNormalized?.revision?.number ?? 0) + 1
    : (previousNormalized?.revision?.number ?? normalized.revision?.number ?? 1);
  const contentHash = normalized.revision!.contentHash;
  return {
    ...normalized,
    revision: {
      id: changed || !previousNormalized
        ? revisionId(normalized, number, contentHash)
        : previousNormalized.revision!.id,
      number,
      contentHash,
      status: "published",
      createdAt: changed || !previousNormalized
        ? Date.now()
        : previousNormalized.revision!.createdAt,
    },
  };
}

export function permissionSummary(record: AutomationRecord): string {
  const manifest = record.permissions ?? permissionManifestFor(record);
  return permissionManifestSummary(manifest);
}

export function permissionManifestSummary(manifest: PermissionManifest): string {
  const bits: string[] = [];
  const paths = new Set([
    ...manifest.filesystem.reads,
    ...manifest.filesystem.writes,
  ]);
  if (paths.size) bits.push(`${paths.size} file scope${paths.size === 1 ? "" : "s"}`);
  if (manifest.network.hosts.length)
    bits.push(`${manifest.network.hosts.length} website${manifest.network.hosts.length === 1 ? "" : "s"}`);
  if (manifest.commands.length)
    bits.push(`${manifest.commands.length} command${manifest.commands.length === 1 ? "" : "s"}`);
  if (manifest.applications.length)
    bits.push(`${manifest.applications.length} app${manifest.applications.length === 1 ? "" : "s"}`);
  return bits.join(" · ") || "No external access";
}

export function mergePermissionManifests(
  records: AutomationRecord[]
): PermissionManifest {
  const manifests = records.map(
    (record) => record.permissions ?? permissionManifestFor(record)
  );
  const reads = new Set(manifests.flatMap((manifest) => manifest.filesystem.reads));
  const writes = new Set(manifests.flatMap((manifest) => manifest.filesystem.writes));
  const full = manifests.some((manifest) => manifest.filesystem.mode === "full");
  return {
    filesystem: {
      mode: full ? "full" : reads.size || writes.size ? "scoped" : "none",
      reads: [...reads].sort(),
      writes: [...writes].sort(),
    },
    network: {
      hosts: [...new Set(manifests.flatMap((manifest) => manifest.network.hosts))].sort(),
    },
    commands: manifests.flatMap((manifest) => manifest.commands),
    applications: manifests.flatMap((manifest) => manifest.applications),
    capabilities: [...new Set(manifests.flatMap((manifest) => manifest.capabilities))].sort(),
  };
}
