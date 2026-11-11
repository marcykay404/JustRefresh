/**
 * Fixes from the independent review of #5–#12: watches that end on a time
 * limit say so, agents don't see query strings in other people's rules, and
 * the "Stop watching after" default.
 */
import { createApiEnv } from "../helpers/api-env";
import { redactPattern } from "@/api/permissions";

describe("a watch that reaches its time limit", () => {
  const until = (limits?: object) => ({
    name: "Watch",
    target: { patterns: ["https://shop.test/item"] },
    trigger: { type: "interval", seconds: 60 },
    stopWhen: { type: "dom.text", operator: "contains", value: "In stock" },
    actions: { onMatched: [{ type: "stopRefresh" }, { type: "notify" }], onNotMatched: [{ type: "refresh" }] },
    ...(limits ? { limits } : {}),
  });

  it("stops and notifies that the condition wasn't met", async () => {
    const env = createApiEnv();
    env.browser.addTab(7, "https://shop.test/item");
    env.page.setHtml(7, "<p>Sold out</p>");
    await env.service.call(env.user, "createRule", { rule: until({ maxDurationSeconds: 1200 }) });
    await env.engine.reconcileAll("config");
    for (let i = 0; i < 25; i++) {
      env.clock.advance(60_000);
      await env.fireDue();
      await env.completeNavigation(7);
    }
    const rt = await env.runtime.get(7);
    expect(rt).toMatchObject({ status: "completed", reason: "Reached its time limit (20 min); the condition wasn't met" });
    expect(env.browser.notifications).toEqual([
      { title: "Monitoring stopped: Watch", message: "Reached its time limit (20 min) before the condition was met. Open the popup to start again." },
    ]);
  });

  it("plain timers that reach a limit end quietly", async () => {
    const env = createApiEnv();
    env.browser.addTab(7, "https://shop.test/item");
    await env.service.call(env.user, "createRule", {
      rule: { name: "Timer", target: { patterns: ["https://shop.test/item"] }, trigger: { type: "interval", seconds: 60 }, limits: { maxRefreshes: 2 } },
    });
    await env.engine.reconcileAll("config");
    for (let i = 0; i < 4; i++) {
      env.clock.advance(60_000);
      await env.fireDue();
      await env.completeNavigation(7);
    }
    expect((await env.runtime.get(7))?.status).toBe("completed");
    expect(env.browser.notifications).toEqual([]);
  });
});

describe("agents and query strings in rules", () => {
  it("hides query strings in other people's rules; an agent's own rules stay intact", async () => {
    const env = createApiEnv();
    await env.pairAgent("native:a");
    await env.service.call(env.user, "createRule", {
      rule: {
        id: "mine",
        name: "Order",
        target: { patterns: [{ type: "exact", value: "https://shop.test/order?id=42&email=a@b.test" }] },
        trigger: { type: "interval", seconds: 60 },
      },
    });
    await env.service.call(env.agent("native:a"), "createRule", {
      rule: {
        id: "agents",
        name: "Agent's",
        target: { patterns: [{ type: "exact", value: "https://x.test/?q=1" }] },
        trigger: { type: "interval", seconds: 60 },
      },
    });
    const seen = (await env.service.call(env.agent("native:a"), "listRules", undefined)) as { id: string; target: { patterns: unknown[] } }[];
    expect(seen.find((r) => r.id === "mine")!.target.patterns).toEqual([{ type: "exact", value: "https://shop.test/order?…" }]);
    expect(seen.find((r) => r.id === "agents")!.target.patterns).toEqual([{ type: "exact", value: "https://x.test/?q=1" }]);
    expect(((await env.service.call(env.agent("native:a"), "getRule", { id: "mine" })) as { target: { patterns: unknown[] } }).target.patterns).toEqual([
      { type: "exact", value: "https://shop.test/order?…" },
    ]);
    // The user always sees the real pattern; and redaction can be turned off.
    expect(
      ((await env.service.call(env.user, "getRule", { id: "mine" })) as { target: { patterns: { value: string }[] } }).target.patterns[0]!.value,
    ).toContain("id=42");
    await env.service.call(env.user, "updateSettings", { redactUrlsForAgents: false });
    const plain = (await env.service.call(env.agent("native:a"), "getRule", { id: "mine" })) as { target: { patterns: { value: string }[] } };
    expect(plain.target.patterns[0]!.value).toContain("id=42");
  });

  it("keeps regex quantifiers; only a literal \\? starts the hidden part", () => {
    expect(redactPattern("^https?://shop\\.test/orders/\\d+$")).toBe("^https?://shop\\.test/orders/\\d+$");
    expect(redactPattern({ type: "regex", value: "^https://a\\.test/x\\?id=\\d+" })).toEqual({ type: "regex", value: "^https://a\\.test/x\\?…" });
    expect(redactPattern("https://a.test/*?ref=*")).toEqual({ type: "glob", value: "https://a.test/*?…" });
    expect(redactPattern("example.com")).toBe("example.com");
  });
});

