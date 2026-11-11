import { z } from "../core/zod";
import type { ConditionHandler } from "../registries/contracts";
import { schemaValidator } from "../registries/contracts";

export const comparisonOperators = [">=", ">", "<=", "<", "==", "!="] as const;
export type ComparisonOperator = (typeof comparisonOperators)[number];

export function compareNumbers(a: number, op: ComparisonOperator, b: number): boolean {
  switch (op) {
    case ">=":
      return a >= b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    case "<":
      return a < b;
    case "==":
      return a === b;
    case "!=":
      return a !== b;
  }
}

export const refreshCountSchema = z.strictObject({
  type: z.literal("refreshCount"),
  operator: z.enum(comparisonOperators),
  value: z.int().check(z.gte(0), z.lte(1_000_000)),
});
export type RefreshCount = z.infer<typeof refreshCountSchema>;

export const refreshCount: ConditionHandler<RefreshCount> = {
  type: "refreshCount",
  title: "Refresh count",
  description: "Compares the number of refreshes performed by the current run.",
  context: "browser",
  schema: refreshCountSchema,
  permissions: [],
  validate: schemaValidator(refreshCountSchema),
  evaluate: async (c, ctx) =>
    compareNumbers(ctx.runtime.refreshCount, c.operator, c.value) ? { status: "matched" } : { status: "not_matched" },
};

export const tabStatusSchema = z.strictObject({
  type: z.literal("tab.status"),
  value: z.enum(["loading", "complete"]),
});
export type TabStatus = z.infer<typeof tabStatusSchema>;

export const tabStatus: ConditionHandler<TabStatus> = {
  type: "tab.status",
  title: "Tab status",
  description: "Matches the tab's loading status.",
  context: "browser",
  schema: tabStatusSchema,
  permissions: ["tabs"],
  validate: schemaValidator(tabStatusSchema),
  evaluate: async (c, ctx) => {
    if (!ctx.tab.status) return { status: "unknown", code: "tab_unavailable", reason: "Tab status unavailable" };
    return ctx.tab.status === c.value ? { status: "matched" } : { status: "not_matched" };
  },
};
