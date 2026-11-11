import { z } from "zod";
import type { TriggerHandler } from "../registries/contracts";
import { diag } from "../conditions/helpers";

/** Chrome alarms are clamped to 30 s for packed extensions (Chrome 120+). */
export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 7 * 24 * 3600;

export const intervalSchema = z.strictObject({
  type: z.literal("interval"),
  seconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(MAX_INTERVAL_SECONDS),
  randomMaxSeconds: z
    .number()
    .int()
    .min(MIN_INTERVAL_SECONDS)
    .max(MAX_INTERVAL_SECONDS)
    .optional()
    .describe("If set, each interval is chosen uniformly in [seconds, randomMaxSeconds]"),
});
export type IntervalTrigger = z.infer<typeof intervalSchema>;

export function intervalDelayMs(c: IntervalTrigger, random: () => number): number {
  const lo = c.seconds;
  const hi = c.randomMaxSeconds && c.randomMaxSeconds > lo ? c.randomMaxSeconds : lo;
  return Math.round((lo + (hi - lo) * random()) * 1000);
}

export const intervalTrigger: TriggerHandler<IntervalTrigger> = {
  type: "interval",
  title: "Every interval",
  description: "Fires on a fixed (optionally randomized) interval using chrome.alarms. Minimum 30 seconds; timing is best-effort.",
  schema: intervalSchema,
  events: ["alarm"],
  allowsRefresh: true,
  nextDueAt: (c, now, random) => now + intervalDelayMs(c, random),
  check: (c, path) =>
    c.randomMaxSeconds !== undefined && c.randomMaxSeconds < c.seconds
      ? [diag(`${path}.randomMaxSeconds`, "range_invalid", "randomMaxSeconds must be >= seconds")]
      : [],
};
