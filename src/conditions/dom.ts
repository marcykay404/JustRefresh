import { z } from "../core/zod";
import type { ConditionHandler } from "../registries/contracts";
import { schemaValidator } from "../registries/contracts";
import { checkRegexSafety } from "../core/url-pattern";
import { checkSelector, diag } from "./helpers";
import type { EvaluationResult } from "../core/types";

export const textOperators = ["contains", "not_contains", "equals", "not_equals", "starts_with", "ends_with", "matches"] as const;
export const attributeOperators = ["exists", "missing", "equals", "not_equals", "contains", "matches"] as const;

const selector = z.string().check(z.minLength(1), z.maxLength(500), z.describe("CSS selector, looked up in the page, then in its frames from the same site"));

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

export const domChangedSchema = z.strictObject({
  type: z.literal("dom.changed"),
  selector: z.optional(selector).check(z.describe("CSS selector; the first match's text is watched. Defaults to the whole page (body)")),
});
export const domTextLostSchema = z.strictObject({
  type: z.literal("dom.text_lost"),
  selector: z.optional(selector).check(z.describe("CSS selector; first match is checked. Defaults to body")),
  value: z.string().check(z.minLength(1), z.maxLength(1000)),
  caseSensitive: z.optional(z.boolean()),
});

export type DomExists = z.infer<typeof domExistsSchema>;
export type DomMissing = z.infer<typeof domMissingSchema>;
export type DomText = z.infer<typeof domTextSchema>;
export type DomAttribute = z.infer<typeof domAttributeSchema>;
export type DomChanged = z.infer<typeof domChangedSchema>;
export type DomTextLost = z.infer<typeof domTextLostSchema>;

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
    const out = optionalSelector(c, ctx.path);
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

const optionalSelector = (c: { selector?: string }, path: string) => (c.selector !== undefined ? checkSelector(c.selector, `${path}.selector`) : []);

const NOT_COMPARED = "Not compared this time: the page has just loaded, or the tab is on another page";

/** The page's result without what only the engine needs. */
function forOthers(r: EvaluationResult, status: "matched" | "not_matched", note: string): EvaluationResult {
  const { fingerprint: _f, ...details } = r.status === "unknown" ? {} : (r.details ?? {});
  return { status, details: { ...details, note } };
}

/**
 * Stateful: compares a fingerprint of the element's text with the one seen
 * at the previous check of this run. The first check only remembers it; an
 * element that isn't there changes nothing (a page that didn't load fully
 * shouldn't count as a change).
 */
export const domChanged: ConditionHandler<DomChanged> = {
  type: "dom.changed",
  title: "Content changed",
  description: "Matches when the text of the first matching element (or the page) differs from the previous check. The first check only remembers it.",
  context: "page",
  schema: domChangedSchema,
  permissions: ["host"],
  check: (c, ctx) => optionalSelector(c, ctx.path),
  validate: schemaValidator(domChangedSchema),
  evaluate: async (config, ctx) => {
    const r = ctx.pageResult(config);
    if (r.status === "unknown") return r;
    const now = r.details?.fingerprint;
    if (now === undefined) return forOthers(r, "not_matched", r.details?.note ?? "Element not found");
    if (!ctx.memory) return forOthers(r, "not_matched", NOT_COMPARED);
    const before = ctx.memory.get();
    ctx.memory.set(now);
    if (before === undefined) return forOthers(r, "not_matched", "First check: nothing to compare with yet");
    return before === now ? forOthers(r, "not_matched", "Unchanged since the last check") : forOthers(r, "matched", "Changed since the last check");
  },
};

/**
 * Stateful: like "text doesn't contain", but only once the text has been
 * seen in this run. A page that never showed it (a typo, a login page) never
 * matches. After it matches it has to be seen again to match again.
 */
export const domTextLost: ConditionHandler<DomTextLost> = {
  type: "dom.text_lost",
  title: "Text gone (after being seen)",
  description: "Matches when text that was on the page at an earlier check is no longer there. Never matches if the text hasn't been seen.",
  context: "page",
  schema: domTextLostSchema,
  permissions: ["host"],
  check: (c, ctx) => optionalSelector(c, ctx.path),
  validate: schemaValidator(domTextLostSchema),
  evaluate: async (config, ctx) => {
    const r = ctx.pageResult(config);
    if (r.status === "unknown") return r;
    if (r.status === "matched") {
      ctx.memory?.set("seen");
      return forOthers(r, "not_matched", "The text is there");
    }
    if (!ctx.memory) return forOthers(r, "not_matched", NOT_COMPARED);
    if (ctx.memory.get() !== "seen") return forOthers(r, "not_matched", "The text hasn't been seen on this page yet");
    ctx.memory.set(undefined);
    return forOthers(r, "matched", "The text is gone");
  },
};
