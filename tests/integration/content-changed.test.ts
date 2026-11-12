/** "Content changed" and "text gone (after being seen)": conditions that remember the previous check. */
import { createApiEnv } from "../helpers/api-env";
import { makeRule } from "../helpers/fixtures";
import { evaluateConditionTree } from "@/core/evaluator";
import { evaluateDomCondition, fingerprint } from "@/conditions/dom-eval";
import { JSDOM } from "jsdom";
import type { ConditionNode, Rule } from "@/core/types";

const URL = "https://shop.example.com/item";

async function setup(rule: Rule, html: string) {
  const env = createApiEnv();
  await env.config.update((c) => {
    c.rules[rule.id] = rule;
  });
  env.browser.addTab(1, URL);
  env.page.setHtml(1, html);
  await env.engine.syncTab(1);
  return env;
}

/** Checks only (no refresh), so each manual run looks at the page as set. */
const watch = (stopWhen: ConditionNode, onMatched: unknown[] = [{ type: "notify", title: "Changed", message: "x" }], onNotMatched: unknown[] = []) =>
  makeRule({
    id: "r1",
    target: { patterns: ["https://shop.example.com/*"] },
    stopWhen,
    actions: { onMatched, onNotMatched },
  } as never);

const lastStatus = async (env: ReturnType<typeof createApiEnv>) => (await env.runtime.get(1))?.lastEvaluation?.status;

describe("dom.changed", () => {
  it("remembers the first check, then matches once per change", async () => {
    const env = await setup(watch({ type: "dom.changed", selector: "#price" }), `<p id="price">S$ 30</p><p id="ad">Ad 1</p>`);
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("not_matched"); // first check: nothing to compare with
    env.page.setHtml(1, `<p id="price">S$ 30</p><p id="ad">Ad 2</p>`); // outside the selector
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("not_matched");
    env.page.setHtml(1, `<p id="price">S$  25 </p>`);
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("matched");
    expect(env.browser.notifications.map((n) => n.title)).toEqual(["Changed"]);
    await env.engine.runCycle(1, "manual"); // same as last time: no second alert
    expect(await lastStatus(env)).toBe("not_matched");
    expect(env.browser.notifications).toHaveLength(1);
  });

  it("compares the reloaded page at the next check, once it has settled", async () => {
    const env = await setup(watch({ type: "dom.changed", selector: "#price" }, undefined, [{ type: "refresh" }]), `<p id="price">S$ 30</p>`);
    // Right after loading, a page that renders later still shows a placeholder.
    env.browser.onReload = () => env.page.setHtml(1, `<p id="price">Loading…</p>`);
    await env.engine.runCycle(1, "manual"); // remembers S$ 30, then refreshes
    expect(env.browser.reloads).toEqual([1]);
    await env.completeNavigation(1);
    expect(await lastStatus(env)).toBe("not_matched"); // not compared just after the load
    env.page.setHtml(1, `<p id="price">S$ 30</p>`); // rendered: the same as before
    env.browser.onReload = () => env.page.setHtml(1, `<p id="price">S$ 25</p>`);
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("not_matched");
    await env.completeNavigation(1);
    await env.engine.runCycle(1, "manual"); // the next check sees S$ 25
    expect(await lastStatus(env)).toBe("matched");
    expect(env.browser.notifications.map((n) => n.title)).toEqual(["Changed"]);
  });

  it("starting a finished run again forgets what the old run saw", async () => {
    const env = await setup(watch({ type: "dom.changed", selector: "#price" }, [{ type: "stopRefresh" }]), `<p id="price">A</p>`);
    await env.engine.runCycle(1, "manual");
    env.page.setHtml(1, `<p id="price">B</p>`);
    await env.engine.runCycle(1, "manual");
    expect((await env.runtime.get(1))?.status).toBe("completed");
    env.page.setHtml(1, `<p id="price">C</p>`);
    await env.engine.setTabStatus(1, "scheduled", "Started");
    expect((await env.runtime.get(1))?.memory).toBeUndefined();
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("not_matched"); // the first check of the new run
    // Run now on a finished run restarts it the same way.
    env.page.setHtml(1, `<p id="price">D</p>`);
    await env.engine.runCycle(1, "manual");
    expect((await env.runtime.get(1))?.status).toBe("completed");
    env.page.setHtml(1, `<p id="price">E</p>`);
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("not_matched");
  });

  it("ignores whitespace-only differences", async () => {
    const env = await setup(watch({ type: "dom.changed", selector: "#price" }), `<p id="price">S$ 30</p>`);
    await env.engine.runCycle(1, "manual");
    env.page.setHtml(1, `<p id="price">\n  S$   30\n</p>`);
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("not_matched");
  });

  it("an element that isn't there changes nothing, and keeps what was seen", async () => {
    const env = await setup(watch({ type: "dom.changed", selector: "#price" }), `<p id="price">S$ 30</p>`);
    await env.engine.runCycle(1, "manual");
    env.page.setHtml(1, `<p>Error 502</p>`);
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("not_matched");
    env.page.setHtml(1, `<p id="price">S$ 30</p>`);
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("not_matched"); // back as it was: not a change
  });

  it("a page that couldn't be checked doesn't overwrite what was seen", async () => {
    const env = await setup(watch({ type: "dom.changed", selector: "#price" }), `<p id="price">S$ 30</p>`);
    await env.engine.runCycle(1, "manual");
    const before = (await env.runtime.get(1))?.memory;
    env.page.unavailable.add(1);
    await env.engine.runCycle(1, "manual");
    expect((await env.runtime.get(1))?.memory).toEqual(before);
  });

  it("starts over when the rule is edited (a new run)", async () => {
    const rule = watch({ type: "dom.changed", selector: "#price" });
    const env = await setup(rule, `<p id="price">S$ 30</p>`);
    await env.engine.runCycle(1, "manual");
    expect((await env.runtime.get(1))?.memory).toBeDefined();
    await env.config.update((c) => {
      c.rules.r1 = { ...rule, meta: { ...rule.meta, revision: rule.meta.revision + 1 } };
    });
    await env.engine.syncTab(1);
    expect((await env.runtime.get(1))?.memory).toBeUndefined();
    env.page.setHtml(1, `<p id="price">S$ 25</p>`);
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("not_matched"); // first check of the new run
  });

  it("keeps the page text itself out of the run and the API", async () => {
    const env = await setup(watch({ type: "dom.changed", selector: "#price" }), `<p id="price">secret-order-12345</p>`);
    await env.engine.runCycle(1, "manual");
    const rt = await env.runtime.get(1);
    expect(JSON.stringify(rt)).not.toContain("secret-order");
    expect(rt?.memory).toEqual({ "0:dom.changed": fingerprint("secret-order-12345"), "@page": URL });
    const state = (await env.service.call(env.user, "getTabState", { tabId: 1 })) as { runtime: Record<string, unknown> };
    expect(state.runtime).not.toHaveProperty("memory");
  });

  it("remembers each stateful condition separately, by its place in the rule", async () => {
    const out1 = await evaluateTree(`<p id="a">1</p><p id="b">1</p>`, {});
    const out2 = await evaluateTree(`<p id="a">2</p><p id="b">1</p>`, out1.memory);
    expect(Object.keys(out1.memory)).toHaveLength(2);
    expect(out2.trace.children?.map((c) => c.result.status)).toEqual(["matched", "not_matched"]);
  });
});

