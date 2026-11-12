/** A page and its frames read as one page: conditions and typing protection (core/frames.ts). */
import { createEnv, quietActivity } from "../helpers/fake-env";
import { makeRule } from "../helpers/fixtures";
import { mergeActivity, mergeLeaf, mergeSelectorTests } from "@/core/frames";
import type { ConditionNode, EvaluationResult, Rule } from "@/core/types";

const URL = "https://erp.example.com/home";

async function setup(stopWhen: ConditionNode, top: string, ...frames: string[]) {
  const env = createEnv();
  const rule: Rule = makeRule({
    id: "r1",
    target: { patterns: ["https://erp.example.com/*"] },
    stopWhen,
    actions: { onMatched: [{ type: "stopRefresh" }], onNotMatched: [{ type: "refresh" }] },
  } as never);
  await env.config.update((c) => {
    c.rules[rule.id] = rule;
  });
  env.browser.addTab(1, URL);
  env.page.setHtml(1, top);
  env.page.setFrames(1, ...frames);
  await env.engine.syncTab(1);
  return env;
}

const check = async (stopWhen: ConditionNode, top: string, ...frames: string[]) => {
  const env = await setup(stopWhen, top, ...frames);
  await env.engine.runCycle(1, "manual");
  return (await env.runtime.get(1))?.lastEvaluation?.status;
};

const PANEL = `<div class="panel"><span id="state">Build failed</span></div>`;

describe("conditions over a page and its frames", () => {
  it("finds an element or text that is only inside a frame (an embedded dashboard)", async () => {
    expect(await check({ type: "dom.exists", selector: "#state" }, `<h1>ERP</h1>`, PANEL)).toBe("matched");
    expect(await check({ type: "dom.text", selector: "#state", operator: "contains", value: "failed" }, `<h1>ERP</h1>`, PANEL)).toBe("matched");
    expect(await check({ type: "dom.text", operator: "contains", value: "build failed" }, `<h1>ERP</h1>`, PANEL)).toBe("matched");
  });

  it("'missing' and 'doesn't contain' mean in no frame", async () => {
    expect(await check({ type: "dom.missing", selector: "#state" }, `<h1>ERP</h1>`, PANEL)).toBe("not_matched");
    expect(await check({ type: "dom.text", operator: "not_contains", value: "Build failed" }, `<h1>ERP</h1>`, PANEL)).toBe("not_matched");
    expect(await check({ type: "dom.text", operator: "not_contains", value: "Build passed" }, `<h1>ERP</h1>`, PANEL)).toBe("matched");
  });

  it("adds counts up across frames", async () => {
    expect(await check({ type: "dom.exists", selector: "li", minCount: 3 }, `<li>a</li>`, `<li>b</li><li>c</li>`)).toBe("matched");
    expect(await check({ type: "dom.exists", selector: "li", minCount: 4 }, `<li>a</li>`, `<li>b</li><li>c</li>`)).toBe("not_matched");
  });

  it("compares the first frame where the selector matches, the page first", async () => {
    const stopWhen = { type: "dom.text", selector: "#state", operator: "equals", value: "Running" } as ConditionNode;
    expect(await check(stopWhen, `<span id="state">Running</span>`, PANEL)).toBe("matched");
    expect(await check(stopWhen, `<p>none here</p>`, PANEL)).toBe("not_matched");
  });

  it("'content changed' on the whole page notices a change inside a frame", async () => {
    const env = await setup({ type: "dom.changed" }, `<h1>ERP</h1>`, `<p>Queue: 3</p>`);
    await env.engine.runCycle(1, "manual"); // remembers, then refreshes
    await env.completeNavigation(1);
    env.page.setFrames(1, `<p>Queue: 4</p>`);
    await env.engine.runCycle(1, "manual");
    expect((await env.runtime.get(1))?.lastEvaluation?.status).toBe("matched");
  });
});

describe("typing protection in frames", () => {
  it("waits while you type in a frame", async () => {
    const env = await setup({ type: "dom.exists", selector: "#never" }, `<h1>ERP</h1>`, `<input>`);
    env.page.frameActivity.set(1, [quietActivity({ editing: true, sinceKeyMs: 300, sinceInputMs: 300 })]);
    await env.engine.runCycle(1, "manual");
    expect(env.browser.reloads).toEqual([]);
    expect((await env.runtime.get(1))?.status).toMatch(/paused|postponed/);
  });

  it("protects unsaved changes in a frame", async () => {
    const env = await setup({ type: "dom.exists", selector: "#never" }, `<h1>ERP</h1>`, `<input>`);
    env.page.frameActivity.set(1, [quietActivity({ dirty: "dirty" })]);
    await env.engine.runCycle(1, "manual");
    expect(env.browser.reloads).toEqual([]);
  });
});

describe("merging rules", () => {
  const m = (count: number, status: "matched" | "not_matched" = count ? "matched" : "not_matched"): EvaluationResult => ({ status, details: { count } });
  const loading: EvaluationResult = { status: "unknown", code: "page_not_ready", reason: "Document is still loading" };

  it("leaves out a frame that is still loading, but not the page itself", () => {
    expect(mergeLeaf({ type: "dom.missing", selector: "#x" } as ConditionNode, [m(0, "matched"), loading]).status).toBe("matched");
    expect(mergeLeaf({ type: "dom.exists", selector: "#x" } as ConditionNode, [loading, m(1)])).toBe(loading);
  });

  it("reads other text comparisons on the whole page from the top frame only", () => {
    const leaf = { type: "dom.text", operator: "equals", value: "x" } as ConditionNode;
    expect(mergeLeaf(leaf, [m(1, "not_matched"), m(1, "matched")]).status).toBe("not_matched");
  });

  it("merges activity: any frame in use, the shortest times, the worst unsaved state, the top frame's form result", () => {
    const top = quietActivity({ sinceKeyMs: 9000, formResult: true });
    const frame = quietActivity({ sinceKeyMs: 200, editing: true, dirty: "unknown", formResult: false });
    expect(mergeActivity([top, frame])).toMatchObject({ sinceKeyMs: 200, editing: true, dirty: "unknown", formResult: true });
  });

  it("adds up selector tests", () => {
    const r = mergeSelectorTests([
      { ok: true as const, count: 1, samples: [{ tag: "a" }] },
      { ok: true as const, count: 2, samples: [{ tag: "b" }, { tag: "c" }] },
    ]);
    expect(r).toEqual({ ok: true, count: 3, samples: [{ tag: "a" }, { tag: "b" }, { tag: "c" }] });
  });
});