describe("Stop watching after (Settings)", () => {
  it("defaults to no limit and accepts a number of minutes or none", async () => {
    const env = createApiEnv();
    expect((await env.config.get()).settings.defaultStopAfterMinutes).toBeNull();
    await env.service.call(env.user, "updateSettings", { defaultStopAfterMinutes: 20 });
    expect((await env.config.get()).settings.defaultStopAfterMinutes).toBe(20);
    await env.service.call(env.user, "updateSettings", { defaultStopAfterMinutes: null });
    expect((await env.config.get()).settings.defaultStopAfterMinutes).toBeNull();
    await expect(env.service.call(env.user, "updateSettings", { defaultStopAfterMinutes: 0 })).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("timer reasons and rule precedence", () => {
  it("a plain timer that reaches a limit doesn't mention a condition", async () => {
    const env = createApiEnv();
    env.browser.addTab(7, "https://shop.test/item");
    await env.service.call(env.user, "createRule", {
      rule: { name: "Timer", target: { patterns: ["https://shop.test/item"] }, trigger: { type: "interval", seconds: 60 }, limits: { maxRefreshes: 1 } },
    });
    await env.engine.reconcileAll("config");
    for (let i = 0; i < 3; i++) {
      env.clock.advance(60_000);
      await env.fireDue();
      await env.completeNavigation(7);
    }
    expect((await env.runtime.get(7))?.reason).toBe("Reached maximum of 1 refreshes");
  });

  it("a rule created with priorityAbove the matching rules is the one that runs", async () => {
    const env = createApiEnv();
    env.browser.addTab(7, "https://shop.test/item");
    const base = { target: { patterns: ["https://shop.test/*"] }, trigger: { type: "interval", seconds: 60 } };
    await env.service.call(env.user, "createRule", { rule: { id: "old", name: "Older", priority: 2, ...base } });
    env.clock.advance(1000);
    const tie = (await env.service.call(env.user, "createRule", { rule: { id: "tie", name: "Same priority", priority: 2, ...base } })) as { id: string };
    const state1 = (await env.service.call(env.user, "getTabState", { tabId: 7 })) as {
      resolution: { controllerId: string; candidates: { priority: number }[] };
    };
    expect(state1.resolution.controllerId).toBe("old"); // a tie goes to the older rule: the original bug
    expect(tie.id).toBe("tie");
    const { priorityAbove } = await import("@/ui/popup/describe");
    await env.service.call(env.user, "createRule", { rule: { id: "new", name: "New", priority: priorityAbove(state1.resolution.candidates), ...base } });
    const state2 = (await env.service.call(env.user, "getTabState", { tabId: 7 })) as { resolution: { controllerId: string } };
    expect(state2.resolution.controllerId).toBe("new");
  });
});

describe("agent redaction: fragments and URL conditions", () => {
  it("hides #fragments and url.match patterns inside conditions too", async () => {
    const env = createApiEnv();
    await env.pairAgent("native:a");
    await env.service.call(env.user, "createRule", {
      rule: {
        id: "r",
        name: "R",
        target: { patterns: [{ type: "exact", value: "https://app.test/inbox#token=abc" }] },
        trigger: { type: "interval", seconds: 60 },
        stopWhen: { type: "all", conditions: [{ type: "url.match", pattern: { type: "exact", value: "https://app.test/done?order=9" } }] },
      },
    });
    const r = (await env.service.call(env.agent("native:a"), "getRule", { id: "r" })) as { target: { patterns: unknown[] }; stopWhen: unknown };
    expect(r.target.patterns).toEqual([{ type: "exact", value: "https://app.test/inbox#…" }]);
    expect(JSON.stringify(r.stopWhen)).not.toContain("order=9");
    expect(JSON.stringify(r.stopWhen)).toContain("https://app.test/done?…");
  });
});
