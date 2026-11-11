/**
 * Pages reached by submitting a form (POST) are never reloaded: in Chrome a
 * reload asks "Confirm Form Resubmission", which blocks an unattended tab
 * and, if someone presses Continue, sends the order again.
 */
import { createApiEnv } from "../helpers/api-env";
import { quietActivity } from "../helpers/fake-env";
import { makeRule } from "../helpers/fixtures";
import { FORM_RESULT_REASON } from "@/core/rule-engine";

async function setup(protection = true) {
  const env = createApiEnv();
  env.browser.addTab(7, "https://shop.test/order");
  env.page.activityByTab.set(7, quietActivity({ formResult: true }));
  await env.service.call(env.user, "startTab", {
    tabId: 7,
    intervalSeconds: 30,
    ...(protection ? {} : { safety: { pauseWhileTyping: false, protectUnsavedChanges: false } }),
  });
  return env;
}

describe("form results (pages reached by submitting a form)", () => {
  it("are not refreshed automatically: paused with the reason, notified once", async () => {
    const env = await setup();
    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([]);
    expect(await env.runtime.get(7)).toMatchObject({ status: "paused_resubmit", reason: FORM_RESULT_REASON });
    expect(env.browser.notifications.map((n) => n.title)).toEqual(["Refreshing paused: shop.test"]);

    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([]);
    expect(env.browser.notifications).toHaveLength(1); // announced once, not every interval
  });

  it("apply even with activity protection switched off", async () => {
    const env = await setup(false);
    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([]);
    expect((await env.runtime.get(7))?.status).toBe("paused_resubmit");
  });

  it("Refresh now explains instead of reloading", async () => {
    const env = await setup();
    const r = await env.service.call(env.user, "refreshNow", { tabId: 7 });
    expect(r).toEqual({ refreshed: false, reason: FORM_RESULT_REASON, formResult: true });
    expect(env.browser.reloads).toEqual([]);
  });

  it("Open this page fresh loads the address as a normal visit and carries on refreshing", async () => {
    const env = await setup();
    env.clock.advance(30_000);
    await env.fireDue();
    expect(await env.service.call(env.user, "openFresh", { tabId: 7 })).toEqual({ opened: true });
    expect(env.browser.navigations).toEqual([{ tabId: 7, url: "https://shop.test/order" }]);
    expect(env.browser.reloads).toEqual([]);
    expect((await env.runtime.get(7))?.status).toBe("scheduled");

    // The fresh page is an ordinary page: the next refresh goes ahead.
    env.page.activityByTab.set(7, quietActivity());
    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([7]);
  });
});

describe("form results: edge cases from review", () => {
  it("not even a forced refresh resends the form", async () => {
    const env = await setup();
    const r = await env.service.call(env.user, "refreshNow", { tabId: 7, force: true });
    expect(r).toMatchObject({ refreshed: false, formResult: true });
    expect(env.browser.reloads).toEqual([]);
  });

  it("Open this page fresh drops a #fragment (otherwise Chrome would just jump within the page)", async () => {
    const env = await setup();
    env.browser.tabs.get(7)!.url = "https://shop.test/order#done";
    await env.service.call(env.user, "openFresh", { tabId: 7 });
    expect(env.browser.navigations).toEqual([{ tabId: 7, url: "https://shop.test/order" }]);
  });

  it("a watch paused on a form page that reaches its time limit completes instead of getting stuck", async () => {
    const env = createApiEnv();
    env.browser.addTab(7, "https://shop.test/order");
    env.page.activityByTab.set(7, quietActivity({ formResult: true }));
    env.page.setHtml(7, "<p>Sold out</p>");
    await env.service.call(env.user, "createRule", {
      rule: {
        name: "Watch",
        target: { patterns: ["https://shop.test/order"] },
        trigger: { type: "interval", seconds: 60 },
        stopWhen: { type: "dom.text", operator: "contains", value: "In stock" },
        actions: { onMatched: [{ type: "stopRefresh" }], onNotMatched: [{ type: "refresh" }] },
        limits: { maxDurationSeconds: 600 },
      },
    });
    await env.engine.reconcileAll("config");
    for (let i = 0; i < 12; i++) {
      env.clock.advance(60_000);
      await env.fireDue();
    }
    expect(await env.runtime.get(7)).toMatchObject({ status: "completed", reason: "Reached its time limit (10 min); the condition wasn't met" });
    expect(env.browser.reloads).toEqual([]);
  });
});

