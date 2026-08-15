// The connector registry: which apps automations can look into, what tools
// each brings, and how the drafter and runner learn about them. Tools are
// BOUND PER RECORD — a run only sees the tools of the apps its record names
// (small models pick well from ≤10 tools and badly from 30).
import type { ToolDef } from "../providers/types";
import type { Connector, ConnectorId, ConnectorStatus, ToolSpec } from "./types";
import { computerConnector } from "./computer";
import { gmailConnector } from "./gmail";
import { outlookConnector } from "./outlook";
import { spotifyConnector } from "./spotify";

export const CONNECTORS: Connector[] = [outlookConnector, gmailConnector, spotifyConnector, computerConnector];
export const CONNECTOR_IDS = CONNECTORS.map((c) => c.id) as [ConnectorId, ...ConnectorId[]];

export function connectorById(id: string): Connector | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

export function toolsFor(apps: string[] | undefined): ToolSpec[] {
  const out: ToolSpec[] = [];
  for (const id of apps ?? []) {
    const c = connectorById(id);
    if (c) out.push(...c.tools);
  }
  return out;
}

export function toolDefsFor(apps: string[] | undefined): ToolDef[] {
  return toolsFor(apps).map((t) => t.def);
}

// Which connector owns a tool name — for the fence and the lint.
export function connectorOfTool(toolName: string): ConnectorId | null {
  for (const c of CONNECTORS) {
    if (c.tools.some((t) => t.def.function.name === toolName)) return c.id;
  }
  return null;
}

export function allConnectorToolNames(): string[] {
  return CONNECTORS.flatMap((c) => c.tools.map((t) => t.def.function.name));
}

export interface ConnectorSnapshot {
  id: ConnectorId;
  label: string;
  status: ConnectorStatus;
}

export async function connectorStatuses(): Promise<ConnectorSnapshot[]> {
  return Promise.all(
    CONNECTORS.map(async (c) => ({ id: c.id, label: c.label, status: await c.status() }))
  );
}

// The compact menu injected into the drafting prompt — one line per app,
// marked with live status so the model prefers what's actually usable.
export function connectorMenu(snap: ConnectorSnapshot[]): string {
  const lines = CONNECTORS.map((c) => {
    const s = snap.find((x) => x.id === c.id)?.status;
    const mark =
      s?.state === "ready"
        ? "ready"
        : s?.state === "needs_allow"
          ? "needs one Allow in Settings"
          : "not on this computer";
    return `- ${c.id} (${mark}): ${c.menuLine}`;
  });
  return lines.join("\n");
}
