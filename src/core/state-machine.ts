/**
 * Per-tab execution state machine (FR-25).
 *
 *   idle → scheduled → evaluating ─┬─ matched → completed
 *                                  ├─ unsafe/unknown → paused_*
 *                                  ├─ failure → error (retry)
 *                                  └─ allowed → refreshing → scheduled
 *
 * The key invariant: `refreshing` can only be entered from `evaluating`, and
 * `evaluating` cannot be entered while a reload is in flight. Together with the
 * per-tab lock in the engine this prevents overlapping refresh attempts.
 */
import type { ExecutionStatus, TabRuntime } from "./types";

const PAUSED: ExecutionStatus[] = ["paused_activity", "paused_unsaved", "paused_resubmit", "paused_global", "paused_user", "paused_unknown"];
/** States reachable from anywhere (external control / resolution changes). */
const UNIVERSAL: ExecutionStatus[] = ["idle", "excluded", "stopped", "paused_global", "paused_user", "error"];

const TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
  idle: ["scheduled", "evaluating", ...PAUSED, "completed"],
  scheduled: ["scheduled", "evaluating", ...PAUSED, "completed"],
  evaluating: ["scheduled", "refreshing", "completed", ...PAUSED],
  refreshing: ["scheduled", "evaluating", "completed", ...PAUSED],
  paused_activity: ["scheduled", "evaluating", ...PAUSED],
  paused_unsaved: ["scheduled", "evaluating", ...PAUSED],
  paused_resubmit: ["scheduled", "evaluating", ...PAUSED],
  paused_global: ["scheduled", "evaluating", ...PAUSED],
  paused_user: ["scheduled", "evaluating", ...PAUSED],
  paused_unknown: ["scheduled", "evaluating", ...PAUSED, "completed"],
  excluded: ["scheduled"],
  completed: ["scheduled"],
  stopped: ["scheduled"],
  error: ["scheduled", "evaluating", ...PAUSED],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: ExecutionStatus,
    public readonly to: ExecutionStatus,
  ) {
    super(`Illegal state transition ${from} → ${to}`);
  }
}

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  if (UNIVERSAL.includes(to)) return true;
  return TRANSITIONS[from].includes(to);
}

export function transition(rt: TabRuntime, to: ExecutionStatus, patch: Partial<TabRuntime> = {}): TabRuntime {
  if (!canTransition(rt.status, to)) throw new IllegalTransitionError(rt.status, to);
  return { ...rt, ...patch, status: to };
}

export function isPaused(s: ExecutionStatus): boolean {
  return PAUSED.includes(s);
}

/** Terminal states do not advance without explicit user/rule action. */
export function isTerminal(s: ExecutionStatus): boolean {
  return s === "completed" || s === "stopped" || s === "excluded" || s === "idle";
}

export function newRuntime(tabId: number, url: string, now: number, generation = 0): TabRuntime {
  return {
    tabId,
    controllerId: null,
    controllerRevision: 0,
    status: "idle",
    url,
    generation,
    startedAt: now,
    nextDueAt: null,
    lastAttemptAt: null,
    lastNavigationAt: null,
    refreshCount: 0,
    navigationCount: 0,
    unknownStreak: 0,
    pendingReload: null,
    resumeAt: null,
    lastEvaluation: null,
    lastError: null,
  };
}
