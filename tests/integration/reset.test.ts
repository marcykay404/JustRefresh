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
    // A tab timer, with its run and alarm, and an agent's request waiting for approval.
    env.browser.addTab(7, "https://shop.test/order?id=42");
    await env.service.call(env.user, "startTab", { tabId: 7, intervalSeconds: 30 });
    expect(await env.runtime.get(7)).not.toBeNull();
    const draft = (await env.service.call(agent, "createRule", { rule: { ...SPEC_EXAMPLE, id: "agent-rule" } })) as { id: string };
    await env.service.call(agent, "enableRule", { id: draft.id });
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
    expect(JSON.stringify(await env.local.get(null))).not.toMatch(/rule-001|agent-rule|order\?id=42|native:claude/);
    // Nor anything about the tabs: their runs and alarms are gone.
    expect(await env.runtime.getAll()).toEqual([]);
    expect(JSON.stringify(await env.session.get(null))).not.toMatch(/order\?id=42|rule-001/);
    expect([...env.alarms.alarms.keys()]).toEqual([]);
  });

  it("waits for a check already running, even a tab's first, so nothing is written back after it", async () => {
    const env = createApiEnv();
    await env.service.call(env.user, "createRule", { rule: SPEC_EXAMPLE });
    env.browser.addTab(9, "https://example.com/products/42");
    env.page.setHtml(9, `<p id="status">Available</p>`);
    // As if the page had just loaded: no run stored for it yet.
    await env.runtime.delete(9);
    // Hold the check after it has read the old rules but before it has stored anything.
    const getTab = env.browser.getTab.bind(env.browser);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let holding = true;
    env.browser.getTab = async (id) => {
      if (id === 9 && holding) {
        holding = false;
        await held;
      }
      return getTab(id);
    };
    const cycle = env.engine.runCycle(9, "manual");
    await new Promise((r) => setTimeout(r, 10));
    const reset = env.service.call(env.user, "resetConfig", { confirm: true });
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([cycle, reset]);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(await env.history.list()).toEqual([]);
    expect(await env.runtime.getAll()).toEqual([]);
    expect([...env.alarms.alarms.keys()]).toEqual([]);
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
