/** Click, local webhook and keep-scroll actions, run by the engine against fake pages. */
import { createEnv, quietActivity } from "../helpers/fake-env";
import { makeRule } from "../helpers/fixtures";
import { validateRule } from "@/core/rule-schema";
import type { Rule } from "@/core/types";

const URL = "https://shop.example.com/item";
const PAGE = `<p id="stock">In stock</p>
  <button id="add" type="button">Add to cart</button>
  <form action="/order" method="post"><button id="buy">Buy now</button></form>`;

async function setup(rule: Rule, settings: Record<string, unknown> = {}) {
  const env = createEnv();
  await env.config.update((c) => {
    c.rules[rule.id] = rule;
    Object.assign(c.settings, settings);
  });
  env.browser.addTab(1, URL);
  env.page.setHtml(1, PAGE);
  await env.engine.syncTab(1);
  return env;
}

const whenInStock = (actions: unknown[]) =>
  makeRule({
    id: "r1",
    target: { patterns: ["https://shop.example.com/*"] },
    stopWhen: { type: "dom.exists", selector: "#stock" },
    actions: { onMatched: actions, onNotMatched: [{ type: "refresh" }] },
  } as never);

const history = async (env: ReturnType<typeof createEnv>) => {
  await new Promise((r) => setTimeout(r, 0)); // history writes are fire-and-forget
  return env.history.list();
};

