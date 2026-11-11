import { createEnv, quietActivity } from "../helpers/fake-env";
import { makeRule } from "../helpers/fixtures";
import { alarmName } from "@/core/rule-engine";
import type { TabOverride } from "@/core/types";

const override = (tabId: number, url: string, extra: Partial<TabOverride> = {}): TabOverride => ({
  tabId, mode: "custom", intervalSeconds: 60, revision: 1, createdAt: 0, restore: { url, windowIndex: 0, tabIndex: 0 }, ...extra,
});

async function setup(rules = [makeRule({ id: "r1" })]) {
  const env = createEnv();
  await env.config.update((c) => {
    for (const r of rules) c.rules[r.id] = r;
  });
  return env;
}

describe("Scenario A: per-tab basic refresh", () => {
  it("refreshes on schedule and tracks navigation", async () => {
    const env = createEnv();
    env.browser.addTab(1, "https://news.test/");
    await env.config.update((c) => { c.tabOverrides["1"] = override(1, "https://news.test/"); });
    await env.engine.syncTab(1);
    expect(env.alarms.alarms.get(alarmName(1))).toBe(env.clock.t + 60_000);

    env.clock.advance(60_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([1]);
    let rt = await env.runtime.get(1);
    expect(rt).toMatchObject({ status: "refreshing", refreshCount: 1, navigationCount: 0 });

    await env.completeNavigation(1);
    rt = await env.runtime.get(1);
    expect(rt).toMatchObject({ status: "scheduled", navigationCount: 1, pendingReload: null });

    env.clock.advance(60_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([1, 1]);
  });

  it("multiple tabs refresh independently with different intervals", async () => {
    const env = createEnv();
    env.browser.addTab(1, "https://a.test/");
    env.browser.addTab(2, "https://b.test/");
    await env.config.update((c) => {
      c.tabOverrides["1"] = override(1, "https://a.test/", { intervalSeconds: 30 });
      c.tabOverrides["2"] = override(2, "https://b.test/", { intervalSeconds: 90 });
    });
    await env.engine.syncTab(1);
    await env.engine.syncTab(2);
    for (let i = 0; i < 6; i++) {
      env.clock.advance(30_000);
      await env.fireDue();
      for (const id of [1, 2]) if ((await env.runtime.get(id))?.pendingReload) await env.completeNavigation(id);
    }
    expect(env.browser.reloads.filter((x) => x === 1)).toHaveLength(6);
    expect(env.browser.reloads.filter((x) => x === 2)).toHaveLength(2);
  });

  it("never overlaps reloads while navigation is pending", async () => {
    const env = createEnv();
    env.browser.addTab(1, "https://a.test/");
    await env.config.update((c) => { c.tabOverrides["1"] = override(1, "https://a.test/", { intervalSeconds: 30 }); });
    await env.engine.syncTab(1);
    env.clock.advance(30_000);
    await env.fireDue();
    // Duplicate/early alarms while the page is still loading:
    await Promise.all([env.engine.handleAlarm(alarmName(1)), env.engine.handleAlarm(alarmName(1))]);
    expect(env.browser.reloads).toEqual([1]);
    // After the navigation timeout we recover.
    env.clock.advance(61_000);
    await env.engine.handleAlarm(alarmName(1));
    expect(env.browser.reloads).toEqual([1, 1]);
  });

  it("manual refresh does not restart a stopped tab", async () => {
    const env = createEnv();
    env.browser.addTab(1, "https://a.test/");
    await env.config.update((c) => { c.tabOverrides["1"] = override(1, "https://a.test/"); });
    await env.engine.syncTab(1);
    await env.engine.setTabStatus(1, "stopped", "Stopped by user");
    const r = await env.engine.refreshNow(1);
    expect(r.refreshed).toBe(true);
    expect((await env.runtime.get(1))?.status).toBe("stopped");
    expect(env.alarms.alarms.has(alarmName(1))).toBe(false);
  });
});

describe("Scenario B/C: URL rules and exclusions", () => {
  it("new matching tabs receive the rule", async () => {
    const env = await setup();
    env.browser.addTab(5, "https://example.com/page");
    env.browser.addTab(6, "https://other.test/");
    await env.engine.reconcileAll("config");
    expect((await env.runtime.get(5))?.controllerId).toBe("r1");
    expect(await env.runtime.get(6)).toBeNull();
  });

  it("exclusions override rules", async () => {
    const env = await setup();
    await env.config.update((c) => { c.exclusions.push({ id: "e1", pattern: "https://example.com/checkout/*", createdAt: 0 }); });
    env.browser.addTab(5, "https://example.com/checkout/pay");
    await env.engine.syncTab(5);
    const rt = await env.runtime.get(5);
    expect(rt?.status).toBe("excluded");
    expect(rt?.reason).toMatch(/checkout/);
    env.clock.advance(3600_000);
    await env.engine.handleAlarm(alarmName(5));
    expect(env.browser.reloads).toEqual([]);
  });

  it("highest priority wins with stable tie-break", async () => {
    const env = await setup([
      makeRule({ id: "low", priority: 1 }),
      makeRule({ id: "b-high", priority: 10 }, { createdAt: 5 }),
      makeRule({ id: "a-high", priority: 10 }, { createdAt: 5 }),
    ]);
    env.browser.addTab(1, "https://example.com/x");
    await env.engine.syncTab(1);
    expect((await env.runtime.get(1))?.controllerId).toBe("a-high");
  });

  it("per-tab configuration overrides URL rules", async () => {
    const env = await setup();
    env.browser.addTab(1, "https://example.com/x");
    await env.config.update((c) => { c.tabOverrides["1"] = override(1, "https://example.com/x"); });
    await env.engine.syncTab(1);
    expect((await env.runtime.get(1))?.controllerId).toBe("tab:1");
  });

  it("restricted pages are excluded", async () => {
    const env = createEnv();
    env.browser.addTab(1, "chrome://settings");
    await env.config.update((c) => { c.tabOverrides["1"] = override(1, "chrome://settings"); });
    await env.engine.syncTab(1);
    expect((await env.runtime.get(1))?.status).toBe("excluded");
  });
});

describe("Scenario D: typing protection", () => {
  it("postpones refresh until the grace period passes", async () => {
    const env = await setup();
    env.browser.addTab(1, "https://example.com/form");
    await env.engine.syncTab(1);
    env.page.activityByTab.set(1, quietActivity({ sinceKeyMs: 10_000, editing: true }));
    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([]);
    const rt = await env.runtime.get(1);
    expect(rt?.status).toBe("paused_activity");
    expect(rt?.nextDueAt).toBe(env.clock.t + 50_000);

    env.page.activityByTab.set(1, quietActivity({ sinceKeyMs: 60_000 }));
    env.clock.advance(50_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([1]);
  });

  it("protects unsaved changes and supports one-shot override", async () => {
    const env = await setup();
    env.browser.addTab(1, "https://example.com/form");
    await env.engine.syncTab(1);
    env.page.activityByTab.set(1, quietActivity({ dirty: "dirty" }));
    env.clock.advance(30_000);
    await env.fireDue();
    expect((await env.runtime.get(1))?.status).toBe("paused_unsaved");
    expect((await env.engine.refreshNow(1)).refreshed).toBe(false);
    expect((await env.engine.refreshNow(1, { force: true })).refreshed).toBe(true);
  });

  it("applies the fail-safe policy when activity detection is unavailable", async () => {
    const env = await setup();
    env.browser.addTab(1, "https://example.com/x");
    env.page.unavailable.add(1);
    await env.engine.syncTab(1);
    env.clock.advance(30_000);
    await env.fireDue();
    expect((await env.runtime.get(1))?.status).toBe("paused_activity");
    expect(env.browser.reloads).toEqual([]);

    const env2 = await setup([makeRule({ id: "r1", safety: { onActivityUnavailable: "refresh" } })]);
    env2.browser.addTab(1, "https://example.com/x");
    env2.page.unavailable.add(1);
    await env2.engine.syncTab(1);
    env2.clock.advance(30_000);
    await env2.fireDue();
    expect(env2.browser.reloads).toEqual([1]);
  });
});

describe("Scenario E: refresh until condition", () => {
  const rule = () =>
    makeRule({
      id: "avail",
      stopWhen: { type: "dom.text", selector: "#status", operator: "contains", value: "Available" },
    });

  it("refreshes until matched, then stops and notifies", async () => {
    const env = await setup([rule()]);
    env.browser.addTab(1, "https://example.com/p");
    env.page.setHtml(1, `<div id="status">Sold out</div>`);
    await env.engine.syncTab(1);

    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([1]);
    env.page.setHtml(1, `<div id="status">Now Available!</div>`);
    await env.completeNavigation(1);

    const rt = await env.runtime.get(1);
    expect(rt?.status).toBe("completed");
    expect(rt?.lastEvaluation?.status).toBe("matched");
    expect(env.browser.notifications).toHaveLength(1);
    env.clock.advance(300_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([1]);
  });

  it("stops at max refreshes", async () => {
    const env = await setup([makeRule({ id: "m", limits: { maxRefreshes: 2 } })]);
    env.browser.addTab(1, "https://example.com/p");
    await env.engine.syncTab(1);
    for (let i = 0; i < 4; i++) {
      env.clock.advance(30_000);
      await env.fireDue();
      if ((await env.runtime.get(1))?.pendingReload) await env.completeNavigation(1);
    }
    expect(env.browser.reloads).toHaveLength(2);
    expect((await env.runtime.get(1))?.status).toBe("completed");
  });
});

describe("Scenario H: unknown condition", () => {
  it("pauses with bounded retries and never reports success", async () => {
    const env = await setup([
      makeRule({ id: "u", stopWhen: { type: "dom.exists", selector: "#x" }, safety: { maxUnknownRetries: 2, onActivityUnavailable: "refresh" } }),
    ]);
    env.browser.addTab(1, "https://example.com/p");
    env.page.unavailable.add(1);
    await env.engine.syncTab(1);
    for (let i = 0; i < 3; i++) {
      env.clock.advance(30_000);
      await env.fireDue();
    }
    const rt = await env.runtime.get(1);
    expect(rt?.status).toBe("paused_unknown");
    expect(rt?.reason).toMatch(/after 3 attempts/);
    expect(rt?.nextDueAt).toBeNull();
    expect(env.browser.reloads).toEqual([]);
    expect(env.browser.notifications).toEqual([]);
  });

  it("onUnknown=refresh keeps refreshing", async () => {
    const env = await setup([
      makeRule({ id: "u", stopWhen: { type: "dom.exists", selector: "#x" }, safety: { onUnknown: "refresh", onActivityUnavailable: "refresh" } }),
    ]);
    env.browser.addTab(1, "https://example.com/p");
    env.page.unavailable.add(1);
    await env.engine.syncTab(1);
    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([1]);
  });
});

describe("Scenario F & recovery: restart, wake, storms", () => {
  it("restores rules on startup with staggered first runs", async () => {
    const env = await setup();
    for (let i = 1; i <= 5; i++) env.browser.addTab(i, `https://example.com/${i}`);
    await env.engine.reconcileAll("startup");
    const times = [...env.alarms.alarms.values()].sort();
    expect(times).toHaveLength(5);
    expect(new Set(times).size).toBe(5);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(env.clock.t + 30_000);
  });

  it("recreates missing alarms after service-worker restart without duplicates", async () => {
    const env = await setup();
    env.browser.addTab(1, "https://example.com/1");
    await env.engine.syncTab(1);
    env.alarms.alarms.clear(); // alarms lost
    await env.engine.reconcileAll("wake");
    expect(env.alarms.alarms.size).toBe(1);
    await env.engine.reconcileAll("wake");
    expect(env.alarms.alarms.size).toBe(1);
  });

  it("cleans up closed tabs", async () => {
    const env = await setup();
    env.browser.addTab(1, "https://example.com/1");
    await env.engine.syncTab(1);
    env.browser.tabs.delete(1);
    await env.engine.onTabRemoved(1);
    expect(await env.runtime.get(1)).toBeNull();
    expect(env.alarms.alarms.size).toBe(0);
  });

  it("global pause and resume do not burst", async () => {
    const env = await setup();
    for (let i = 1; i <= 3; i++) env.browser.addTab(i, `https://example.com/${i}`);
    await env.engine.reconcileAll("config");
    await env.config.update((c) => { c.settings.paused = true; });
    await env.engine.reconcileAll("config");
    expect(env.alarms.alarms.size).toBe(0);
    expect((await env.runtime.get(1))?.status).toBe("paused_global");
    env.clock.advance(3600_000);
    await env.config.update((c) => { c.settings.paused = false; });
    await env.engine.reconcileAll("config");
    const times = [...env.alarms.alarms.values()];
    expect(times.every((t) => t >= env.clock.t + 30_000)).toBe(true);
    expect(env.browser.reloads).toEqual([]);
  });

  it("user navigation resets the run; editing a rule restarts it", async () => {
    const env = await setup();
    env.browser.addTab(1, "https://example.com/a");
    await env.engine.syncTab(1);
    const g1 = (await env.runtime.get(1))!.generation;
    env.browser.tabs.get(1)!.url = "https://example.com/b";
    await env.engine.onTabUpdated(1, { url: "https://example.com/b" });
    expect((await env.runtime.get(1))!.generation).toBe(g1 + 1);
    await env.config.update((c) => { c.rules.r1.meta.revision++; });
    await env.engine.syncTab(1);
    expect((await env.runtime.get(1))!.generation).toBe(g1 + 2);
  });

  it("outside active hours schedules for the window start", async () => {
    const env = await setup([makeRule({ id: "w", schedule: { startTime: "23:00", endTime: "23:30" } })]);
    env.browser.addTab(1, "https://example.com/a");
    await env.engine.syncTab(1);
    env.clock.advance(30_000);
    await env.fireDue();
    const rt = await env.runtime.get(1);
    expect(rt?.reason).toBe("Outside active hours");
    expect(new Date(rt!.nextDueAt!).getHours()).toBe(23);
  });
});
