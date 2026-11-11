/**
 * Per-tab toolbar badge: the tab's refresh state at a glance, with the exact
 * next refresh time in the tooltip.
 *
 * Deliberately not a live seconds countdown: that would need a timer keeping
 * the service worker awake permanently (FR-26: countdowns are derived from
 * timestamps in the UI, not from a running background process). The badge is
 * recomputed whenever the tab's runtime state changes; the popup shows the
 * live countdown.
 */
import { STATUS_LABELS, type TabRuntime } from "./types";

export interface TabBadge {
  text: string;
  color: string;
  title: string;
}

const RUNNING = new Set(["scheduled", "evaluating", "refreshing"]);

/** null = no tab-specific badge (the global badge, if any, shows instead). */
export function tabBadge(rt: TabRuntime | null, formatTime: (t: number) => string): TabBadge | null {
  if (!rt) return null;
  const label = STATUS_LABELS[rt.status];
  const why = rt.reason ? `: ${rt.reason}` : "";
  if (RUNNING.has(rt.status)) {
    const next = rt.nextDueAt ? ` · next refresh at ${formatTime(rt.nextDueAt)}` : "";
    return { text: "ON", color: "#16a34a", title: `JustRefresh: ${label}${next}` };
  }
  if (rt.status.startsWith("paused")) return { text: "II", color: "#d97706", title: `JustRefresh: ${label}${why}` };
  if (rt.status === "completed") return { text: "✓", color: "#2563eb", title: `JustRefresh: ${label}${why}` };
  if (rt.status === "error") return { text: "!", color: "#dc2626", title: `JustRefresh: ${label}${why}` };
  return null; // idle, excluded, stopped
}
