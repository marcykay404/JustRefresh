import { z } from "../core/zod";
import type { TriggerHandler } from "../registries/contracts";
import { diag } from "../conditions/helpers";

/** Standard minimum: Chrome alarms are clamped to 30 s (Chrome 120+). */
export const MIN_INTERVAL_SECONDS = 30;
/**
 * Hard floor for "fast intervals" (opt-in, Settings → Advanced). Below 30 s
 * the scheduler uses a service-worker timer with chrome.alarms as backstop.
 * Together with the per-site limit (FAST_SITE_SPACING_MS) this keeps the
 * extension from being usable to flood a site.
 */
export const FAST_MIN_INTERVAL_SECONDS = 5;
/** At most one fast automatic refresh per site (host) in this window, across all tabs. */
export const FAST_SITE_SPACING_MS = FAST_MIN_INTERVAL_SECONDS * 1000;
export const MAX_INTERVAL_SECONDS = 7 * 24 * 3600;

export const intervalSchema = z.strictObject({
  type: z.literal("interval"),
  seconds: z
    .int()
    .check(
      z.gte(FAST_MIN_INTERVAL_SECONDS),
      z.lte(MAX_INTERVAL_SECONDS),
      z.describe(`Seconds between refreshes: ≥${MIN_INTERVAL_SECONDS}, or ≥${FAST_MIN_INTERVAL_SECONDS} when fast intervals are enabled in Settings`),
    ),
  randomMaxSeconds: z
    .optional(z.int().check(z.gte(FAST_MIN_INTERVAL_SECONDS), z.lte(MAX_INTERVAL_SECONDS)))
    .check(z.describe("If set, each interval is chosen uniformly in [seconds, randomMaxSeconds]")),
});
export type IntervalTrigger = z.infer<typeof intervalSchema>;

const isFast = (c: IntervalTrigger) => c.seconds < MIN_INTERVAL_SECONDS || (c.randomMaxSeconds ?? MIN_INTERVAL_SECONDS) < MIN_INTERVAL_SECONDS;

/** The trigger as it runs while fast intervals are disabled: clamped to the standard minimum. */
export function clampToStandard(c: IntervalTrigger): IntervalTrigger {
  if (!isFast(c)) return c;
  return {
    ...c,
    seconds: Math.max(c.seconds, MIN_INTERVAL_SECONDS),
    ...(c.randomMaxSeconds !== undefined ? { randomMaxSeconds: Math.max(c.randomMaxSeconds, MIN_INTERVAL_SECONDS) } : {}),
  };
}

export function intervalDelayMs(c: IntervalTrigger, random: () => number): number {
  const lo = c.seconds;
  const hi = c.randomMaxSeconds && c.randomMaxSeconds > lo ? c.randomMaxSeconds : lo;
  return Math.round((lo + (hi - lo) * random()) * 1000);
}

export const intervalTrigger: TriggerHandler<IntervalTrigger> = {
  type: "interval",
  title: "Every interval",
  description: `Fires on a fixed (optionally randomized) interval. Minimum ${MIN_INTERVAL_SECONDS} seconds, or ${FAST_MIN_INTERVAL_SECONDS} seconds when the user enabled fast intervals in Settings; timing is best-effort.`,
  schema: intervalSchema,
  events: ["alarm"],
  allowsRefresh: true,
  nextDueAt: (c, now, random) => now + intervalDelayMs(c, random),
  check: (c, path, ctx) => {
    const out = [];
    if (c.randomMaxSeconds !== undefined && c.randomMaxSeconds < c.seconds) {
      out.push(diag(`${path}.randomMaxSeconds`, "range_invalid", "randomMaxSeconds must be >= seconds"));
    }
    // Policy check only when the caller states the setting (stored rules are kept and clamped instead).
    if (ctx?.allowFastIntervals === false && isFast(c)) {
      out.push(
        diag(
          `${path}.seconds`,
          "fast_intervals_disabled",
          `Intervals under ${MIN_INTERVAL_SECONDS} seconds are disabled. The user can enable them in Settings → Advanced (minimum ${FAST_MIN_INTERVAL_SECONDS} s).`,
        ),
      );
    }
    return out;
  },
};
