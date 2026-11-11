import { z } from "../core/zod";
import type { ConditionHandler } from "../registries/contracts";
import { schemaValidator } from "../registries/contracts";
import { compilePattern, validatePattern } from "../core/url-pattern";
import { urlPatternSchema } from "../core/pattern-schema";
import { diag } from "./helpers";

export const urlMatchSchema = z.strictObject({
  type: z.literal("url.match"),
  pattern: urlPatternSchema,
});
export type UrlMatch = z.infer<typeof urlMatchSchema>;

export const urlMatch: ConditionHandler<UrlMatch> = {
  type: "url.match",
  title: "URL matches",
  description: "Matches when the tab's current URL matches the pattern (exact, domain, glob or regex).",
  context: "browser",
  schema: urlMatchSchema,
  permissions: ["tabs"],
  check: (c, ctx) => {
    const problem = validatePattern(c.pattern);
    return problem ? [diag(`${ctx.path}.pattern`, "pattern_invalid", problem)] : [];
  },
  validate: schemaValidator(urlMatchSchema),
  evaluate: async (c, ctx) => {
    if (!ctx.tab.url) return { status: "unknown", code: "tab_unavailable", reason: "Tab URL unavailable" };
    return compilePattern(c.pattern).test(ctx.tab.url) ? { status: "matched" } : { status: "not_matched" };
  },
};
