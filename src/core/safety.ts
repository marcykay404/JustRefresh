/**
 * Activity / unsaved-change protection decisions (FR-05). Pure function so it
 * can be unit tested; the content script only supplies timing signals and
 * boolean dirty flags — never input values or keystrokes.
 */
import type { ActivitySnapshot } from "../shared/messaging-types";
import type { ExecutionStatus, SafetyConfig } from "./types";

/** Shown when a page came from submitting a form (see src/content/form-post.ts). */
export const FORM_RESULT_REASON =
  "This page came from submitting a form, so refreshing it could send the form again (for example a second order). Open the page fresh to keep refreshing";

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
  if (!(safety.pauseWhileTyping || safety.protectUnsavedChanges || safety.pauseOnMouse || safety.pauseOnScroll)) return ALLOWED;
  if (!activity) return pageNotObservable(input);
  return unsavedChanges(input, activity) ?? recentActivity(safety, activity) ?? ALLOWED;
}

const ALLOWED: SafetyDecision = { allowed: true };
type Blocked = Exclude<SafetyDecision, { allowed: true }>;

/** No activity signals (no site access, page not answering): the configured fail-safe. */
function pageNotObservable(input: SafetyInput): SafetyDecision {
  if (input.safety.onActivityUnavailable === "refresh") return ALLOWED;
  return {
    allowed: false,
    status: "paused_activity",
    reason: `Activity protection unavailable${input.unavailableReason ? `: ${input.unavailableReason}` : ""}`,
    retryInMs: input.fallbackRetryMs,
  };
}

function unsavedChanges(input: SafetyInput, activity: ActivitySnapshot): Blocked | null {
  if (!input.safety.protectUnsavedChanges || input.ignoreUnsaved || activity.dirty === "clean") return null;
  const reason = activity.dirty === "dirty" ? "A form on this page has unsaved changes" : "Possible unsaved changes (edited content)";
  return { allowed: false, status: "paused_unsaved", reason, retryInMs: input.fallbackRetryMs };
}

/** Typing, mouse or scrolling within the quiet time: wait until it has passed. */
function recentActivity(safety: SafetyConfig, activity: ActivitySnapshot): Blocked | null {
  const grace = safety.inactivityGraceSeconds * 1000;
  const block = (reason: string, retryInMs: number): Blocked => ({ allowed: false, status: "paused_activity", reason, retryInMs });
  const waitFor = (since: number) => Math.max(grace - since, 1000);
  const recent = (since: number | null): since is number => since !== null && since < grace;
  if (safety.pauseWhileTyping) {
    const typing = typingState(activity, grace);
    if (typing) return block(typing.reason, typing.retryInMs ?? waitFor(typing.since!));
  }
  if (safety.pauseOnMouse && recent(activity.sincePointerMs)) return block("Recent mouse activity", waitFor(activity.sincePointerMs));
  if (safety.pauseOnScroll && recent(activity.sinceScrollMs)) return block("Recent scrolling", waitFor(activity.sinceScrollMs));
  return null;
}

/** Why typing protection holds the refresh: an IME composition, monitoring that just started while editing, or recent keys. */
function typingState(activity: ActivitySnapshot, grace: number): { reason: string; since?: number; retryInMs?: number } | null {
  if (activity.composing) return { reason: "Text composition (IME) in progress", retryInMs: grace || 30_000 };
  // The monitor started recently: we cannot know whether the user typed before.
  if (activity.monitoringForMs < grace && activity.editing) return { reason: "Activity monitoring just started while editing", since: activity.monitoringForMs };
  const typing = [activity.sinceKeyMs, activity.sinceInputMs].filter((v): v is number => v !== null);
  const last = typing.length ? Math.min(...typing) : null;
  return last !== null && last < grace ? { reason: "Recent typing detected", since: last } : null;
}
