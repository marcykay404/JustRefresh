import { z } from "zod";
import type { TriggerHandler } from "../registries/contracts";

export const navigationSchema = z.strictObject({ type: z.literal("navigation") });
export const urlChangeSchema = z.strictObject({ type: z.literal("urlChange") });
export const startupSchema = z.strictObject({ type: z.literal("startup") });
export const manualSchema = z.strictObject({ type: z.literal("manual") });

export const navigationTrigger: TriggerHandler<z.infer<typeof navigationSchema>> = {
  type: "navigation",
  title: "Page load completed",
  description: "Evaluates when a page finishes loading. Cannot use the refresh action (it would loop).",
  schema: navigationSchema,
  events: ["navigation"],
  allowsRefresh: false,
};

export const urlChangeTrigger: TriggerHandler<z.infer<typeof urlChangeSchema>> = {
  type: "urlChange",
  title: "URL changed",
  description: "Evaluates when the tab URL changes (including in-page history changes).",
  schema: urlChangeSchema,
  events: ["urlChange"],
  allowsRefresh: false,
};

export const startupTrigger: TriggerHandler<z.infer<typeof startupSchema>> = {
  type: "startup",
  title: "Extension startup",
  description: "Evaluates once when the extension starts (browser launch or update).",
  schema: startupSchema,
  events: ["startup"],
  allowsRefresh: true,
};

export const manualTrigger: TriggerHandler<z.infer<typeof manualSchema>> = {
  type: "manual",
  title: "Manual only",
  description: "Runs only when executed explicitly (Run now).",
  schema: manualSchema,
  events: ["manual"],
  allowsRefresh: true,
};
