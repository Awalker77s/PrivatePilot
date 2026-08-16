import { useMemo, useState } from "react";
import {
  deleteChain,
  getAutomationRevision,
  getState,
  newId,
  restoreWorkflowVersion,
  saveChain,
  workflowVersions,
} from "../storage/stores";
import { useStoreVersion } from "../storage/useStore";
import type {
  AutomationRecord,
  ChainCondition,
  ChainLink,
  ChainRecord,
} from "../storage/types";
import {
  approveWorkflowRevision,
  isRevisionApproved,
  isWorkflowApproved,
  revokeWorkflowRevision,
} from "../storage/permissions";
import {
  mergePermissionManifests,
  normalizeAutomation,
  normalizeWorkflow,
  permissionManifestSummary,
  permissionSummary,
} from "../storage/revisions";
import { CategoryGlyph } from "./glyphs";
import { ArrowRightIcon, LinkIcon, PlusIcon, SearchIcon } from "./icons";
import {
  addAutomationReference,
  openAutomationStudio,
} from "./chatStore";
import { chainOrder } from "../dispatcher";
import { getSettings } from "../storage/settings";

export const AUTOMATION_DRAG_TYPE = "application/x-private-pilot-automation";

export function LibraryPanel() {
  const storeVersion = useStoreVersion();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [kind, setKind] = useState<"all" | "automations" | "sequences">("all");
  const [building, setBuilding] = useState(false);
  const [sequence, setSequence] = useState<string[]>([]);
  const [sequenceName, setSequenceName] = useState("");
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [componentRevisions, setComponentRevisions] = useState<
    Record<string, string>
  >({});
  const [conditions, setConditions] = useState<
    Record<string, ChainCondition | null>
  >({});
  const [savedLine, setSavedLine] = useState<string | null>(null);
  // A branching workflow can't be opened in the linear sequence editor — this
  // banner says why, shown in the list (not the editor pane).
  const [blockNote, setBlockNote] = useState<string | null>(null);
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | null>(null);
  const [, refreshPermissions] = useState(0);
  const { automations, chains } = getState();

  const records = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return automations.records
      .map((record) => normalizeAutomation(record))
      .filter((record) => !record.library?.archivedAt)
      .filter((record) => {
        if (!needle) return true;
        return [
          record.name,
          record.sentence,
          record.category,
          ...(record.library?.tags ?? []),
          ...record.inputs.map((input) => input.name),
          ...record.outputs.map((output) => output.name),
          ...record.sources,
        ].some((value) => value.toLowerCase().includes(needle));
      });
  }, [automations.records, query, storeVersion]);
  const filteredChains = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return chains.records.filter((chain) => {
      if (!needle) return true;
      const memberNames = (chain.components ?? [])
        .map((component) =>
          automations.records.find((record) => record.id === component.automationId)?.name
        )
        .filter((name): name is string => !!name);
      return [chain.name, ...memberNames].some((value) =>
        value.toLowerCase().includes(needle)
      );
    });
  }, [automations.records, chains.records, query, storeVersion]);

  function addToSequence(id: string) {
    setSequence((current) =>
      current.includes(id) || current.length >= 8 ? current : [...current, id]
    );
    setSavedLine(null);
    const record = automations.records.find((candidate) => candidate.id === id);
    if (record) {
      const normalized = normalizeAutomation(record);
      setComponentRevisions((current) => ({
        ...current,
        [id]: normalized.revision!.id,
      }));
    }
  }

  function selectedOutput(
    from: AutomationRecord,
    to: AutomationRecord,
    inputName: string
  ): string {
    const key = `${from.id}->${to.id}:${inputName}`;
    if (key in mappings) return mappings[key];
    return from.outputs.some((output) => output.name === inputName)
      ? inputName
      : "";
  }

  function moveSequence(index: number, delta: number) {
    setSequence((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function beginEditWorkflow(workflow: ChainRecord) {
    // The sequence editor is linear — it has no notion of branches. Opening a
    // steps (branching) chain here and re-publishing would silently flatten it
    // into an unconditional chain where every branch runs. Refuse, and point
    // to where it CAN be edited: talking to it in chat.
    if (workflow.steps?.length) {
      setBlockNote(
        `"${workflow.name}" branches on results, so it can't be edited in this linear editor. Open it from the chat and tell it what to change.`
      );
      return;
    }
    setBlockNote(null);
    const normalized = normalizeWorkflow(workflow);
    const ids = normalized.components?.map((component) => component.automationId) ??
      chainOrder(normalized);
    const nextMappings: Record<string, string> = {};
    const nextConditions: Record<string, ChainCondition | null> = {};
    for (const link of normalized.links) {
      nextConditions[`${link.from}->${link.to}`] = link.onlyWhen;
      for (const [output, input] of Object.entries(link.map)) {
        nextMappings[`${link.from}->${link.to}:${input}`] = output;
      }
    }
    setSequence(ids);
    setComponentRevisions(
      Object.fromEntries(
        (normalized.components ?? []).map((component) => [
          component.automationId,
          component.revisionId,
        ])
      )
    );
    setMappings(nextMappings);
    setConditions(nextConditions);
    setSequenceName(normalized.name);
    setEditingWorkflowId(normalized.id);
    setSavedLine(null);
    setBuilding(true);
  }

  function clearSequenceEditor() {
    setSequence([]);
    setMappings({});
    setConditions({});
    setComponentRevisions({});
    setSequenceName("");
    setEditingWorkflowId(null);
    setSavedLine(null);
  }

  const sequenceMembers = sequence
    .map((id) => {
      const revisionId = componentRevisions[id];
      return (
        (revisionId ? getAutomationRevision(id, revisionId) : undefined) ??
        automations.records.find((record) => record.id === id)
      );
    })
    .filter((record): record is AutomationRecord => !!record)
    .map((record) => normalizeAutomation(record));
  const unresolvedInputs = sequenceMembers.flatMap((to, index) => {
    if (index === 0) return [];
    const from = sequenceMembers[index - 1];
    return to.inputs
      .filter((input) => !selectedOutput(from, to, input.name))
      .map((input) => `${to.name}: ${input.label}`);
  });

  // A numeric-op threshold is held as raw text while editing — coerce it to a
  // number at save. A non-numeric value (NaN, empty, a stray "-") drops the
  // condition to null rather than persisting a broken threshold.
  function coerceCondition(c: ChainCondition | null): ChainCondition | null {
    if (!c) return null;
    if (c.op === "now_contains" || c.op === "changed_at_all") return c;
    const num = Number(c.value);
    if (!Number.isFinite(num)) return null;
    return { ...c, value: num };
  }

  async function saveSequence() {
    if (sequence.length < 2) return;
    const members = sequenceMembers;
    const links: ChainLink[] = [];
    for (let index = 0; index < members.length - 1; index++) {
      const from = members[index];
      const to = members[index + 1];
      links.push({
        from: from.id,
        to: to.id,
        map: Object.fromEntries(
          to.inputs
            .map((input) => [selectedOutput(from, to, input.name), input.name])
            .filter(([output]) => !!output)
        ),
        onlyWhen: coerceCondition(conditions[`${from.id}->${to.id}`] ?? null),
      });
    }
    const name = sequenceName.trim() || members.map((member) => member.name).join(" → ");
    const previous = editingWorkflowId
      ? chains.records.find((chain) => chain.id === editingWorkflowId)
      : undefined;
    await saveChain({
      id: previous?.id ?? newId("chain"),
      name,
      links,
      timeoutMinutes: 30,
      createdAt: previous?.createdAt ?? Date.now(),
      components: members.map((member) => ({
        automationId: member.id,
        revisionId: member.revision!.id,
        revisionNumber: member.revision!.number,
      })),
      permissions: mergePermissionManifests(members),
    });
    setSavedLine(
      previous ? `Published a new revision of “${name}”.` : `Saved “${name}” to the Library.`
    );
    setSequence([]);
    setSequenceName("");
    setMappings({});
    setConditions({});
    setComponentRevisions({});
    setEditingWorkflowId(null);
  }

  return (
    <aside
      className={`library-panel${collapsed ? " collapsed" : ""}`}
      data-testid="library-panel"
    >
      <div className="library-heading">
        {!collapsed && (
          <>
            <div>
              <div className="library-title">Library</div>
              <div className="caption">Saved building blocks</div>
            </div>
            <button
              className={`btn btn-sm ${building ? "btn-primary" : "btn-ghost"}`}
              onClick={() => {
                if (building) clearSequenceEditor();
                setBuilding((value) => !value);
              }}
              data-testid="sequence-toggle"
            >
              <LinkIcon size={12} /> Sequence
            </button>
          </>
        )}
        <button
          className="library-collapse"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? "Open Library" : "Collapse Library"}
        >
          {collapsed ? "L" : "›"}
        </button>
      </div>

      {!collapsed && (
        <>
      <div className="library-search searchbox">
        <SearchIcon size={13} />
        <input
          placeholder="Search automations"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="library-filters">
        {(["all", "automations", "sequences"] as const).map((value) => (
          <button
            key={value}
            className={`chip ${kind === value ? "chip-green" : "chip-gray"}`}
            onClick={() => setKind(value)}
          >
            {value === "all" ? "All" : value === "automations" ? "Automations" : "Sequences"}
          </button>
        ))}
      </div>

      {building && (
        <div className="sequence-builder card" data-testid="sequence-builder">
          <div className="settings-card-title">
            {editingWorkflowId ? "Edit sequence" : "New sequence"}
            {editingWorkflowId && (
              <button
                className="btn btn-sm btn-danger"
                onClick={async () => {
                  const workflow = chains.records.find(
                    (chain) => chain.id === editingWorkflowId
                  );
                  if (
                    workflow &&
                    window.confirm(`Delete “${workflow.name}”? The component automations stay in your Library.`)
                  ) {
                    await deleteChain(workflow.id);
                    clearSequenceEditor();
                    setBuilding(false);
                  }
                }}
              >
                Delete
              </button>
            )}
          </div>
          <input
            className="sequence-name"
            placeholder="Sequence name"
            value={sequenceName}
            onChange={(event) => setSequenceName(event.target.value)}
          />
          <div className="sequence-lane">
            {sequence.length === 0 && (
              <div className="caption">Add two or more automations below.</div>
            )}
            {sequence.map((id, index) => {
              const record = sequenceMembers[index];
              if (!record) return null;
              const current = automations.records.find((item) => item.id === id);
              const previous = index > 0 ? sequenceMembers[index - 1] : null;
              const updateAvailable =
                !!current && current.revision?.id !== record.revision?.id;
              return (
                <div className="sequence-step" key={id}>
                  <div className="sequence-node">
                    {index > 0 && <ArrowRightIcon size={12} />}
                    <span>
                      {record.name} · v{record.revision?.number ?? 1}
                    </span>
                    {updateAvailable && current?.revision && (
                      <button
                        className="sequence-upgrade"
                        title={`Use current revision ${current.revision.number}`}
                        onClick={() =>
                          setComponentRevisions((revisions) => ({
                            ...revisions,
                            [id]: current.revision!.id,
                          }))
                        }
                      >
                        Update to v{current.revision.number}
                      </button>
                    )}
                    <button
                      className="sequence-remove"
                      disabled={index === 0}
                      title="Move earlier"
                      onClick={() => moveSequence(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      className="sequence-remove"
                      disabled={index === sequence.length - 1}
                      title="Move later"
                      onClick={() => moveSequence(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      className="sequence-remove"
                      title={`Remove ${record.name}`}
                      onClick={() => setSequence((items) => items.filter((item) => item !== id))}
                    >
                      ×
                    </button>
                  </div>
                  {previous && record.inputs.length > 0 && (
                    <div className="sequence-mappings">
                      {record.inputs.map((input) => {
                        const key = `${previous.id}->${record.id}:${input.name}`;
                        return (
                          <label key={input.name}>
                            <span>{input.label}</span>
                            <select
                              value={selectedOutput(previous, record, input.name)}
                              onChange={(event) =>
                                setMappings((current) => ({
                                  ...current,
                                  [key]: event.target.value,
                                }))
                              }
                            >
                              <option value="">Choose an output…</option>
                              {previous.outputs.map((output) => (
                                <option key={output.name} value={output.name}>
                                  {previous.name}.{output.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {previous && (
                    <div className="sequence-condition">
                      <span>Run when</span>
                      <select
                        value={
                          conditions[`${previous.id}->${record.id}`]?.op ?? "always"
                        }
                        disabled={previous.outputs.length === 0}
                        onChange={(event) => {
                          const key = `${previous.id}->${record.id}`;
                          const op = event.target.value;
                          setConditions((currentConditions) => ({
                            ...currentConditions,
                            [key]:
                              op === "always"
                                ? null
                                : {
                                    field: previous.outputs[0]?.name ?? "",
                                    op: op as ChainCondition["op"],
                                    value:
                                      op === "changed_at_all"
                                        ? null
                                        : op === "now_contains"
                                          ? ""
                                          : 0,
                                  },
                          }));
                        }}
                      >
                        <option value="always">Always</option>
                        <option value="changed_at_all">Output changed</option>
                        <option value="now_contains">Output contains</option>
                        <option value="crosses_above">Output is above</option>
                        <option value="crosses_below">Output is below</option>
                        <option value="moves_more_than_pct">Output moves by %</option>
                      </select>
                      {conditions[`${previous.id}->${record.id}`] && (
                        <>
                          <select
                            value={conditions[`${previous.id}->${record.id}`]!.field}
                            onChange={(event) => {
                              const key = `${previous.id}->${record.id}`;
                              setConditions((currentConditions) => ({
                                ...currentConditions,
                                [key]: currentConditions[key]
                                  ? {
                                      ...currentConditions[key]!,
                                      field: event.target.value,
                                    }
                                  : null,
                              }));
                            }}
                          >
                            {previous.outputs.map((output) => (
                              <option key={output.name} value={output.name}>
                                {output.name}
                              </option>
                            ))}
                          </select>
                          {conditions[`${previous.id}->${record.id}`]!.op !==
                            "changed_at_all" && (
                            <input
                              inputMode={
                                conditions[`${previous.id}->${record.id}`]!.op ===
                                "now_contains"
                                  ? "text"
                                  : "decimal"
                              }
                              value={
                                conditions[`${previous.id}->${record.id}`]!.value ?? ""
                              }
                              placeholder="Value"
                              onChange={(event) => {
                                const key = `${previous.id}->${record.id}`;
                                const condition = conditions[key]!;
                                // Keep the RAW text while typing so "-", "0.",
                                // and "-0.5" survive; numeric ops are coerced
                                // to a number (or dropped if not one) at save.
                                setConditions((currentConditions) => ({
                                  ...currentConditions,
                                  [key]: { ...condition, value: event.target.value },
                                }));
                              }}
                            />
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {unresolvedInputs.length > 0 && (
            <div className="status-line" style={{ color: "var(--amber)" }}>
              Map {unresolvedInputs.join(" · ")} before saving.
            </div>
          )}
          <button
            className="btn btn-primary btn-sm"
            disabled={sequence.length < 2 || unresolvedInputs.length > 0}
            onClick={saveSequence}
          >
            {editingWorkflowId ? "Publish update" : "Save sequence"}
          </button>
          {editingWorkflowId && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                clearSequenceEditor();
                setBuilding(false);
              }}
            >
              Cancel
            </button>
          )}
          {editingWorkflowId && workflowVersions(editingWorkflowId).length > 0 && (
            <details className="sequence-history">
              <summary>
                {workflowVersions(editingWorkflowId).length} earlier revision{workflowVersions(editingWorkflowId).length === 1 ? "" : "s"}
              </summary>
              {workflowVersions(editingWorkflowId).slice(0, 5).map((version) => (
                <button
                  className="btn btn-sm btn-ghost"
                  key={version.revision?.id}
                  onClick={async () => {
                    if (
                      await restoreWorkflowVersion(
                        editingWorkflowId,
                        version.revision?.id
                      )
                    ) {
                      const restored = getState().chains.records.find(
                        (workflow) => workflow.id === editingWorkflowId
                      );
                      if (restored) beginEditWorkflow(restored);
                    }
                  }}
                >
                  Put back v{version.revision?.number ?? "?"}
                </button>
              ))}
            </details>
          )}
          {savedLine && <div className="caption">{savedLine}</div>}
        </div>
      )}

      {blockNote && (
        <div className="note-card note-amber" style={{ margin: "0 0 8px" }}>
          {blockNote}
        </div>
      )}
      <div className="library-list">
        {kind !== "sequences" &&
          records.map((record) => (
            <div
              className="library-item"
              key={record.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(AUTOMATION_DRAG_TYPE, record.id);
                event.dataTransfer.effectAllowed = "copy";
              }}
              data-testid="library-automation"
            >
              <CategoryGlyph category={record.category} size={24} />
              <button
                className="library-item-main"
                onClick={() => openAutomationStudio(record.id)}
                title={record.sentence}
              >
                <span className="library-item-name">{record.name}</span>
                <span className="caption">
                  v{record.revision!.number} · {permissionSummary(record)}
                </span>
              </button>
              <span
                className={`dot ${isRevisionApproved(record) ? "dot-green" : "dot-gray"}`}
                title={isRevisionApproved(record) ? "Approved" : "Asks when needed"}
              />
              {building ? (
                <button
                  className="library-add"
                  disabled={sequence.includes(record.id)}
                  onClick={() => addToSequence(record.id)}
                  title="Add to sequence"
                >
                  <PlusIcon size={12} />
                </button>
              ) : (
                <button
                  className="library-add"
                  onClick={() => addAutomationReference(record.id)}
                  title="Reference in chat"
                >
                  @
                </button>
              )}
            </div>
          ))}

        {kind !== "automations" &&
          filteredChains.map((chain) => {
            const normalized = normalizeWorkflow(chain);
            const approved = isWorkflowApproved(normalized);
            const fullAccess = getSettings().permissions?.fullAccess ?? false;
            return (
            <div
              className="library-item library-workflow"
              key={chain.id}
            >
              <span className="workflow-glyph"><LinkIcon size={13} /></span>
              <button
                className="library-item-main"
                onClick={() => beginEditWorkflow(normalized)}
                title={(normalized.components ?? [])
                  .map((component) => {
                    const member = automations.records.find(
                      (record) => record.id === component.automationId
                    );
                    return `${member?.name ?? component.automationId} v${component.revisionNumber}`;
                  })
                  .join(" → ")}
              >
                <span className="library-item-name">{normalized.name}</span>
                <span className="caption">
                  v{normalized.revision!.number} · {normalized.components?.length ?? normalized.links.length + 1} pinned steps
                  {normalized.permissions ? ` · ${permissionManifestSummary(normalized.permissions)}` : ""}
                </span>
              </button>
              <button
                className="library-add"
                disabled={fullAccess}
                title={
                  fullAccess
                    ? "Covered by full access"
                    : approved
                      ? "Revoke sequence approval"
                      : "Approve this sequence revision"
                }
                onClick={async () => {
                  if (approved) await revokeWorkflowRevision(normalized);
                  else await approveWorkflowRevision(normalized);
                  refreshPermissions((value) => value + 1);
                }}
              >
                <span className={`dot ${approved ? "dot-green" : "dot-gray"}`} />
              </button>
            </div>
          );})}

        {records.length === 0 && filteredChains.length === 0 && (
          <div className="library-empty caption">
            Saved automations and sequences will appear here.
          </div>
        )}
      </div>
        </>
      )}
    </aside>
  );
}
