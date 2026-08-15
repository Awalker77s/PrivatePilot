// A tiny inline sparkline for automations that deliver numbers — drawn from
// run history, never from anything a model said at render time.
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 56;
  const h = 14;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4) + 1).toFixed(1)}`
    )
    .join(" ");
  const up = values[values.length - 1] >= values[0];
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="sparkline"
      aria-hidden
    >
      <polyline
        points={pts}
        fill="none"
        stroke={up ? "var(--green)" : "var(--red)"}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.85"
      />
    </svg>
  );
}

// Pull the numeric series for an automation from its run records.
export function numberSeries(
  runs: { automationId: string; status: string; answer: string | null }[],
  automationId: string,
  cap = 10
): number[] {
  const out: number[] = [];
  for (const r of runs) {
    if (r.automationId !== automationId || r.status !== "ok" || !r.answer)
      continue;
    const m = r.answer.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (m) out.push(Number(m[0]));
  }
  return out.slice(-cap);
}
