import { z } from "../core/zod";
import type { ConditionNode, EvaluationResult } from "../core/types";
import type { ConditionHandler } from "../registries/contracts";
import { schemaValidator } from "../registries/contracts";
import { diag } from "./helpers";

export const MAX_GROUP_SIZE = 20;

const node = z.looseObject({ type: z.string() }) as unknown as z.ZodMiniType<ConditionNode>;

export const allSchema = z.strictObject({
  type: z.literal("all"),
  conditions: z.array(node).check(z.minLength(1), z.maxLength(MAX_GROUP_SIZE)),
});
export const anySchema = z.strictObject({
  type: z.literal("any"),
  conditions: z.array(node).check(z.minLength(1), z.maxLength(MAX_GROUP_SIZE)),
});
export const notSchema = z.strictObject({
  type: z.literal("not"),
  condition: node,
});
export type AllGroup = z.infer<typeof allSchema>;
export type AnyGroup = z.infer<typeof anySchema>;
export type NotGroup = z.infer<typeof notSchema>;

/* Kleene three-valued logic. */
export function triAnd(results: EvaluationResult[]): EvaluationResult {
  const no = results.find((r) => r.status === "not_matched");
  if (no) return { status: "not_matched" };
  const unknown = results.find((r) => r.status === "unknown");
  if (unknown)
    return { status: "unknown", reason: unknown.status === "unknown" ? unknown.reason : "", code: unknown.status === "unknown" ? unknown.code : undefined };
  return { status: "matched" };
}

export function triOr(results: EvaluationResult[]): EvaluationResult {
  if (results.some((r) => r.status === "matched")) return { status: "matched" };
  const unknown = results.find((r) => r.status === "unknown");
  if (unknown && unknown.status === "unknown") return { status: "unknown", reason: unknown.reason, code: unknown.code };
  return { status: "not_matched" };
}

export function triNot(r: EvaluationResult): EvaluationResult {
  if (r.status === "matched") return { status: "not_matched" };
  if (r.status === "not_matched") return { status: "matched" };
  return r;
}

function groupCheck(children: unknown[], ctx: Parameters<NonNullable<ConditionHandler["check"]>>[1]) {
  return children.flatMap((c, i) => ctx.validateChild(c, `${ctx.path}.conditions[${i}]`));
}

export const allCondition: ConditionHandler<AllGroup> = {
  type: "all",
  title: "All of (AND)",
  description: "Matches when every child matches. Any not_matched → not_matched; otherwise any unknown → unknown.",
  context: "logical",
  schema: allSchema,
  permissions: [],
  check: (c, ctx) => groupCheck(c.conditions, ctx),
  validate: schemaValidator(allSchema),
  children: (c) => c.conditions,
  evaluate: async (c, ctx) => triAnd(await Promise.all(c.conditions.map((n) => ctx.evaluateChild(n)))),
};

export const anyCondition: ConditionHandler<AnyGroup> = {
  type: "any",
  title: "Any of (OR)",
  description: "Matches when at least one child matches. Otherwise any unknown → unknown.",
  context: "logical",
  schema: anySchema,
  permissions: [],
  check: (c, ctx) => groupCheck(c.conditions, ctx),
  validate: schemaValidator(anySchema),
  children: (c) => c.conditions,
  evaluate: async (c, ctx) => triOr(await Promise.all(c.conditions.map((n) => ctx.evaluateChild(n)))),
};

export const notCondition: ConditionHandler<NotGroup> = {
  type: "not",
  title: "Not",
  description: "Inverts matched/not_matched. unknown stays unknown.",
  context: "logical",
  schema: notSchema,
  permissions: [],
  check: (c, ctx) => {
    if (c.condition.type === "not") {
      return [diag(ctx.path, "double_negation", "Double negation can be simplified", "warning"), ...ctx.validateChild(c.condition, `${ctx.path}.condition`)];
    }
    return ctx.validateChild(c.condition, `${ctx.path}.condition`);
  },
  validate: schemaValidator(notSchema),
  children: (c) => [c.condition],
  evaluate: async (c, ctx) => triNot(await ctx.evaluateChild(c.condition)),
};
