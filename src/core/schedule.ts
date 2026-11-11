/** Scheduling calculations: active windows, limits, and storm avoidance. */
import type { ActiveWindow, LimitsConfig, TabRuntime } from "./types";

/** Chrome clamps alarms to >= 30 s for packed extensions. */
export const MIN_ALARM_DELAY_MS = 30_000;
/** Spacing between first runs when many tabs are (re)scheduled together. */
export const STAGGER_MS = 2_000;

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Whether the window covers `day` (0 = Sunday); no days listed means every day. */
const onDay = (w: ActiveWindow, day: number) => !w.days?.length || w.days.includes(day);

/** The window's hours wrap midnight (e.g. 22:00–06:00). */
const wrapsMidnight = (w: ActiveWindow) => !!(w.startTime && w.endTime) && minutesOf(w.endTime!) < minutesOf(w.startTime!);

/** Whether minute-of-day `cur` falls in start–end on `day`. */
function inHours(w: ActiveWindow, start: number, end: number, cur: number, day: number): boolean {
  if (start === end) return true;
  if (start < end) return cur >= start && cur < end;
  // Wraps midnight: the late part belongs to today, the early part to the previous day.
  if (cur >= start) return onDay(w, day);
  return cur < end && onDay(w, (day + 6) % 7);
}

export function inActiveWindow(w: ActiveWindow | undefined, now: number): boolean {
  if (!w) return true;
  const d = new Date(now);
  // When the window wraps midnight, early hours belong to the previous day.
  if (!onDay(w, d.getDay()) && !wrapsMidnight(w)) return false;
  if (!w.startTime || !w.endTime) return true;
  return inHours(w, minutesOf(w.startTime), minutesOf(w.endTime), d.getHours() * 60 + d.getMinutes(), d.getDay());
}

/** Next moment (minute resolution, within 8 days) when the window opens. */
export function nextWindowStart(w: ActiveWindow | undefined, now: number): number | null {
  if (!w || inActiveWindow(w, now)) return now;
  const step = 60_000;
  const start = Math.ceil(now / step) * step;
  for (let t = start; t < now + 8 * 24 * 3600_000; t += step) {
    if (inActiveWindow(w, t)) return t;
  }
  return null;
}

export type LimitOutcome = { reached: false } | { reached: true; reason: string };

/** When a time-based limit ends the run (null = none): lets a paused tab still stop on time. */
export function limitDeadline(limits: LimitsConfig, rt: Pick<TabRuntime, "startedAt">): number | null {
  const times = [
    limits.maxDurationSeconds !== undefined ? rt.startedAt + limits.maxDurationSeconds * 1000 : null,
    limits.stopAt !== undefined ? Date.parse(limits.stopAt) : null,
  ].filter((t): t is number => t !== null && Number.isFinite(t));
  return times.length ? Math.min(...times) : null;
}

export function checkLimits(limits: LimitsConfig, rt: Pick<TabRuntime, "refreshCount" | "startedAt">, now: number): LimitOutcome {
  if (limits.maxRefreshes !== undefined && rt.refreshCount >= limits.maxRefreshes) {
    return { reached: true, reason: `Reached maximum of ${limits.maxRefreshes} refreshes` };
  }
  if (limits.maxDurationSeconds !== undefined && now - rt.startedAt >= limits.maxDurationSeconds * 1000) {
    const m = Math.round(limits.maxDurationSeconds / 60);
    const label = m >= 60 && m % 60 === 0 ? (m === 60 ? "1 hour" : `${m / 60} hours`) : `${m} min`;
    return { reached: true, reason: `Reached its time limit (${label})` };
  }
  if (limits.stopAt !== undefined && now >= Date.parse(limits.stopAt)) {
    return { reached: true, reason: `Stop time ${limits.stopAt} reached` };
  }
  return { reached: false };
}

/**
 * Due time for a schedule that is being restored (startup, wake, resume).
 * Overdue schedules are not fired all at once: each gets a staggered slot.
 */
export function restoredDueAt(persistedDueAt: number | null, intervalDueAt: number, now: number, slot: number): number {
  const base = persistedDueAt !== null && persistedDueAt > now + MIN_ALARM_DELAY_MS ? persistedDueAt : null;
  if (base !== null) return base;
  const earliest = now + MIN_ALARM_DELAY_MS + slot * STAGGER_MS;
  return persistedDueAt === null ? Math.max(intervalDueAt, earliest) : earliest;
}