describe("click action", () => {
  it("clicks the element when the condition matches, then stops", async () => {
    const env = await setup(whenInStock([{ type: "click", selector: "#add" }, { type: "stopRefresh" }]));
    let clicked = 0;
    env.page.docs
      .get(1)!
      .querySelector("#add")!
      .addEventListener("click", () => clicked++);
    await env.engine.runCycle(1, "manual");
    expect(env.page.clicks).toEqual([{ tabId: 1, selector: "#add" }]);
    expect(clicked).toBe(1);
    expect((await env.runtime.get(1))?.status).toBe("completed");
  });

  it("never clicks a button that would submit a form, and says why", async () => {
    const env = await setup(whenInStock([{ type: "click", selector: "#buy" }, { type: "stopRefresh" }]));
    await env.engine.runCycle(1, "manual");
    expect(env.page.clicks).toEqual([]);
    const entry = (await history(env)).find((h) => h.action === "click");
    expect(entry).toMatchObject({ outcome: "error" });
    expect(entry?.reason).toMatch(/submit a form/);
  });

  it("counts clicks toward the refresh limit, so a rule that only clicks stops too", async () => {
    const rule = whenInStock([{ type: "click", selector: "#add" }]);
    const env = await setup({ ...rule, limits: { maxRefreshes: 2 } });
    await env.engine.runCycle(1, "manual");
    await env.engine.runCycle(1, "manual");
    expect(env.page.clicks).toHaveLength(2);
    expect((await env.runtime.get(1))?.clickCount).toBe(2);
    await env.engine.runCycle(1, "alarm");
    expect(env.page.clicks).toHaveLength(2);
    const rt = await env.runtime.get(1);
    expect(rt?.status).toBe("completed");
    expect(rt?.reason).toMatch(/maximum of 2 refreshes and clicks/);
  });

  it("doesn't go over the limit within one list: a refresh after the last allowed click is skipped", async () => {
    const rule = whenInStock([{ type: "click", selector: "#add" }, { type: "refresh" }]);
    const env = await setup({ ...rule, limits: { maxRefreshes: 1 } });
    await env.engine.runCycle(1, "manual");
    expect(env.page.clicks).toHaveLength(1);
    expect(env.browser.reloads).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect((await env.history.list()).find((h) => h.action === "refresh")).toMatchObject({
      outcome: "skipped",
      reason: expect.stringMatching(/Not refreshed: Reached maximum/),
    });
  });

  it("page changes until the click's page has loaded are the click's; one you make after that starts a new run", async () => {
    const env = await setup(whenInStock([{ type: "click", selector: "#add" }]));
    await env.engine.runCycle(1, "manual");
    const generation = (await env.runtime.get(1))!.generation;
    env.browser.addTab(1, `${URL}?page=2`);
    await env.engine.onTabUpdated(1, { url: `${URL}?page=2` }); // the click's
    env.browser.addTab(1, `${URL}?page=2&sort=default`);
    await env.engine.onTabUpdated(1, { url: `${URL}?page=2&sort=default` }); // that page tidying its address
    expect((await env.runtime.get(1))?.generation).toBe(generation);
    expect((await env.runtime.get(1))?.clickCount).toBe(1);
    await env.engine.onTabUpdated(1, { status: "complete" });
    env.clock.advance(3000);
    env.browser.addTab(1, `${URL}?page=9`);
    await env.engine.onTabUpdated(1, { url: `${URL}?page=9` }); // yours
    const rt = (await env.runtime.get(1))!;
    expect(rt.generation).toBeGreaterThan(generation);
    expect(rt.clickCount ?? 0).toBe(0);
  });

  it("a page the click opens is part of the same run, so a 'next page' rule still stops at its limit", async () => {
    const rule = whenInStock([{ type: "click", selector: "#add" }]);
    const env = await setup({ ...rule, limits: { maxRefreshes: 2 } });
    for (const page of [2, 3]) {
      await env.engine.runCycle(1, "manual");
      // The click opened the next page.
      env.browser.addTab(1, `${URL}?page=${page}`);
      env.page.setHtml(1, PAGE);
      await env.engine.onTabUpdated(1, { url: `${URL}?page=${page}` });
    }
    await env.engine.runCycle(1, "alarm"); // the next check: limit reached
    const rt = await env.runtime.get(1);
    expect(env.page.clicks).toHaveLength(2);
    expect(rt?.clickCount).toBe(2);
    expect(rt?.status).toBe("completed");
  });

  it("waits while you type, like a refresh", async () => {
    const env = await setup(whenInStock([{ type: "click", selector: "#add" }, { type: "stopRefresh" }]));
    env.page.activityByTab.set(1, quietActivity({ editing: true, sinceKeyMs: 500, sinceInputMs: 500 }));
    await env.engine.runCycle(1, "manual");
    expect(env.page.clicks).toEqual([]);
    expect((await env.runtime.get(1))?.status).toMatch(/postponed|paused/);
  });

  it("reports a selector that matches nothing, without ending the run", async () => {
    const env = await setup(whenInStock([{ type: "click", selector: "#nope" }]));
    await env.engine.runCycle(1, "manual");
    expect((await history(env)).find((h) => h.action === "click")?.reason).toMatch(/Nothing on the page matches #nope/);
    expect((await env.runtime.get(1))?.status).toBe("scheduled");
  });

  it("isn't allowed on page-load triggers, where a click that loads a page would loop", () => {
    const v = validateRule({
      name: "x",
      target: { patterns: ["a.com"] },
      trigger: { type: "navigation" },
      stopWhen: { type: "dom.exists", selector: "#a" },
      actions: { onMatched: [{ type: "click", selector: "#a" }] },
    });
    expect(v.diagnostics.map((d) => d.code)).toContain("click_loop");
  });
});

describe("webhook action", () => {
  const hook = (extra = {}) => whenInStock([{ type: "webhook", url: "http://localhost:8123/hook", ...extra }, { type: "stopRefresh" }]);

  it("does nothing until webhooks are switched on in Settings", async () => {
    const env = await setup(hook());
    await env.engine.runCycle(1, "manual");
    expect(env.browser.posts).toEqual([]);
    expect((await history(env)).find((h) => h.action === "webhook")?.reason).toMatch(/switched off/);
    expect((await env.runtime.get(1))?.status).toBe("completed");
  });

  it("posts what happened, without the page address unless asked", async () => {
    const env = await setup(hook({ message: "In stock!" }), { allowWebhooks: true });
    await env.engine.runCycle(1, "manual");
    expect(env.browser.posts).toEqual([
      {
        url: "http://localhost:8123/hook",
        body: { source: "justrefresh", event: "matched", rule: { id: "r1", name: "r1" }, tab: { id: 1 }, message: "In stock!", at: expect.any(String) },
      },
    ]);
    const withUrl = await setup(hook({ includePageUrl: true }), { allowWebhooks: true });
    await withUrl.engine.runCycle(1, "manual");
    expect(withUrl.browser.posts[0]!.body).toMatchObject({ tab: { id: 1, url: URL } });
  });

  it("reports an unreachable program and carries on", async () => {
    const env = await setup(hook(), { allowWebhooks: true });
    env.browser.unreachable.add("http://localhost:8123/hook");
    await env.engine.runCycle(1, "manual");
    expect((await history(env)).find((h) => h.action === "webhook")).toMatchObject({ outcome: "error" });
    expect((await env.runtime.get(1))?.status).toBe("completed");
  });

  it("only accepts addresses on this computer", () => {
    const rule = (url: string) =>
      validateRule({
        name: "x",
        target: { patterns: ["a.com"] },
        trigger: { type: "interval", seconds: 60 },
        actions: { onNotMatched: [{ type: "webhook", url }] },
      });
    for (const url of ["http://localhost/x", "http://127.0.0.1:9000/", "https://[::1]:8443/hook", "http://localhost:3000"])
      expect(rule(url).valid, url).toBe(true);
    for (const url of ["https://example.com/hook", "http://localhost.evil.com/", "http://127.0.0.2/", "http://user@localhost/", "file:///tmp/x"]) {
      expect(rule(url).valid, url).toBe(false);
    }
  });
});

describe("keep the scroll position", () => {
  it("saves the position just before a refresh that asks for it", async () => {
    const rule = makeRule({
      id: "r1",
      target: { patterns: ["https://shop.example.com/*"] },
      actions: { onNotMatched: [{ type: "refresh", keepScroll: true }] },
    } as never);
    const env = await setup(rule);
    await env.engine.runCycle(1, "manual");
    expect(env.page.scrollSaves).toEqual([1]);
    expect(env.browser.reloads).toEqual([1]);
  });

  it("doesn't when the refresh doesn't ask", async () => {
    const env = await setup(makeRule({ id: "r1", target: { patterns: ["https://shop.example.com/*"] } }));
    await env.engine.runCycle(1, "manual");
    expect(env.page.scrollSaves).toEqual([]);
    expect(env.browser.reloads).toEqual([1]);
  });
});

describe("agents and page actions", () => {
  it("an agent can't add a webhook that sends page addresses while addresses are hidden from agents", async () => {
    const { createApiEnv } = await import("../helpers/api-env");
    const env = createApiEnv();
    await env.pairAgent();
    const rule = (includePageUrl: boolean) => ({
      name: "hook",
      target: { patterns: ["https://shop.example.com/*"] },
      trigger: { type: "interval", seconds: 60 },
      actions: { onNotMatched: [{ type: "webhook", url: "http://localhost:9000/x", includePageUrl }] },
    });
    await expect(env.service.call(env.agent(), "createRule", { rule: rule(true) })).rejects.toMatchObject({ code: "forbidden" });
    await expect(env.service.call(env.agent(), "createRule", { rule: rule(false) })).resolves.toMatchObject({ meta: { draft: true } });
    await env.service.call(env.user, "updateSettings", { redactUrlsForAgents: false });
    await expect(env.service.call(env.agent(), "createRule", { rule: rule(true) })).resolves.toBeDefined();
  });

  it("a click that doesn't happen says so in a notification, since the rule's later actions still run", async () => {
    const env = await setup(whenInStock([{ type: "click", selector: "#buy" }, { type: "stopRefresh" }]));
    await env.engine.runCycle(1, "manual");
    expect(env.browser.notifications).toEqual([{ title: "r1: couldn't click", message: expect.stringMatching(/submit a form/) }]);
  });
});
