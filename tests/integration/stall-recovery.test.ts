/**
 * A browser call that never returns (page paused in a debugger, tab driven
 * through chrome.debugger by another extension, …) must not wedge a tab in
 * "evaluating" forever or block other operations on that tab.
 */
import { createEnv } from "../helpers/fake-env";
import { makeRule } from "../helpers/fixtures";
import { alarmName, DEFAULT_TIMEOUTS, type EngineTimeouts } from "@/core/rule-engine";
import { TimeoutError } from "@/core/timeout";

const FAST = { pageMs: 20, reloadMs: 20 };

async function setup(timeouts: Partial<EngineTimeouts>, ruleExtra: Parameters<typeof makeRule>[0] = { id: "r1" }) {
  const env = createEnv({ timeouts });
  await env.config.update((c) => {
    c.rules[ruleExtra.id] = makeRule(ruleExtra);
  });
  env.browser.addTab(1, "https://example.com/a");
  await env.engine.syncTab(1);
  env.clock.advance(30_000);
  return env;
}

describe("stalled browser calls", () => {
  it("a page that never answers the activity check pauses the tab instead of hanging", async () => {
    const env = await setup(FAST);
    env.page.stalled.add(1);

    await env.fireDue();
    let rt = await env.runtime.get(1);
    expect(rt).toMatchObject({ status: "paused_activity" });
    expect(rt!.reason).toMatch(/did not respond/);
    expect(env.browser.reloads).toEqual([]);
    const retryAt = env.alarms.alarms.get(alarmName(1));
    expect(retryAt).toBeGreaterThan(env.clock.t);

    // Page recovers: the retry alarm refreshes it.
    env.page.stalled.delete(1);
    env.clock.t = retryAt!;
    await env.fireDue();
    expect(env.browser.reloads).toEqual([1]);
    rt = await env.runtime.get(1);
    expect(rt).toMatchObject({ status: "refreshing" });
  });

  it("a stalled DOM evaluation reports unknown (timeout) and follows the onUnknown policy", async () => {
    const env = await setup(FAST, { id: "r1", stopWhen: { type: "dom.exists", selector: "#done" } });
    env.page.stalled.add(1);

    await env.fireDue();
    const rt = await env.runtime.get(1);
    expect(rt).toMatchObject({ status: "paused_unknown", lastEvaluation: { status: "unknown" } });
    expect(env.browser.reloads).toEqual([]);
    expect(env.alarms.alarms.has(alarmName(1))).toBe(true);
  });

  it("a reload call that never returns stays pending instead of erroring, and does not overlap", async () => {
    const env = await setup(FAST);
    env.browser.stallReload.add(1);

    await env.fireDue();
    let rt = await env.runtime.get(1);
    expect(rt).toMatchObject({ status: "refreshing", refreshCount: 1 });
    expect(rt!.pendingReload).not.toBeNull();

    // Next alarm while still pending: no second reload.
    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([1]);

    // Navigation eventually completes.
    await env.completeNavigation(1);
    rt = await env.runtime.get(1);
    expect(rt).toMatchObject({ status: "scheduled", pendingReload: null, navigationCount: 1 });
  });

  it("lock backstop + watchdog: a cycle stuck beyond the lock limit releases the tab and is re-run", async () => {
    // pageMs deliberately longer than lockMs to simulate an unbounded stall.
    const env = await setup({ pageMs: 10_000, lockMs: 30, watchdogMs: 60_000 });
    env.page.stalled.add(1);

    const stuckAt = env.clock.t;
    await expect(env.engine.handleAlarm(alarmName(1))).rejects.toBeInstanceOf(TimeoutError);
    expect(await env.runtime.get(1)).toMatchObject({ status: "evaluating" });
    // The watchdog alarm was armed when the cycle entered "evaluating".
    expect(env.alarms.alarms.get(alarmName(1))).toBe(stuckAt + 60_000);

    // Other operations on the tab are no longer blocked by the stuck one.
    await expect(env.engine.syncTab(1)).resolves.toBeTruthy();

    // Watchdog fires after the page recovers: the cycle re-runs and refreshes.
    env.page.stalled.delete(1);
    env.clock.t = stuckAt + 60_000;
    await env.fireDue();
    expect(env.browser.reloads).toEqual([1]);
  });

  it("default limits: all bounded calls of one cycle fit inside the lock backstop, which fits inside the watchdog", () => {
    const { pageMs, reloadMs, lockMs, watchdogMs } = DEFAULT_TIMEOUTS;
    // A cycle makes at most: DOM evaluation + activity check + reload.
    expect(2 * pageMs + reloadMs).toBeLessThan(lockMs);
    expect(lockMs).toBeLessThan(watchdogMs);
    expect(watchdogMs).toBeGreaterThanOrEqual(30_000); // Chrome's minimum alarm delay
  });
});