describe("form results: paused without polling", () => {
  it("sets no timer while the tab stays on the form page", async () => {
    const env = await setup();
    env.clock.advance(30_000);
    await env.fireDue();
    expect((await env.runtime.get(7))?.status).toBe("paused_resubmit");
    expect(env.alarms.alarms.has("sar:tab:7")).toBe(false);
    env.clock.advance(60 * 60_000);
    expect(await env.fireDue()).toBe(0); // nothing wakes up for an hour
  });

  it("resumes when the tab loads another page, and refreshes that page normally", async () => {
    const env = await setup();
    env.clock.advance(30_000);
    await env.fireDue();
    env.browser.tabs.get(7)!.url = "https://shop.test/account";
    env.page.activityByTab.set(7, quietActivity());
    await env.engine.onTabUpdated(7, { url: "https://shop.test/account" });
    await env.engine.onTabUpdated(7, { status: "complete" });
    expect(await env.runtime.get(7)).toMatchObject({ status: "scheduled", reason: undefined });
    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([7]);
  });

  it("a page load at the same address that is no longer a form result resumes and refreshes", async () => {
    const env = await setup();
    env.clock.advance(30_000);
    await env.fireDue();
    env.page.activityByTab.set(7, quietActivity()); // e.g. opened fresh by the user or the site
    await env.engine.onTabUpdated(7, { status: "complete" }); // no URL change
    expect((await env.runtime.get(7))?.status).toBe("scheduled");
    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([7]);
  });

  it("a 'complete' event while still on the form result (e.g. history.pushState) keeps it paused, quietly", async () => {
    const env = await setup();
    env.clock.advance(30_000);
    await env.fireDue();
    for (let i = 0; i < 4; i++) await env.engine.onTabUpdated(7, { status: "complete" });
    env.clock.advance(5 * 60_000);
    await env.fireDue();
    expect((await env.runtime.get(7))?.status).toBe("paused_resubmit");
    expect(env.alarms.alarms.has("sar:tab:7")).toBe(false);
    expect(env.browser.notifications).toHaveLength(1);
    expect(env.browser.reloads).toEqual([]);
  });

  it("stays paused, with no timer, when the service worker wakes up", async () => {
    const env = await setup();
    env.clock.advance(30_000);
    await env.fireDue();
    await env.engine.reconcileAll("wake");
    expect((await env.runtime.get(7))?.status).toBe("paused_resubmit");
    expect(env.alarms.alarms.has("sar:tab:7")).toBe(false);
  });

  it("with a time limit, wakes once when the limit ends and stops", async () => {
    const env = createApiEnv();
    env.browser.addTab(7, "https://shop.test/order");
    env.page.activityByTab.set(7, quietActivity({ formResult: true }));
    await env.service.call(env.user, "startTab", { tabId: 7, intervalSeconds: 30 });
    await env.config.update((c) => void (c.tabOverrides["7"]!.limits = { maxDurationSeconds: 120 }));
    await env.engine.reconcileAll("config");
    const started = (await env.runtime.get(7))!.startedAt;
    env.clock.advance(30_000);
    await env.fireDue();
    expect((await env.runtime.get(7))?.status).toBe("paused_resubmit");
    expect(env.alarms.alarms.get("sar:tab:7")).toBe(started + 120_000);
    env.clock.t = started + 120_000;
    await env.fireDue();
    expect((await env.runtime.get(7))?.status).toBe("completed");
    expect(env.browser.reloads).toEqual([]);
  });
});

