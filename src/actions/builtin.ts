import { z } from "zod";
import type { ActionHandler } from "../registries/contracts";

export const refreshSchema = z.strictObject({
  type: z.literal("refresh"),
  bypassCache: z.boolean().optional(),
});
export const stopSchema = z.strictObject({
  type: z.literal("stopRefresh"),
  as: z.enum(["completed", "stopped"]).optional().describe("Final status (default: completed)"),
});
export const pauseSchema = z.strictObject({
  type: z.literal("pauseRefresh"),
  minutes: z.number().min(1).max(24 * 60).optional().describe("Auto-resume after this many minutes"),
});
export const resumeSchema = z.strictObject({ type: z.literal("resumeRefresh") });
export const notifySchema = z.strictObject({
  type: z.literal("notify"),
  title: z.string().max(100).optional(),
  message: z.string().max(300).optional(),
});
export const logSchema = z.strictObject({
  type: z.literal("log"),
  message: z.string().max(300).optional(),
  level: z.enum(["info", "warn"]).optional(),
});

export const refreshAction: ActionHandler<z.infer<typeof refreshSchema>> = {
  type: "refresh",
  title: "Refresh the tab",
  description: "Reloads the tab. Navigation completion is tracked separately.",
  schema: refreshSchema,
  permissions: [],
  disruptive: true,
  execute: async (c, ctx) => {
    await ctx.reload({ bypassCache: c.bypassCache === true });
    return { ok: true, reloaded: true };
  },
};

export const stopAction: ActionHandler<z.infer<typeof stopSchema>> = {
  type: "stopRefresh",
  title: "Stop refreshing",
  description: "Ends the run for this tab.",
  schema: stopSchema,
  permissions: [],
  disruptive: false,
  execute: async (c, ctx) => {
    ctx.setStatus(c.as ?? "completed", c.as === "stopped" ? "Stopped by rule action" : "Stop condition matched");
    return { ok: true, terminal: true };
  },
};

export const pauseAction: ActionHandler<z.infer<typeof pauseSchema>> = {
  type: "pauseRefresh",
  title: "Pause refreshing",
  description: "Pauses the run, optionally resuming automatically.",
  schema: pauseSchema,
  permissions: [],
  disruptive: false,
  execute: async (c, ctx) => {
    const resumeAt = c.minutes ? Date.now() + c.minutes * 60_000 : undefined;
    ctx.setStatus("paused_user", c.minutes ? `Paused by rule for ${c.minutes} min` : "Paused by rule", resumeAt);
    return { ok: true, terminal: true };
  },
};

export const resumeAction: ActionHandler<z.infer<typeof resumeSchema>> = {
  type: "resumeRefresh",
  title: "Resume refreshing",
  description: "Keeps the run scheduled (no-op if already running).",
  schema: resumeSchema,
  permissions: [],
  disruptive: false,
  execute: async (_c, ctx) => {
    ctx.setStatus("scheduled", "Resumed by rule");
    return { ok: true };
  },
};

export const notifyAction: ActionHandler<z.infer<typeof notifySchema>> = {
  type: "notify",
  title: "Notify me",
  description: "Shows a desktop notification.",
  schema: notifySchema,
  permissions: ["notifications"],
  disruptive: false,
  execute: async (c, ctx) => {
    await ctx.notify(c.title ?? `Rule matched: ${ctx.ruleName}`, c.message ?? ctx.url);
    return { ok: true };
  },
};

export const logAction: ActionHandler<z.infer<typeof logSchema>> = {
  type: "log",
  title: "Write to history",
  description: "Records a message in the execution history.",
  schema: logSchema,
  permissions: [],
  disruptive: false,
  execute: async (c, ctx) => {
    ctx.log(c.level ?? "info", c.message ?? "Rule action logged");
    return { ok: true };
  },
};
