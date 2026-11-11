/**
 * Pages reached by submitting a form (POST) are never reloaded: in Chrome a
 * reload asks "Confirm Form Resubmission", which blocks an unattended tab
 * and, if someone presses Continue, sends the order again.
 */
import { createApiEnv } from "../helpers/api-env";
import { quietActivity } from "../helpers/fake-env";
import { FORM_RESULT_REASON } from "@/core/rule-engine";

async function setup(protection = true) {
  const env = createApiEnv();
  env.browser.addTab(7, "https://shop.test/order");
  env.page.activityByTab.set(7, quietActivity({ formResult: true }));
  await env.service.call(env.user, "startTab", { tabId: 7, intervalSeconds: 30, ...(protection ? {} : { safety: { pauseWhileTyping: false, protectUnsavedChanges: false } }) });
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
