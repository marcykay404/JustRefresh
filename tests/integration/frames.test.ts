/** A page and its frames read as one page: conditions and typing protection (core/frames.ts). */
import { createEnv, quietActivity } from "../helpers/fake-env";
import { makeRule } from "../helpers/fixtures";
import { mergeActivity, mergeFrames, mergeLeaf, mergeSelectorTests, siteOf } from "@/core/frames";
import type { ConditionNode, EvaluationResult, Rule } from "@/core/types";
import { fingerprint } from "@/conditions/dom-eval";

const URL = "https://erp.example.com/home";

async function setup(stopWhen: ConditionNode, top: string, ...frames: (string | null)[]) {
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

const check = async (stopWhen: ConditionNode, top: string, ...frames: (string | null)[]) => {
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

describe("a frame that can't be read yet (still loading) never makes a condition match by what it might lack", () => {
  /** Checked once: did it match, and did the rule carry on without treating the page as broken? */
  const once = async (stopWhen: ConditionNode, top: string, ...frames: (string | null)[]) => {
    const env = await setup(stopWhen, top, ...frames);
    await env.engine.runCycle(1, "manual");
    const rt = (await env.runtime.get(1))!;
    return { matched: rt.lastEvaluation?.status === "matched", status: rt.status, streak: rt.unknownStreak, reason: rt.lastEvaluation?.reason ?? "" };
  };
  const notYet = { matched: false, status: "refreshing", streak: 0 };

  it("'missing', 'doesn't contain' and 'too few' wait for every frame, without pausing the rule", async () => {
    for (const stopWhen of [
      { type: "dom.missing", selector: "#state" },
      { type: "dom.text", operator: "not_contains", value: "Build running" },
      { type: "dom.exists", selector: "li", minCount: 2 },
    ] as ConditionNode[]) {
      const r = await once(stopWhen, `<li>a</li>`, null);
      expect(r).toMatchObject(notYet);
      expect(r.reason).toMatch(/frame on the page couldn't be read yet/);
    }
  });

  it("NOT around any of them doesn't match either", async () => {
    for (const inner of [
      { type: "dom.missing", selector: "#state" },
      { type: "dom.exists", selector: "#state" },
      { type: "dom.text", operator: "contains", value: "Sold out" },
      { type: "dom.text", operator: "not_contains", value: "Sold out" },
    ] as ConditionNode[]) {
      expect(await once({ type: "not", condition: inner } as ConditionNode, `<h1>ERP</h1>`, null)).toMatchObject(notYet);
      expect(await once({ type: "not", condition: { type: "any", conditions: [inner] } } as ConditionNode, `<h1>ERP</h1>`, null)).toMatchObject(notYet);
    }
  });

  it("but what was found in a frame that was read still counts", async () => {
    expect((await once({ type: "dom.exists", selector: "#state" }, `<h1>ERP</h1>`, PANEL, null)).matched).toBe(true);
    expect((await once({ type: "dom.text", operator: "contains", value: "build failed" }, `<h1>ERP</h1>`, null, PANEL)).matched).toBe(true);
    expect((await once({ type: "dom.missing", selector: "#state" }, `<h1>ERP</h1>`, PANEL, null)).matched).toBe(false);
  });

  it("a frame that never becomes readable counts as a problem after a few checks, so the rule doesn't wait unseen", async () => {
    const env = await setup({ type: "dom.missing", selector: "#spinner" }, `<h1>ERP</h1>`, null);
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++) {
      await env.engine.runCycle(1, "manual");
      const rt = (await env.runtime.get(1))!;
      statuses.push(rt.status);
      if (rt.pendingReload) await env.completeNavigation(1);
    }
    expect(statuses).toEqual(["refreshing", "refreshing", "refreshing", "paused_unknown"]);
    expect((await env.runtime.get(1))?.reason).toMatch(/couldn't be read yet/);
  });

  it("a frame read again resets the wait", async () => {
    const env = await setup({ type: "dom.missing", selector: "#spinner" }, `<h1>ERP</h1>`, `<p id="spinner"></p>`);
    for (const frame of [null, null, `<p id="spinner"></p>`, null, null, null]) {
      env.page.setFrames(1, frame);
      await env.engine.runCycle(1, "manual");
      if ((await env.runtime.get(1))?.pendingReload) await env.completeNavigation(1);
    }
    expect((await env.runtime.get(1))?.status).not.toBe("paused_unknown");
  });

  it("a real problem with the page alongside still gets the rule's unknown policy", async () => {
    const r = await once(
      {
        type: "all",
        conditions: [
          { type: "dom.missing", selector: "#state" },
          { type: "dom.exists", selector: "[" },
        ],
      } as ConditionNode,
      `<h1>ERP</h1>`,
      null,
    );
    expect(r.status).toBe("paused_unknown");
  });

  it("'text gone' isn't gone while the frame that showed it reloads, and still is once it's really gone", async () => {
    const env = await setup({ type: "dom.text_lost", value: "Build running" }, `<h1>ERP</h1>`, `<p>Build running</p>`);
    const status = async () => {
      await env.engine.runCycle(1, "manual");
      await env.completeNavigation(1);
      await env.engine.runCycle(1, "manual");
      return (await env.runtime.get(1))?.lastEvaluation?.status;
    };
    expect(await status()).toBe("not_matched"); // seen
    env.page.setFrames(1, null); // the panel reloads itself
    expect(await status()).toBe("unknown");
    env.page.setFrames(1, `<p>Build passed</p>`);
    expect(await status()).toBe("matched");
  });

  it("'content changed' neither compares nor forgets while a frame can't be read", async () => {
    const env = await setup({ type: "dom.changed" }, `<h1>ERP</h1>`, `<p>Queue: 3</p>`);
    await env.engine.runCycle(1, "manual");
    await env.completeNavigation(1);
    const remembered = (await env.runtime.get(1))?.memory;
    env.page.setFrames(1, null);
    await env.engine.runCycle(1, "manual");
    expect((await env.runtime.get(1))?.lastEvaluation?.status).toBe("unknown");
    expect((await env.runtime.get(1))?.memory).toEqual(remembered);
    env.page.setFrames(1, `<p>Queue: 3</p>`);
    await env.completeNavigation(1); // that check still refreshed
    await env.engine.runCycle(1, "manual");
    expect((await env.runtime.get(1))?.lastEvaluation?.status).toBe("not_matched"); // as before: no change
  });

  it("'content changed' ignores an empty frame coming and going", async () => {
    const env = await setup({ type: "dom.changed" }, `<h1>ERP</h1>`, `<p>Queue: 3</p>`);
    await env.engine.runCycle(1, "manual");
    await env.completeNavigation(1);
    env.page.setFrames(1, `<p>Queue: 3</p>`, ``);
    await env.engine.runCycle(1, "manual");
    expect((await env.runtime.get(1))?.lastEvaluation?.status).toBe("not_matched");
  });

  it("'doesn't contain' isn't blocked by a frame with no body (an SVG)", () => {
    const leaf = { type: "dom.text", operator: "not_contains", value: "Sold out" } as ConditionNode;
    const noBody: EvaluationResult = { status: "not_matched", details: { count: 0, note: "Element not found" } };
    expect(mergeLeaf(leaf, [{ status: "matched", details: { count: 1 } }, noBody]).status).toBe("matched");
  });

  it("frames that couldn't be asked at all count as not read, when the page has frames", () => {
    const leaves = [{ type: "dom.missing", selector: "#state" }] as ConditionNode[];
    const top: EvaluationResult[] = [{ status: "matched", details: { count: 0 } }];
    expect(mergeFrames(leaves, [top, null])[0]).toMatchObject({ status: "unknown", code: "frame_not_ready" });
    expect(mergeFrames(leaves, [top])[0]!.status).toBe("matched");
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

  it("a frame that was read but can't be checked (a real error) isn't passed off as loading", () => {
    const broken: EvaluationResult = { status: "unknown", code: "evaluation_error", reason: "boom" };
    expect(mergeLeaf({ type: "dom.missing", selector: "#x" } as ConditionNode, [m(0, "matched"), broken])).toBe(broken);
  });

  it("the page's own problems are the result's", () => {
    expect(mergeLeaf({ type: "dom.exists", selector: "#x" } as ConditionNode, [loading, m(1)])).toBe(loading);
  });

  it("fingerprints the whole page the same way however many frames there are", () => {
    const leaf = { type: "dom.changed" } as ConditionNode;
    const page = (prints: string[]) => prints.map((f) => [{ status: "not_matched", details: { count: 1, fingerprint: f } } as EvaluationResult]);
    const alone = mergeFrames([leaf], page(["abc"]))[0]!;
    expect(alone.status !== "unknown" && alone.details?.fingerprint).not.toBe("abc");
    const withFrame = mergeFrames([leaf], page(["abc", "def"]))[0]!;
    expect(withFrame).not.toEqual(alone);
    // An empty frame (a helper) coming or going isn't a change.
    const withEmpty = mergeFrames([leaf], [...page(["abc"]), [{ status: "not_matched", details: { count: 1, fingerprint: fingerprint("") } }]])[0]!;
    expect(withEmpty).toEqual(alone);
  });

  it("tells sites apart roughly, without a suffix list", () => {
    expect(siteOf("grafana.corp.example.com")).toBe("example.com");
    expect(siteOf("erp.example.com.sg")).toBe("example.com.sg");
    expect(siteOf("shop.example.co.uk")).toBe("example.co.uk");
    expect(siteOf("ads.adnetwork.net")).not.toBe(siteOf("www.example.com"));
    expect(siteOf("127.0.0.1")).toBe("127.0.0.1");
    expect(siteOf("localhost")).toBe("localhost");
  });

  it("counts monitoring time from a frame you're editing in (it may have just been given access)", () => {
    const top = quietActivity({ monitoringForMs: 600_000 });
    const frame = quietActivity({ monitoringForMs: 1_000, editing: true });
    expect(mergeActivity([top, frame])?.monitoringForMs).toBe(1_000);
    expect(mergeActivity([top, quietActivity({ monitoringForMs: 1_000 })])?.monitoringForMs).toBe(600_000);
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

describe("telling 'only frames loading' from real problems", () => {
  const leaf = (status: EvaluationResult) => ({ type: "x", result: status });
  const frame: EvaluationResult = { status: "unknown", code: "frame_not_ready", reason: "loading" };
  const real: EvaluationResult = { status: "unknown", code: "invalid_selector", reason: "bad" };

  it("a part that resolved anyway doesn't count", async () => {
    const { onlyFramesNotReady } = await import("@/core/evaluator");
    const trace = {
      type: "any",
      result: frame,
      children: [{ type: "all", result: { status: "not_matched" } as EvaluationResult, children: [leaf({ status: "not_matched" }), leaf(real)] }, leaf(frame)],
    };
    expect(onlyFramesNotReady(trace)).toBe(true);
    expect(onlyFramesNotReady({ type: "any", result: frame, children: [leaf(real), leaf(frame)] })).toBe(false);
  });
});