describe("form results: edge cases from the review of #14", () => {
  it.each(["startup", "manual"] as const)("a %s rule with a time limit, paused on a form page, stops at the limit instead of waking forever", async (type) => {
    const env = createApiEnv();
    env.browser.addTab(7, "https://shop.test/order");
    env.page.activityByTab.set(7, quietActivity({ formResult: true }));
    await env.config.update((c) => {
      c.rules.r1 = makeRule({ id: "r1", target: { patterns: ["https://shop.test/*"] }, trigger: { type }, limits: { maxDurationSeconds: 120 } });
    });
    await env.engine.syncTab(7);
    const started = (await env.runtime.get(7))!.startedAt;
    await env.engine.handleEvent(7, type);
    expect((await env.runtime.get(7))?.status).toBe("paused_resubmit");
    expect(env.alarms.alarms.get("sar:tab:7")).toBe(started + 120_000);
    env.clock.t = started + 120_000;
    await env.fireDue();
    expect(await env.runtime.get(7)).toMatchObject({ status: "completed", reason: "Reached its time limit (2 min)" });
    env.clock.advance(10 * 60_000);
    expect(await env.fireDue()).toBe(0);
    expect(env.browser.reloads).toEqual([]);
  });

  it.each([
    ["a #hash change", "https://shop.test/order#receipt"],
    ["history.replaceState to another address", "https://shop.test/order/42"],
  ])("%s on the form page keeps the run: same time limit, no second notification", async (_label, url) => {
    const env = await setup();
    env.clock.advance(30_000);
    await env.fireDue();
    const before = (await env.runtime.get(7))!;
    env.browser.tabs.get(7)!.url = url; // same document: still a form result
    await env.engine.onTabUpdated(7, { url });
    await env.engine.onTabUpdated(7, { status: "complete" });
    env.clock.advance(5 * 60_000);
    await env.fireDue();
    const after = (await env.runtime.get(7))!;
    expect(after).toMatchObject({ status: "paused_resubmit", generation: before.generation, startedAt: before.startedAt });
    expect(env.alarms.alarms.has("sar:tab:7")).toBe(false);
    expect(env.browser.notifications).toHaveLength(1);
    expect(env.browser.reloads).toEqual([]);
  });

  it("going to another page after such a change starts a new run there", async () => {
    const env = await setup();
    env.clock.advance(30_000);
    await env.fireDue();
    const before = (await env.runtime.get(7))!;
    env.browser.tabs.get(7)!.url = "https://shop.test/order#receipt";
    await env.engine.onTabUpdated(7, { url: "https://shop.test/order#receipt" });
    env.clock.advance(60_000);
    env.browser.tabs.get(7)!.url = "https://shop.test/account";
    env.page.activityByTab.set(7, quietActivity());
    await env.engine.onTabUpdated(7, { url: "https://shop.test/account" });
    await env.engine.onTabUpdated(7, { status: "complete" });
    const after = (await env.runtime.get(7))!;
    expect(after).toMatchObject({ status: "scheduled", url: "https://shop.test/account", startedAt: env.clock.t });
    expect(after.generation).toBeGreaterThan(before.generation);
    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([7]);
  });

  it("the same address loaded as a normal visit carries on with the same run", async () => {
    const env = await setup();
    env.clock.advance(30_000);
    await env.fireDue();
    const before = (await env.runtime.get(7))!;
    env.page.activityByTab.set(7, quietActivity());
    await env.engine.onTabUpdated(7, { status: "complete" });
    expect(await env.runtime.get(7)).toMatchObject({ status: "scheduled", generation: before.generation, startedAt: before.startedAt });
  });
});

describe("form results: leaving the pause follows the tab's address (review)", () => {
  const pausedThenHash = async () => {
    const env = await setup();
    env.clock.advance(30_000);
    await env.fireDue();
    env.browser.tabs.get(7)!.url = "https://shop.test/order#r";
    await env.engine.onTabUpdated(7, { url: "https://shop.test/order#r" });
    return { env, before: (await env.runtime.get(7))! };
  };

  it("Resume in the dashboard after a #hash change keeps the run (same time limit)", async () => {
    const { env, before } = await pausedThenHash();
    await env.engine.setTabStatus(7, "scheduled", "Resumed");
    expect(await env.runtime.get(7)).toMatchObject({ status: "scheduled", url: "https://shop.test/order#r", generation: before.generation });
    env.clock.advance(30_000);
    await env.fireDue();
    // Paused again in the same run (a resume asked for it, so it says so again).
    expect(await env.runtime.get(7)).toMatchObject({ status: "paused_resubmit", generation: before.generation, startedAt: before.startedAt });
    expect(env.browser.reloads).toEqual([]);
  });

  it("the same page loaded as a normal visit, at an address with #…, carries on with the same run", async () => {
    const { env, before } = await pausedThenHash();
    env.page.activityByTab.set(7, quietActivity());
    await env.engine.onTabUpdated(7, { status: "complete" });
    expect(await env.runtime.get(7)).toMatchObject({ status: "scheduled", generation: before.generation, startedAt: before.startedAt });
  });
});
