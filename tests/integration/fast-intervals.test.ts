/**
 * Intervals under 30 s: opt-in (Settings → Advanced), hard floor 5 s, and at
 * most one fast automatic refresh per site every 5 s across tabs.
 */
import { createApiEnv } from "../helpers/api-env";
import { alarmName } from "@/core/rule-engine";
import { validateRule } from "@/core/rule-schema";
import { ConfigRepository } from "@/storage/repositories";
import { MemoryKV } from "@/storage/kv";
import type { Rule } from "@/core/types";

const rule = (id: string, seconds: number, pattern = "https://shop.test/*") => ({
  id,
  name: id,
  target: { patterns: [pattern] },
  trigger: { type: "interval", seconds },
});

describe("fast intervals: validation and settings", () => {
  it("rejects sub-30 s intervals unless enabled, and never accepts below 5 s", async () => {
    const env = createApiEnv();
    await expect(env.service.call(env.user, "createRule", { rule: rule("a", 10) })).rejects.toMatchObject({
      code: "validation_failed",
      diagnostics: [expect.objectContaining({ path: "trigger.seconds", code: "fast_intervals_disabled" })],
    });
    await env.service.call(env.user, "updateSettings", { allowFastIntervals: true });
    await expect(env.service.call(env.user, "createRule", { rule: rule("a", 10) })).resolves.toMatchObject({ id: "a" });
    await expect(env.service.call(env.user, "createRule", { rule: rule("b", 4) })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(env.service.call(env.user, "createRule", { rule: { ...rule("c", 30), trigger: { type: "interval", seconds: 30, randomMaxSeconds: 20 } } })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("capabilities report the effective minimum", async () => {
    const env = createApiEnv();
    const caps = () => env.service.call(env.user, "getCapabilities", undefined) as Promise<{ limits: { minIntervalSeconds: number; fastIntervalsEnabled: boolean } }>;
    expect((await caps()).limits).toMatchObject({ minIntervalSeconds: 30, fastIntervalsEnabled: false });
    await env.service.call(env.user, "updateSettings", { allowFastIntervals: true });
    expect((await caps()).limits).toMatchObject({ minIntervalSeconds: 5, fastIntervalsEnabled: true });
  });

  it("startTab respects the setting", async () => {
    const env = createApiEnv();
    env.browser.addTab(1, "https://shop.test/a");
    await expect(env.service.call(env.user, "startTab", { tabId: 1, intervalSeconds: 10 })).rejects.toMatchObject({ code: "invalid_params" });
    await env.service.call(env.user, "updateSettings", { allowFastIntervals: true });
    await env.service.call(env.user, "startTab", { tabId: 1, intervalSeconds: 10 });
    expect(env.alarms.alarms.get(alarmName(1))).toBe(env.clock.t + 10_000);
  });

  it("stored fast rules survive a reload and run at 30 s while the setting is off", async () => {
    const env = createApiEnv();
    await env.service.call(env.user, "updateSettings", { allowFastIntervals: true });
    await env.service.call(env.user, "createRule", { rule: rule("fast", 10) });
    await env.service.call(env.user, "enableRule", { id: "fast" });

    // Structural re-validation on load (no settings context) keeps the rule.
    expect(validateRule((await env.config.get()).rules.fast).valid).toBe(true);
    const kv = new MemoryKV();
    for (const [k, v] of Object.entries(await env.local.get(null))) kv.data.set(k, v);
    const reloaded = new ConfigRepository(kv);
    expect(Object.keys((await reloaded.get()).rules)).toContain("fast");

    env.browser.addTab(1, "https://shop.test/a");
    await env.engine.syncTab(1);
    expect(env.alarms.alarms.get(alarmName(1))).toBe(env.clock.t + 10_000);

    await env.service.call(env.user, "updateSettings", { allowFastIntervals: false });
    expect(((await env.config.get()).rules.fast as Rule).trigger).toMatchObject({ seconds: 10 }); // kept as authored
    env.clock.advance(10_000);
    await env.fireDue();
    await env.completeNavigation(1);
    const rt = await env.runtime.get(1);
    expect(rt?.nextDueAt).toBe(env.clock.t + 30_000); // runs at the standard minimum
  });
});

describe("fast intervals: per-site limit", () => {
  it("allows one fast refresh per site every 5 s across tabs; other sites are independent", async () => {
    const env = createApiEnv();
    await env.service.call(env.user, "updateSettings", { allowFastIntervals: true });
    env.browser.addTab(1, "https://shop.test/a");
    env.browser.addTab(2, "https://shop.test/b");
    env.browser.addTab(3, "https://other.test/");
    for (const id of [1, 2, 3]) await env.service.call(env.user, "startTab", { tabId: id, intervalSeconds: 5 });

    env.clock.advance(5_000);
    await env.fireDue();
    expect(env.browser.reloads.sort()).toEqual([1, 3]); // tab 2 shares shop.test with tab 1
    const deferred = await env.runtime.get(2);
    expect(deferred).toMatchObject({ status: "scheduled", reason: expect.stringMatching(/one fast refresh per site/) });
    expect(deferred?.nextDueAt).toBe(env.clock.t + 5_000);
    // Deferrals are routine: not written to history.
    expect(JSON.stringify(await env.service.call(env.user, "getHistory", {}))).not.toContain("one fast refresh per site");
  });

  it("standard intervals are not affected by the per-site limit", async () => {
    const env = createApiEnv();
    env.browser.addTab(1, "https://shop.test/a");
    env.browser.addTab(2, "https://shop.test/b");
    for (const id of [1, 2]) await env.service.call(env.user, "startTab", { tabId: id, intervalSeconds: 30 });
    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.reloads.sort()).toEqual([1, 2]);
  });
});