async function evaluateTree(html: string, memory: Record<string, string>) {
  const doc = new JSDOM(html).window.document;
  const root = {
    type: "any",
    conditions: [
      { type: "dom.changed", selector: "#a" },
      { type: "dom.changed", selector: "#b" },
    ],
  } as ConditionNode;
  return evaluateConditionTree(root, {
    now: 0,
    tab: { id: 1, url: URL },
    runtime: { refreshCount: 0, navigationCount: 0, startedAt: 0 },
    pageEvaluator: async (leaves) => leaves.map((l) => evaluateDomCondition(l, doc, { includeText: false })),
    memory,
  });
}

describe("dom.text_lost", () => {
  const lost = { type: "dom.text_lost", value: "Sold out" } as ConditionNode;

  it("never matches a page that hasn't shown the text (a login page, a typo)", async () => {
    const env = await setup(watch(lost), `<p>Please sign in</p>`);
    await env.engine.runCycle(1, "manual");
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("not_matched");
  });

  it("matches once the text it saw is gone, and must see it again to match again", async () => {
    const env = await setup(watch(lost), `<p>Status: SOLD OUT</p>`);
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("not_matched");
    env.page.setHtml(1, `<p>Status: available</p>`);
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("matched");
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("not_matched");
  });

  it("a refresh that lands on another page (a login redirect) isn't 'gone', and the watched page is compared when it's back", async () => {
    const env = await setup(watch(lost, undefined, [{ type: "refresh" }]), `<p>Sold out</p>`);
    await env.engine.runCycle(1, "manual"); // seen, then refreshes
    env.browser.addTab(1, "https://shop.example.com/login?next=/item");
    env.page.setHtml(1, `<p>Please sign in</p>`);
    await env.completeNavigation(1);
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("not_matched");
    expect(env.browser.notifications).toEqual([]);
    expect((await env.runtime.get(1))?.memory?.["@page"]).toBe(URL); // still the watched page's
    expect((await env.runtime.get(1))?.controllerId).toBe("r1");
  });

  it("counts an element that was removed as the text being gone", async () => {
    const env = await setup(watch({ ...lost, selector: ".badge" } as ConditionNode), `<span class="badge">Sold out</span>`);
    await env.engine.runCycle(1, "manual");
    env.page.setHtml(1, `<button>Add to cart</button>`);
    await env.engine.runCycle(1, "manual");
    expect(await lastStatus(env)).toBe("matched");
  });
});

describe("highlight action", () => {
  it("highlights the text that was found, and runs after the rule stops", async () => {
    const rule = watch({ type: "dom.text", operator: "contains", value: "In stock" } as ConditionNode, [
      { type: "stopRefresh" },
      { type: "highlight", text: "in STOCK" },
    ]);
    const env = await setup(rule, `<p>Now <b>in</b> stock</p>`);
    await env.engine.runCycle(1, "manual");
    expect(env.page.highlights).toEqual([{ tabId: 1, text: "in STOCK" }]);
    expect((await env.runtime.get(1))?.status).toBe("completed");
  });

  it("reports text it can't find, without ending the run", async () => {
    const rule = watch({ type: "dom.exists", selector: "p" } as ConditionNode, [{ type: "highlight", text: "nowhere" }]);
    const env = await setup(rule, `<p>Hello</p>`);
    await env.engine.runCycle(1, "manual");
    await new Promise((r) => setTimeout(r, 0));
    const entry = (await env.history.list()).find((h) => h.action === "highlight");
    expect(entry).toMatchObject({ outcome: "error" });
    expect(entry?.reason).toMatch(/isn't on the page/);
    expect((await env.runtime.get(1))?.status).toBe("scheduled");
  });
});
