import type { ExecutionStatus, TabRuntime } from "../../core/types";
import { STATUS_LABELS } from "../../core/types";

export function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

export function formatTime(t: number | null | undefined): string {
  if (!t) return "—";
  const d = new Date(t);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
}

export function statusLabel(s: ExecutionStatus | string): string {
  return STATUS_LABELS[s as ExecutionStatus] ?? s;
}

export function statusTone(s: string): "ok" | "warn" | "muted" | "error" | "done" {
  if (s === "scheduled" || s === "refreshing" || s === "evaluating") return "ok";
  if (s.startsWith("paused")) return "warn";
  if (s === "error") return "error";
  if (s === "completed") return "done";
  return "muted";
}

export function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Time left until the next refresh, and how much of the current wait (0–100) has passed. */
export function countdownOf(rt: TabRuntime | null, now: number, intervalSeconds: number) {
  if (!rt?.nextDueAt) return { countdown: null, progress: 0 };
  const countdown = Math.max(0, rt.nextDueAt - now);
  // The wait being counted down, from the last check (or the start) to the next one.
  // A randomized rule's wait can be far longer than its interval.
  const span = rt.nextDueAt - Math.max(rt.startedAt, rt.lastAttemptAt ?? 0);
  const total = span > 0 ? span : intervalSeconds * 1000;
  const progress = total ? Math.min(100, Math.max(0, 100 - (countdown / total) * 100)) : 0;
  return { countdown, progress };
}
