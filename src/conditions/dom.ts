import { z } from "../core/zod";
import type { ConditionHandler } from "../registries/contracts";
import { schemaValidator } from "../registries/contracts";
import { checkRegexSafety } from "../core/url-pattern";
import { checkSelector, diag } from "./helpers";

export const textOperators = ["contains", "not_contains", "equals", "not_equals", "starts_with", "ends_with", "matches"] as const;
export const attributeOperators = ["exists", "missing", "equals", "not_equals", "contains", "matches"] as const;

const selector = z.string().check(z.minLength(1), z.maxLength(500), z.describe("CSS selector evaluated in the top-level document"));

export const domExistsSchema = z.strictObject({
  type: z.literal("dom.exists"),
  selector,
  minCount: z.optional(z.int().check(z.gte(1), z.lte(10_000))).check(z.describe("Minimum number of matching elements (default 1)")),
});
export const domMissingSchema = z.strictObject({
  type: z.literal("dom.missing"),
  selector,
});
export const domTextSchema = z.strictObject({
  type: z.literal("dom.text"),
  selector: z.optional(selector).check(z.describe("CSS selector; first match is compared. Defaults to body")),
  operator: z.enum(textOperators),
  value: z.string().check(z.maxLength(1000)),
  caseSensitive: z.optional(z.boolean()),
});
export const domAttributeSchema = z.strictObject({
  type: z.literal("dom.attribute"),
  selector,
  attribute: z.string().check(z.minLength(1), z.maxLength(100)),
  operator: z.enum(attributeOperators),
  value: z.optional(z.string().check(z.maxLength(1000))),
});

export type DomExists = z.infer<typeof domExistsSchema>;
export type DomMissing = z.infer<typeof domMissingSchema>;
export type DomText = z.infer<typeof domTextSchema>;
export type DomAttribute = z.infer<typeof domAttributeSchema>;

/** Page conditions are evaluated in a batched round-trip to the content script. */
const pageEvaluate: ConditionHandler["evaluate"] = async (config, ctx) => ctx.pageResult(config);

export const domExists: ConditionHandler<DomExists> = {
  type: "dom.exists",
  title: "Element exists",
  description: "Matches when the selector matches at least `minCount` elements.",
  context: "page",
  schema: domExistsSchema,
  permissions: ["host"],
  check: (c, ctx) => checkSelector(c.selector, `${ctx.path}.selector`),
  validate: schemaValidator(domExistsSchema),
  evaluate: pageEvaluate,
};

export const domMissing: ConditionHandler<DomMissing> = {
  type: "dom.missing",
  title: "Element missing",
  description: "Matches when no element matches the selector.",
  context: "page",
  schema: domMissingSchema,
  permissions: ["host"],
  check: (c, ctx) => checkSelector(c.selector, `${ctx.path}.selector`),
  validate: schemaValidator(domMissingSchema),
  evaluate: pageEvaluate,
};

export const domText: ConditionHandler<DomText> = {
  type: "dom.text",
  title: "Element text",
  description: "Compares the visible text of the first matching element (whitespace-normalized).",
  context: "page",
  schema: domTextSchema,
  permissions: ["host"],
  check: (c, ctx) => {
    const out = c.selector !== undefined ? checkSelector(c.selector, `${ctx.path}.selector`) : [];
    if (c.operator === "matches") {
      const problem = checkRegexSafety(c.value);
      if (problem) out.push(diag(`${ctx.path}.value`, "regex_unsafe", problem));
    }
    return out;
  },
  validate: schemaValidator(domTextSchema),
  evaluate: pageEvaluate,
};

export const domAttribute: ConditionHandler<DomAttribute> = {
  type: "dom.attribute",
  title: "Element attribute",
  description: "Compares an attribute of the first matching element.",
  context: "page",
  schema: domAttributeSchema,
  permissions: ["host"],
  check: (c, ctx) => {
    const out = checkSelector(c.selector, `${ctx.path}.selector`);
    const needsValue = c.operator !== "exists" && c.operator !== "missing";
    if (needsValue && c.value === undefined) out.push(diag(`${ctx.path}.value`, "value_required", `Operator "${c.operator}" requires a value`));
    if (c.operator === "matches" && c.value !== undefined) {
      const problem = checkRegexSafety(c.value);
      if (problem) out.push(diag(`${ctx.path}.value`, "regex_unsafe", problem));
    }
    return out;
  },
  validate: schemaValidator(domAttributeSchema),
  evaluate: pageEvaluate,
};
