import { readFileSync } from "node:fs";
import { z } from "zod";
import { buildRuleJsonSchema } from "@/api/json-schema";
import { createRegistries } from "@/registries";
import { validateRule } from "@/core/rule-schema";
import { evaluateConditionTree } from "@/core/evaluator";
import type { ConditionHandler } from "@/registries/contracts";
import { handleAgentMessage, RateLimiter } from "@/integrations/external-messaging";
import { createApiEnv } from "../helpers/api-env";

it("schemas/rule.schema.json is in sync with the code (run npm run gen:schema)", () => {
  const committed = JSON.parse(readFileSync("schemas/rule.schema.json", "utf8"));
  expect(committed).toEqual(JSON.parse(JSON.stringify(buildRuleJsonSchema())));
});

it("new condition types plug in without touching the engine", async () => {
  const registries = createRegistries();
  const schema = z.strictObject({ type: z.literal("navigationCount"), atLeast: z.number().int() });
  const handler: ConditionHandler<z.infer<typeof schema>> = {
    type: "navigationCount",
    title: "Navigation count",
    description: "test",
    context: "browser",
    schema,
    permissions: [],
    validate: (i) => schema.parse(i),
    evaluate: async (c, ctx) => (ctx.runtime.navigationCount >= c.atLeast ? { status: "matched" } : { status: "not_matched" }),
  };
  registries.conditions.register(handler);
  const rule = { name: "x", target: { patterns: ["a.com"] }, trigger: { type: "interval", seconds: 30 }, stopWhen: { type: "navigationCount", atLeast: 2 } };
  expect(validateRule(rule).valid).toBe(false); // default registry doesn't know it
  expect(validateRule(rule, { registries }).valid).toBe(true);
  const out = await evaluateConditionTree(rule.stopWhen, {
    now: 0,
    tab: { id: 1, url: "https://a.com" },
    runtime: { refreshCount: 0, navigationCount: 3, startedAt: 0 },
    pageEvaluator: async () => [],
    registries,
  });
  expect(out.result.status).toBe("matched");
  expect(JSON.stringify(buildRuleJsonSchema(registries))).toContain("navigationCount");
});

describe("external messaging", () => {
  it("validates protocol, pairs, and rate limits", async () => {
    const env = createApiEnv();
    const limiter = new RateLimiter(2, 60_000);
    const id = { id: "ext:abc", name: "Ext", transport: "extension" as const, extensionId: "abc" };
    expect(await handleAgentMessage(env.service, limiter, id, { method: "listRules" })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await handleAgentMessage(env.service, limiter, id, { protocol: "sar-agent/1", method: "pair", name: "My agent" })).toMatchObject({
      ok: true,
      result: { status: "pending" },
    });
    expect(await handleAgentMessage(env.service, limiter, id, { protocol: "sar-agent/1", method: "listRules" })).toMatchObject({
      ok: false,
      error: { code: "pairing_required" },
    });
    expect(await handleAgentMessage(env.service, limiter, id, { protocol: "sar-agent/1", method: "listRules" })).toMatchObject({
      ok: false,
      error: { message: "Rate limit exceeded" },
    });
  });
});
