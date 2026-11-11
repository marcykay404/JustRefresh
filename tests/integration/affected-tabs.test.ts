/**
 * After a change (an agent's or the user's), only the tabs it affects are
 * re-checked. The rest keep their state and get no storage write.
 */
import { createApiEnv } from "../helpers/api-env";
import { alarmName } from "@/core/rule-engine";

const rule = (id: string, host: string, seconds = 60) => ({
  id,
  name: id,
  target: { patterns: [`https://${host}/*`] },
  trigger: { type: "interval", seconds },
});

async function setup() {
  const env = createApiEnv();
  for (const [id, host] of [
    ["a", "a.test"],
    ["b", "b.test"],
    ["c", "c.test"],
  ] as const) {
    await env.service.call(env.user, "createRule", { rule: rule(id, host) });
    await env.service.call(env.user, "enableRule", { id });
  }
  env.browser.addTab(1, "https://a.test/1");
  env.browser.addTab(2, "https://b.test/2");
  env.browser.addTab(3, "https://c.test/3");
  env.browser.addTab(4, "https://elsewhere.test/");
  await env.engine.reconcileAll("wake");
  const writes: number[] = [];
  const put = env.runtime.put.bind(env.runtime);
  env.runtime.put = async (rt) => {
    writes.push(rt.tabId);
    return put(rt);
  };
  return { env, writes };
}

describe("re-checking only the tabs a change affects", () => {
  it("editing one rule touches only its tabs", async () => {
    const { env, writes } = await setup();
    const before = await env.runtime.get(2);
    await env.service.call(env.user, "updateRule", { id: "a", patch: { trigger: { type: "interval", seconds: 120 } } });
    expect([...new Set(writes)]).toEqual([1]);
    expect(await env.runtime.get(2)).toEqual(before);
    expect(env.alarms.alarms.get(alarmName(1))).toBe(env.clock.t + 120_000);
  });

  it("an agent's draft rule (switched off) touches nothing; approving it touches its tabs", async () => {
    const { env, writes } = await setup();
    await env.pairAgent();
    writes.length = 0;
    const created = (await env.service.call(env.agent(), "createRule", { rule: { ...rule("x", "b.test", 30), priority: 5 } })) as { id: string };
    expect(writes).toEqual([]);
    await env.service.call(env.user, "enableRule", { id: created.id });
    expect([...new Set(writes)]).toEqual([2]);
    expect((await env.runtime.get(2))?.controllerId).toBe(created.id);
  });

  it("deleting a rule, an exclusion, pausing all: each touches exactly the tabs it changes", async () => {
    const { env, writes } = await setup();
    await env.service.call(env.user, "deleteRule", { id: "c" });
    expect([...new Set(writes)]).toEqual([3]);
    expect((await env.runtime.get(3))?.status).toBe("idle");

    writes.length = 0;
    await env.service.call(env.user, "addExclusion", { pattern: "https://b.test/*" });
    expect([...new Set(writes)]).toEqual([2]);
    expect((await env.runtime.get(2))?.status).toBe("excluded");

    writes.length = 0;
    await env.service.call(env.user, "pauseAll", undefined);
    // Pausing outranks exclusions, so the excluded tab is affected too; tabs without a rule aren't.
    expect([...new Set(writes)].sort()).toEqual([1, 2]);
    expect((await env.runtime.get(1))?.status).toBe("paused_global");
  });

  it("a change that doesn't affect any tab writes nothing", async () => {
    const { env, writes } = await setup();
    await env.service.call(env.user, "createRule", { rule: rule("z", "nowhere.test") });
    await env.service.call(env.user, "enableRule", { id: "z" });
    await env.service.call(env.user, "updateSettings", { historyLimit: 300 });
    expect(writes).toEqual([]);
  });

  it("a wake with nothing changed writes nothing", async () => {
    const { env, writes } = await setup();
    await env.engine.reconcileAll("wake");
    expect(writes).toEqual([]);
  });
});

describe("changes made at the same time (review)", () => {
  it("a later change can't be overtaken by an earlier one stuck behind a busy tab", async () => {
    const env = createApiEnv();
    await env.service.call(env.user, "createRule", { rule: rule("a", "a.test") });
    await env.service.call(env.user, "enableRule", { id: "a" });
    env.browser.addTab(1, "https://a.test/1");
    env.browser.addTab(2, "https://a.test/2");
    await env.engine.reconcileAll("wake");

    // Tab 1 is busy (e.g. a page check in progress).
    let release!: () => void;
    const busy = (env.engine as unknown as { withLock: (id: number, fn: () => Promise<void>) => Promise<void> }).withLock(
      1,
      () => new Promise<void>((r) => (release = r)),
    );

    const first = env.service.call(env.user, "disableRule", { id: "a" });
    await new Promise((r) => setTimeout(r, 0));
    const second = (async () => {
      await env.service.call(env.user, "createRule", { rule: { ...rule("c", "a.test"), target: { patterns: ["https://a.test/2*"] } } });
      await env.service.call(env.user, "enableRule", { id: "c" });
    })();
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([busy, first, second]);

    expect(await env.runtime.get(2)).toMatchObject({ status: "scheduled", controllerId: "c" });
    expect(env.alarms.alarms.has(alarmName(2))).toBe(true);
  });
});
