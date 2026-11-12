/** Small pure pieces of the engine: status for a resolution, run identity, labels. */
import type { Resolution } from "../rule-resolver";
import { transition } from "../state-machine";
import type { ExecutionStatus, Rule, TabInfo, TabRuntime } from "../types";

/**
 * This run's last check matched, so the agent behind the rule has heard
 * about it. A check from before the run started (it was restarted since)
 * doesn't count; one in the same millisecond as the start is the run's own
 * first check (a cycle that starts a run checks it at once).
 */
export const matchedInThisRun = (rt: TabRuntime) => rt.lastEvaluation?.status === "matched" && rt.lastEvaluation.at >= rt.startedAt;

/** Thrown by the refresh path when a refresh must not happen now; carries the state to move to. */
export class SafetyBlock extends Error {
  constructor(
    public readonly status: ExecutionStatus,
    public readonly reason: string,
    /** null = no timer: something else resumes the tab. */
    public readonly retryAt: number | null,
    /** Routine deferrals (e.g. the per-site rate limit) are not written to history. */
    public readonly quiet = false,
  ) {
    super(reason);
  }
}

/** A tab no rule controls (none, paused, excluded, restricted): the state it rests in. */
export function restingState(cur: TabRuntime, tab: TabInfo, res: Exclude<Resolution, { kind: "controller" }>): TabRuntime {
  if (res.kind === "paused" && !res.controller) {
    return transition(cur, "idle", { reason: "No rule applies to this tab", nextDueAt: null, controllerId: null, url: tab.url });
  }
  const status: ExecutionStatus = res.kind === "paused" ? "paused_global" : res.kind === "restricted" || res.kind.endsWith("excluded") ? "excluded" : "idle";
  return transition(cur, status, {
    reason: res.reason,
    nextDueAt: null,
    controllerId: res.kind === "paused" ? (res.controller?.id ?? null) : null,
    url: tab.url,
    pendingReload: status === "paused_global" ? cur.pendingReload : null,
  });
}

/**
 * Whether `rule` on this tab is a different run from `cur`: another
 * controller, another revision of it, or another page. On a form result an
 * address change may be the same page (a #hash or history.replaceState), so
 * the run is kept there: its time limit doesn't start over and it doesn't
 * notify again. Loading a real new page restarts it then (see leaveFormPause).
 */
export function isNewRun(cur: TabRuntime, tab: TabInfo, rule: Rule, ownNavigation = false): boolean {
  if (cur.controllerId !== rule.id || cur.controllerRevision !== rule.meta.revision) return true;
  return cur.url !== tab.url && !ownNavigation && !cur.pendingReload && cur.status !== "paused_resubmit";
}

/**
 * What decides a tab's run: which kind of resolution, which controller (and
 * its revision), from where, and why. Equal keys mean sync() has nothing to do.
 */
export function resolutionKey(r: Resolution): string {
  const c = r.kind === "controller" || r.kind === "paused" ? r.controller : null;
  return JSON.stringify([r.kind, c?.id ?? null, c?.meta.revision ?? null, r.kind === "controller" ? r.source : null, "reason" in r ? r.reason : null]);
}

const WAITING: Record<string, string> = {
  startup: "Runs again next time the browser starts",
  manual: "Runs when you run it",
  navigation: "Runs each time the page loads",
  urlChange: "Runs each time the address changes",
};

/** Status line for a rule that waits for its trigger (not a timer). */
export function waitingReason(rule: Rule): string {
  return Object.hasOwn(WAITING, rule.trigger.type) ? WAITING[rule.trigger.type]! : `Waiting for ${rule.trigger.type} trigger`;
}

export function withoutHash(url: string): string {
  return url.split("#")[0]!;
}

/** Host used for the per-site fast-refresh limit (null for non-web URLs). */
export function siteKey(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : null;
  } catch {
    return null;
  }
}

/** A check's memory for TabRuntime.memory: left out when empty, so most runs don't carry it. */
export const withMemory = (memory: Record<string, string>): { memory?: Record<string, string> } =>
  Object.keys(memory).length ? { memory } : { memory: undefined };
