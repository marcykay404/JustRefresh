/**
 * Activity / unsaved-change protection decisions (FR-05). Pure function so it
 * can be unit tested; the content script only supplies timing signals and
 * boolean dirty flags — never input values or keystrokes.
 */
import type { ActivitySnapshot } from "../shared/messaging-types";
import type { ExecutionStatus, SafetyConfig } from "./types";

export type SafetyDecision =
  | { allowed: true }
  | { allowed: false; status: Extract<ExecutionStatus, "paused_activity" | "paused_unsaved">; reason: string; retryInMs: number };

export interface SafetyInput {
  safety: SafetyConfig;
  /** null = activity detection unavailable for this tab. */
  activity: ActivitySnapshot | null;
  unavailableReason?: string;
  ignoreUnsaved?: boolean;
  /** Fallback retry delay (normally the rule interval). */
  fallbackRetryMs: number;
}

export function decideSafety(input: SafetyInput): SafetyDecision {
  const { safety, activity } = input;
  const grace = safety.inactivityGraceSeconds * 1000;
  const anyProtection = safety.pauseWhileTyping || safety.protectUnsavedChanges || safety.pauseOnMouse || safety.pauseOnScroll;

  if (!anyProtection) return { allowed: true };

  if (!activity) {
    if (safety.onActivityUnavailable === "refresh") return { allowed: true };
    return {
      allowed: false,
      status: "paused_activity",
      reason: `Activity protection unavailable${input.unavailableReason ? `: ${input.unavailableReason}` : ""}`,
      retryInMs: input.fallbackRetryMs,
    };
  }

  if (safety.protectUnsavedChanges && !input.ignoreUnsaved) {
    if (activity.dirty === "dirty") {
      return { allowed: false, status: "paused_unsaved", reason: "A form on this page has unsaved changes", retryInMs: input.fallbackRetryMs };
    }
    if (activity.dirty === "unknown") {
      return { allowed: false, status: "paused_unsaved", reason: "Possible unsaved changes (edited content)", retryInMs: input.fallbackRetryMs };
    }
  }

  const recent = (since: number | null) => since !== null && since < grace;
  const waitFor = (since: number) => Math.max(grace - since, 1000);

  if (safety.pauseWhileTyping) {
    if (activity.composing) {
      return { allowed: false, status: "paused_activity", reason: "Text composition (IME) in progress", retryInMs: grace || 30_000 };
    }
    // The monitor started recently: we cannot know whether the user typed before.
    if (activity.monitoringForMs < grace && activity.editing) {
      return { allowed: false, status: "paused_activity", reason: "Activity monitoring just started while editing", retryInMs: waitFor(activity.monitoringForMs) };
    }
    const typing = [activity.sinceKeyMs, activity.sinceInputMs].filter((v): v is number => v !== null);
    const last = typing.length ? Math.min(...typing) : null;
    if (recent(last)) return { allowed: false, status: "paused_activity", reason: "Recent typing detected", retryInMs: waitFor(last!) };
  }
  if (safety.pauseOnMouse && recent(activity.sincePointerMs)) {
    return { allowed: false, status: "paused_activity", reason: "Recent mouse activity", retryInMs: waitFor(activity.sincePointerMs!) };
  }
  if (safety.pauseOnScroll && recent(activity.sinceScrollMs)) {
    return { allowed: false, status: "paused_activity", reason: "Recent scrolling", retryInMs: waitFor(activity.sinceScrollMs!) };
  }
  return { allowed: true };
}
