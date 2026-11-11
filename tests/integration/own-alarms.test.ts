/**
 * Rules that aren't run by a timer (page load, startup, manual) still get
 * alarms the engine sets itself: a postponed refresh, a timed pause, active
 * hours opening. Each must do its job once, not re-arm every 30 s forever.
 */
import { createEnv, quietActivity } from "../helpers/fake-env";
import { makeRule } from "../helpers/fixtures";
import { alarmName } from "@/core/rule-engine";

async function setup(extra: Record<string, unknown> = {}, type = "navigation") {
  const env = createEnv();
  await env.config.update((c) => {
    c.rules.r1 = makeRule({ id: "r1", trigger: (type === "interval" ? { type, seconds: 30 } : { type }) as never, ...extra });
  });
  env.browser.addTab(1, "https://example.com/page");
  await env.engine.syncTab(1);
  return env;
}

describe("alarms for rules not run by a timer", () => {
  it.each(["startup", "manual"])("%s rule: a refresh postponed while typing happens once you stop, then nothing wakes it", async (type) => {
    const env = await setup({}, type);
    env.page.activityByTab.set(1, quietActivity({ sinceKeyMs: 1_000, editing: true }));
    await env.engine.handleEvent(1, type as never);
    expect((await env.runtime.get(1))?.status).toBe("paused_activity");
    expect(env.alarms.alarms.has(alarmName(1))).toBe(true);

    env.page.activityByTab.set(1, quietActivity());
    env.clock.advance(5 * 60_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([1]);
    await env.completeNavigation(1);
    expect((await env.runtime.get(1))?.status).toBe("scheduled");
    expect(env.alarms.alarms.has(alarmName(1))).toBe(false);
    env.clock.advance(60 * 60_000);
    expect(await env.fireDue()).toBe(0);
  });

  it("still typing at the retry: stays postponed and tries again later (not a busy loop)", async () => {
    const env = await setup({}, "manual");
    env.page.activityByTab.set(1, quietActivity({ sinceKeyMs: 1_000, editing: true }));
    await env.engine.handleEvent(1, "manual");
    const first = (await env.runtime.get(1))!.nextDueAt!;
    env.clock.t = first;
    await env.fireDue();
    const rt = (await env.runtime.get(1))!;
    expect(rt.status).toBe("paused_activity");
    expect(rt.nextDueAt!).toBeGreaterThanOrEqual(first + 30_000);
    expect(env.browser.reloads).toEqual([]);
  });

  it("outside active hours: when the hours open, it waits for the next page load instead of re-arming", async () => {
    const h = new Date(createEnv().clock.t).getHours();
    const hh = (n: number) => `${String(n % 24).padStart(2, "0")}:00`;
    const env = await setup({ schedule: { startTime: hh(h + 1), endTime: hh(h + 2) } });
    await env.engine.handleEvent(1, "navigation");
    const rt = (await env.runtime.get(1))!;
    expect(rt).toMatchObject({ status: "scheduled", reason: "Outside active hours" });
    env.clock.t = rt.nextDueAt!;
    await env.fireDue();
    expect(await env.runtime.get(1)).toMatchObject({ status: "scheduled", nextDueAt: null, reason: "Runs each time the page loads" });
    expect(env.alarms.alarms.has(alarmName(1))).toBe(false);
    expect(env.browser.reloads).toEqual([]);
  });

  it("a timed pause ends at its time and then waits for the rule's own trigger", async () => {
    const env = await setup();
    const rt = (await env.runtime.get(1))!;
    const resumeAt = env.clock.t + 10 * 60_000;
    await env.runtime.put({ ...rt, status: "paused_user", reason: "Paused by rule for 10 min", resumeAt, nextDueAt: resumeAt });
    await env.alarms.set(alarmName(1), resumeAt);
    env.clock.t = resumeAt;
    await env.fireDue();
    expect(await env.runtime.get(1)).toMatchObject({ status: "scheduled", resumeAt: null, nextDueAt: null });
    expect(env.alarms.alarms.has(alarmName(1))).toBe(false);
  });

  it("interval rules are unchanged: the alarm refreshes", async () => {
    const env = await setup({}, "interval");
    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([1]);
  });

  it("a manual refresh whose page never finishes loading recovers at its watchdog, without running again", async () => {
    const env = await setup({}, "manual");
    await env.engine.handleEvent(1, "manual");
    expect((await env.runtime.get(1))?.status).toBe("refreshing");
    env.clock.advance(60_000);
    await env.fireDue();
    expect(await env.runtime.get(1)).toMatchObject({ status: "scheduled", pendingReload: null, nextDueAt: null, reason: "Runs when you run it" });
    expect(env.browser.reloads).toEqual([1]);
    expect(env.alarms.alarms.has(alarmName(1))).toBe(false);
  });
});
