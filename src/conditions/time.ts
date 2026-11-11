import { z } from "zod";
import type { ConditionHandler } from "../registries/contracts";
import { schemaValidator } from "../registries/contracts";
import { diag } from "./helpers";

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

const atSchema = z
  .string()
  .min(1)
  .max(40)
  .describe('ISO-8601 timestamp (e.g. "2026-12-01T09:00:00Z") or local time of day "HH:MM"');

export const timeAfterSchema = z.strictObject({ type: z.literal("time.after"), at: atSchema });
export const timeBeforeSchema = z.strictObject({ type: z.literal("time.before"), at: atSchema });
export type TimeAfter = z.infer<typeof timeAfterSchema>;
export type TimeBefore = z.infer<typeof timeBeforeSchema>;

/** Resolve `at` into an absolute threshold relative to `now` (local time). */
export function resolveThreshold(at: string, now: number): number | null {
  if (TIME_OF_DAY.test(at)) {
    const [h, m] = at.split(":").map(Number);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

function checkAt(at: string, path: string) {
  return resolveThreshold(at, Date.now()) === null
    ? [diag(`${path}.at`, "time_invalid", `"${at}" is neither an ISO timestamp nor HH:MM`)]
    : [];
}

export const timeAfter: ConditionHandler<TimeAfter> = {
  type: "time.after",
  title: "Time is after",
  description: "Matches once the current time is at or past the threshold (HH:MM is evaluated for the current local day).",
  context: "browser",
  schema: timeAfterSchema,
  permissions: [],
  check: (c, ctx) => checkAt(c.at, ctx.path),
  validate: schemaValidator(timeAfterSchema),
  evaluate: async (c, ctx) => {
    const t = resolveThreshold(c.at, ctx.now);
    if (t === null) return { status: "unknown", code: "evaluation_error", reason: "Invalid time" };
    return ctx.now >= t ? { status: "matched" } : { status: "not_matched" };
  },
};

export const timeBefore: ConditionHandler<TimeBefore> = {
  type: "time.before",
  title: "Time is before",
  description: "Matches while the current time is before the threshold.",
  context: "browser",
  schema: timeBeforeSchema,
  permissions: [],
  check: (c, ctx) => checkAt(c.at, ctx.path),
  validate: schemaValidator(timeBeforeSchema),
  evaluate: async (c, ctx) => {
    const t = resolveThreshold(c.at, ctx.now);
    if (t === null) return { status: "unknown", code: "evaluation_error", reason: "Invalid time" };
    return ctx.now < t ? { status: "matched" } : { status: "not_matched" };
  },
};
