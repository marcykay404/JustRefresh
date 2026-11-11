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

export function inActiveWindow(w: ActiveWindow | undefined, now: number): boolean {
  if (!w) return true;
  const d = new Date(now);
  if (w.days && w.days.length && !w.days.includes(d.getDay())) {
    // When the window wraps midnight, early hours belong to the previous day.
    if (!(w.startTime && w.endTime && minutesOf(w.endTime) < minutesOf(w.startTime))) return false;
  }
  if (!w.startTime || !w.endTime) return true;
  const cur = d.getHours() * 60 + d.getMinutes();
  const s = minutesOf(w.startTime);
  const e = minutesOf(w.endTime);
  if (s === e) return true;
  if (s < e) return cur >= s && cur < e;
  // Wraps midnight.
  if (cur >= s) return !w.days?.length || w.days.includes(d.getDay());
  if (cur < e) {
    const prev = (d.getDay() + 6) % 7;
    return !w.days?.length || w.days.includes(prev);
  }
  return false;
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
