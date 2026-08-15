// Time and copy helpers — every string is derived from record fields.
export function relTime(at: number): string {
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return "yesterday";
  return `${Math.floor(s / 86400)}d ago`;
}

export function clockTime(at: number): string {
  const d = new Date(at);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function dayLabel(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (same(d, today)) return "Today";
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

// Schedules read as speech.
export function scheduleSentence(s: {
  trigger: string;
  hour?: number;
  everyMinutes?: number;
}): string {
  if (s.trigger === "daily") return `Every day at ${s.hour}:00`;
  if (s.trigger === "watch") return `Checks every ${s.everyMinutes} minutes`;
  return "When you run it";
}

export function nextRunSentence(s: {
  trigger: string;
  hour?: number;
}): string | null {
  if (s.trigger !== "daily" || s.hour === undefined) return null;
  const now = new Date();
  const next = new Date(now);
  next.setHours(s.hour, 0, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
    return `next: ${s.hour}:00 tomorrow`;
  }
  return `next: ${s.hour}:00`;
}

export function elapsedShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
