import type { ExecutionStatus } from "../../core/types";
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
