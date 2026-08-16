// Machine-authored steps for deterministic file jobs. These markers are never
// sampled by the model: the quick compiler writes them and the runner parses
// them before starting an agentic tool loop.

const TOOL_PREFIX = "RUN_TOOL ";
const READ_ALL_PREFIX = "READ_ALL ";

export interface EncodedToolStep {
  tool: string;
  args: Record<string, unknown>;
}

export function encodeQuickToolStep(
  tool: string,
  args: Record<string, unknown>
): string {
  return `${TOOL_PREFIX}${tool} ${JSON.stringify(args)}`;
}

export function parseQuickToolStep(step: string): EncodedToolStep | null {
  if (!step.startsWith(TOOL_PREFIX)) return null;
  const rest = step.slice(TOOL_PREFIX.length);
  const split = rest.indexOf(" ");
  if (split < 1) return null;
  const tool = rest.slice(0, split).trim();
  if (!/^[a-z][a-z0-9_]*$/.test(tool)) return null;
  try {
    const args = JSON.parse(rest.slice(split + 1)) as unknown;
    if (!args || Array.isArray(args) || typeof args !== "object") return null;
    return { tool, args: args as Record<string, unknown> };
  } catch {
    return null;
  }
}

export function encodeQuickReadAll(target: string): string {
  return `${READ_ALL_PREFIX}${target}`;
}

export function parseQuickReadAll(step: string): string | null {
  if (!step.startsWith(READ_ALL_PREFIX)) return null;
  const target = step.slice(READ_ALL_PREFIX.length).trim();
  return target || null;
}
