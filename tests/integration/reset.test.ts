/** Settings → Reset to defaults deletes everything JustRefresh keeps, with no backup of it left behind. */
import { createApiEnv } from "../helpers/api-env";
import { makeRule, SPEC_EXAMPLE } from "../helpers/fixtures";
import { CONFIG_BACKUP_KEY, CONFIG_KEY } from "@/storage/repositories";
import type { Config } from "@/core/types";

describe("Reset to defaults", () => {
  it("deletes rules, settings, agents, the history, the agent log and agents' events, and keeps no backup of them", async () => {
    const env = createApiEnv();
    await env.pairAgent("native:claude");
    const agent = env.agent("native:claude");
    await env.service.call(env.user, "createRule", { rule: SPEC_EXAMPLE });
    await env.service.call(agent, "listRules", undefined); // a line in the agent log
    await env.service.call(env.user, "updateSettings", { allowWebhooks: true });
    await env.history.append({
      at: env.clock.now(),
      ruleId: "rule-001",
      tabId: 1,
      url: "https://shop.test/order?id=42",
      trigger: "alarm",
      action: "refresh",
      outcome: "ok",
      actor: "system",
    });
    await env.events.rule({
      kind: "rule.matched",
      rule: makeRule({ id: "r1" }, { origin: { type: "agent", agentId: "native:claude" } }),
      tabId: 1,
      url: "https://shop.test/",
    });
    expect((await env.history.list()).length).toBe(1);
    expect((await env.audit.list()).length).toBeGreaterThan(0);
    expect(((await env.service.call(env.user, "getEvents", {})) as { events: unknown[] }).events).toHaveLength(1);

    await env.service.call(env.user, "resetConfig", { confirm: true });

    const config = await env.config.get();
    expect(config.rules).toEqual({});
    expect(config.agents).toEqual({});
    expect(config.settings.allowWebhooks).toBe(false);
    expect(await env.history.list()).toEqual([]);
    expect(await env.audit.list()).toEqual([]);
    expect(((await env.service.call(env.user, "getEvents", {})) as { events: unknown[] }).events).toEqual([]);
    // Nothing of the old configuration is left in storage, not even as the backup.
    const stored = (await env.local.get([CONFIG_KEY, CONFIG_BACKUP_KEY])) as Record<string, Config>;
    expect(stored[CONFIG_BACKUP_KEY]).toEqual(stored[CONFIG_KEY]);
    expect(JSON.stringify(await env.local.get(null))).not.toMatch(/rule-001|order\?id=42|native:claude/);
  });

  it("any other change still keeps the previous configuration as the backup", async () => {
    const env = createApiEnv();
    await env.service.call(env.user, "createRule", { rule: SPEC_EXAMPLE });
    await env.service.call(env.user, "updateSettings", { allowWebhooks: true });
    const backup = ((await env.local.get(CONFIG_BACKUP_KEY)) as Record<string, Config>)[CONFIG_BACKUP_KEY];
    expect(backup.rules).toHaveProperty("rule-001");
    expect(backup.settings.allowWebhooks).toBe(false);
  });
});
