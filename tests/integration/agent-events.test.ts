/**
 * Events back to agents (#27 phase 3): approval answers and what their rules
 * find, for the agent that owns them only, with no page text and page
 * addresses hidden as the user's settings say.
 */
import { createApiEnv } from "../helpers/api-env";
import { quietActivity } from "../helpers/fake-env";
import { makeRule } from "../helpers/fixtures";
import { ERROR_REPEAT_MS, MAX_WAITS_PER_AGENT } from "@/api/agent-events";
import { MAX_WAIT_SECONDS } from "@/api/methods/events";
import { UNKNOWN_STREAK_EVENT } from "@/core/rule-engine";
import type { AgentEvent, Rule } from "@/core/types";
import { AGENT_EVENTS_PER_AGENT } from "@/storage/repositories";

type Page = { events: AgentEvent[]; cursor: number; truncated: boolean; file?: boolean };

const TAB = 1203;
const ORDER = "http://127.0.0.1:8787/order";
const ORDER_RULE = {
  name: "Order shipped?",
  target: { patterns: [ORDER] },
  trigger: { type: "interval", seconds: 30 },
  stopWhen: { type: "dom.text", selector: "#status", operator: "contains", value: "Shipped" },
  actions: { onMatched: [{ type: "stopRefresh" }, { type: "notify", title: "Order shipped" }], onNotMatched: [{ type: "refresh" }] },
};

/** Let the engine's fire-and-forget event writes land. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

async function setup({ trusted = false, url = ORDER } = {}) {
  const env = createApiEnv();
  await env.pairAgent("native:claude", undefined, trusted);
  env.browser.addTab(TAB, url);
  env.page.setHtml(TAB, `<p id="status">Processing</p>`);
  const agent = env.agent("native:claude");
  const events = async (params: object = {}) => (await env.service.call(agent, "getEvents", params)) as Page;
  const kinds = async (params: object = {}) => (await events(params)).events.map((e) => e.kind);
  const create = async (rule: object = ORDER_RULE) => ((await env.service.call(agent, "createRule", { rule })) as Rule).id;
  /** One interval: check, refresh, and the page loads again. */
  const tick = async () => {
    env.clock.advance(30_000);
    await env.fireDue();
    if (env.browser.reloads.length) await env.completeNavigation(TAB);
    await settle();
  };
  return { env, agent, events, kinds, create, tick };
}

describe("approval events", () => {
  it("the agent hears the user's answer, and the cursor moves past it", async () => {
    const { env, agent, events, create } = await setup();
    const id = await create();
    const pending = (await env.service.call(agent, "enableRule", { id })) as { approvalId: string };
    expect((await events()).events).toEqual([]);

    await env.service.call(env.user, "resolveApproval", { id: pending.approvalId, approve: true });
    const page = await events();
    expect(page.events).toEqual([
      { seq: 1, at: expect.any(Number), kind: "approval.approved", ruleId: id, approvalId: pending.approvalId, approvalKind: "activate" },
    ]);
    expect(page.cursor).toBe(1);
    expect((await events({ since: page.cursor })).events).toEqual([]);
  });

  it("rejected, replaced, and withdrawn requests each say so once", async () => {
    const { env, agent, kinds, create } = await setup();
    const id = await create();
    const first = (await env.service.call(agent, "enableRule", { id })) as { approvalId: string };
    await env.service.call(env.user, "resolveApproval", { id: first.approvalId, approve: false });
    expect(await kinds()).toEqual(["approval.rejected"]);

    await env.service.call(agent, "enableRule", { id });
    await env.service.call(agent, "enableRule", { id }); // replaces the one before
    await env.service.call(agent, "disableRule", { id }); // withdraws the latest
    expect(await kinds()).toEqual(["approval.rejected", "approval.stale", "approval.stale"]);
  });

  it("an edit by the user while the request waits makes it stale", async () => {
    const { env, agent, kinds, create } = await setup();
    const id = await create();
    await env.service.call(agent, "enableRule", { id });
    await env.service.call(env.user, "updateRule", { id, patch: { priority: 3 } });
    expect(await kinds()).toEqual(["approval.stale"]);
  });
});

describe("rule events", () => {
  it("matched, then completed when the rule stops; quiet checks send nothing", async () => {
    const { env, agent, events, create, tick } = await setup({ trusted: true });
    const id = await create();
    await env.service.call(agent, "enableRule", { id });
    await tick();
    expect(env.browser.reloads).toEqual([TAB]);
    expect((await events()).events).toEqual([]);

    env.page.setHtml(TAB, `<p id="status">Shipped</p>`);
    await tick();
    const page = await events();
    expect(page.events.map((e) => e.kind)).toEqual(["rule.matched", "rule.completed"]);
    expect(page.events[1]).toMatchObject({ ruleId: id, tabId: TAB, url: ORDER, status: "completed", reason: "Stop condition matched" });
    // No page text: the event never carries what the page said.
    expect(JSON.stringify(page.events)).not.toMatch(/Shipped|Processing/);
  });

  it("a rule that keeps watching says matched once while it stays matched, and again after it stopped matching", async () => {
    const { env, agent, kinds, create, tick } = await setup({ trusted: true });
    const id = await create({ ...ORDER_RULE, actions: { onMatched: [{ type: "log", message: "still shipped" }], onNotMatched: [{ type: "refresh" }] } });
    await env.service.call(agent, "enableRule", { id });
    env.page.setHtml(TAB, `<p id="status">Shipped</p>`);
    for (let i = 0; i < 4; i++) await tick();
    expect(await kinds()).toEqual(["rule.matched"]);
    env.page.setHtml(TAB, `<p id="status">Returned</p>`);
    await tick();
    env.page.setHtml(TAB, `<p id="status">Shipped again</p>`);
    await tick();
    await tick();
    expect(await kinds()).toEqual(["rule.matched", "rule.matched"]);
  });

  it("a run checked in the same moment it started says matched once", async () => {
    const { env, agent, kinds, create, tick } = await setup({ trusted: true });
    const id = await create({ ...ORDER_RULE, actions: { onMatched: [{ type: "log", message: "still shipped" }], onNotMatched: [{ type: "refresh" }] } });
    env.page.setHtml(TAB, `<p id="status">Shipped</p>`);
    await env.service.call(agent, "enableRule", { id }); // starts the tab's run now
    await env.engine.runCycle(TAB, "manual"); // and checks it in the same millisecond
    await settle();
    await tick();
    expect(await kinds()).toEqual(["rule.matched"]);
  });

  it("a run started again (popup Restart) says matched again", async () => {
    const { env, agent, kinds, create, tick } = await setup({ trusted: true });
    const id = await create();
    await env.service.call(agent, "enableRule", { id });
    env.page.setHtml(TAB, `<p id="status">Shipped</p>`);
    await tick();
    expect(await kinds()).toEqual(["rule.matched", "rule.completed"]);
    env.clock.advance(1000);
    await env.service.call(env.user, "resumeTab", { tabId: TAB });
    await tick();
    expect(await kinds()).toEqual(["rule.matched", "rule.completed", "rule.matched", "rule.completed"]);
  });

  it("a rule that refreshes while matched says matched once, also across the checks right after each load", async () => {
    const { env, agent, kinds, create, tick } = await setup({ trusted: true });
    const id = await create({ ...ORDER_RULE, actions: { onMatched: [{ type: "refresh" }], onNotMatched: [{ type: "refresh" }] } });
    await env.service.call(agent, "enableRule", { id });
    env.page.setHtml(TAB, `<p id="status">Shipped</p>`);
    for (let i = 0; i < 3; i++) await tick();
    expect(env.browser.reloads.length).toBe(3);
    expect(await kinds({ kinds: ["rule.matched"] })).toEqual(["rule.matched"]);
  });

  it("also when the match is found right after the refresh loads, as in a real browser", async () => {
    const { env, agent, kinds, create } = await setup({ trusted: true });
    const id = await create();
    await env.service.call(agent, "enableRule", { id });
    env.clock.advance(30_000);
    await env.fireDue(); // still "Processing": refresh
    expect(env.browser.reloads).toEqual([TAB]);
    env.page.setHtml(TAB, `<p id="status">Shipped</p>`); // what the reload brings
    await env.completeNavigation(TAB);
    await settle();
    expect((await env.runtime.get(TAB))?.status).toBe("completed");
    expect(await kinds()).toEqual(["rule.matched", "rule.completed"]);
  });

  it(`a page that can't be read ${UNKNOWN_STREAK_EVENT} times in a row is reported, and giving up pauses the rule`, async () => {
    const { env, agent, kinds, create, tick } = await setup({ trusted: true });
    const id = await create();
    await env.service.call(agent, "enableRule", { id });
    env.page.unavailable.add(TAB);
    for (let i = 0; i < UNKNOWN_STREAK_EVENT; i++) await tick();
    expect(await kinds()).toEqual(["rule.unknown_streak"]);
    await tick(); // the 4th: past maxUnknownRetries (3)
    const all = (await env.service.call(agent, "getEvents", {})) as Page;
    expect(all.events.map((e) => e.kind)).toEqual(["rule.unknown_streak", "rule.paused"]);
    expect(all.events[0]).toMatchObject({ streak: UNKNOWN_STREAK_EVENT });
    expect(all.events[1]).toMatchObject({ status: "paused_unknown", reason: expect.stringMatching(/^Gave up after 4 checks/) });
  });

  it("a page reached by submitting a form pauses the rule and says so once", async () => {
    const { env, agent, events, create, tick } = await setup({ trusted: true });
    env.page.activityByTab.set(TAB, quietActivity({ formResult: true }));
    const id = await create();
    await env.service.call(agent, "enableRule", { id });
    await tick();
    await tick();
    expect(env.browser.reloads).toEqual([]);
    const page = await events();
    expect(page.events.map((e) => e.kind)).toEqual(["rule.paused"]);
    expect(page.events[0]).toMatchObject({ status: "paused_resubmit", tabId: TAB });
  });

  it("the same error on the same tab is reported again only after a while", async () => {
    const { env, agent, kinds, create, tick } = await setup({ trusted: true });
    const id = await create({ ...ORDER_RULE, actions: { onMatched: [{ type: "stopRefresh" }], onNotMatched: [{ type: "click", selector: "#missing" }] } });
    await env.service.call(agent, "enableRule", { id });
    await tick();
    await tick();
    expect(await kinds()).toEqual(["rule.error"]);
    env.clock.advance(ERROR_REPEAT_MS);
    await tick();
    expect(await kinds()).toEqual(["rule.error", "rule.error"]);
  });

  it("the user's rules send nothing", async () => {
    const { env, events, tick } = await setup();
    await env.service.call(env.user, "createRule", { rule: { ...ORDER_RULE, actions: { onMatched: [{ type: "stopRefresh" }] } } });
    env.page.setHtml(TAB, `<p id="status">Shipped</p>`);
    await tick();
    expect((await events()).events).toEqual([]);
    expect(((await env.service.call(env.user, "getEvents", {})) as Page).events).toEqual([]);
  });
});

describe("who hears what", () => {
  it("only the agent that owns the rule, while it may read status", async () => {
    const { env, agent, events, create } = await setup();
    await env.pairAgent("native:other");
    const id = await create();
    const pending = (await env.service.call(agent, "enableRule", { id })) as { approvalId: string };
    await env.service.call(env.user, "resolveApproval", { id: pending.approvalId, approve: false });
    expect(((await env.service.call(env.agent("native:other"), "getEvents", {})) as Page).events).toEqual([]);
    expect((await events()).events).toHaveLength(1);

    // Without status:read it can't ask, and nothing is kept for it meanwhile.
    await env.service.call(env.user, "updateAgent", { id: "native:claude", scopes: ["rules:read", "rules:write", "rules:activate"] });
    await expect(env.service.call(agent, "getEvents", {})).rejects.toMatchObject({ code: "forbidden" });
    await env.service.call(agent, "enableRule", { id });
    await env.service.call(agent, "disableRule", { id });
    expect(((await env.service.call(env.user, "getEvents", {})) as Page).events).toHaveLength(1);
  });

  it("page addresses are hidden as the user's settings say", async () => {
    const { env, agent, events, create, tick } = await setup({ trusted: true, url: `${ORDER}?id=42` });
    const id = await create({ ...ORDER_RULE, target: { patterns: [`${ORDER}*`] } });
    await env.service.call(agent, "enableRule", { id });
    env.page.setHtml(TAB, `<p id="status">Shipped</p>`);
    await tick();
    expect((await events()).events[0].url).toBe(`${ORDER}?…`);
    await env.service.call(env.user, "updateSettings", { redactUrlsForAgents: false });
    expect((await events()).events[0].url).toBe(`${ORDER}?id=42`);
  });

  it("addresses quoted in a reason are hidden too", async () => {
    const { env, events } = await setup();
    const rule = makeRule({ id: "r1" }, { origin: { type: "agent", agentId: "native:claude" } });
    const reasons = [
      [`Cannot access contents of url "${ORDER}?id=42#x". Retry.`, `Cannot access contents of url "${ORDER}?…". Retry.`],
      ["See https://en.wikipedia.org/wiki/Foo_(bar)?token=SECRET", "See https://en.wikipedia.org/wiki/Foo_(bar)?…"],
      ["At https://a.test/x?token=1, retrying", "At https://a.test/x?…, retrying"],
      ["(HTTPS://A.TEST/p?q=1)", "(HTTPS://A.TEST/p?…)"],
      ["file:///Users/me/report.html?x=1 and chrome-extension://abc/page.html#secret", "file:///Users/me/report.html?… and chrome-extension://abc/page.html#…"],
      ["Tab <https://a.test/x?y=1> at data:text/html,hi?x=1 or about:blank#z", "Tab <https://a.test/x?…> at data:text/html,hi?… or about:blank#…"],
      ["Retry at 12:30: net::ERR_FAILED", "Retry at 12:30: net::ERR_FAILED"],
    ];
    for (const [i, [reason]] of reasons.entries()) await env.events.rule({ kind: "rule.error", rule, tabId: i, url: ORDER, reason });
    expect((await events()).events.map((e) => e.reason)).toEqual(reasons.map(([, hidden]) => hidden));
  });

  it("requests settled by a call running at the same time, or dropped from the list while waiting, are reported", async () => {
    const { env, events } = await setup();
    const before = await env.config.get();
    const req = (id: string, status: "pending" | "approved") =>
      ({ id, kind: "activate", ruleId: "r1", ruleRevision: 1, agentId: "native:claude", createdAt: 1, status }) as const;
    // Made and approved while this call ran: not in the config it started from.
    await env.events.approvals({ ...before, approvals: [req("a-dropped", "pending")] }, { ...before, approvals: [req("a-new", "approved")] });
    expect((await events()).events.map((e) => [e.kind, e.approvalId])).toEqual([
      ["approval.approved", "a-new"],
      ["approval.stale", "a-dropped"],
    ]);
  });

  it("a removed agent's events are deleted with it", async () => {
    const { env, agent, create } = await setup();
    const id = await create();
    const pending = (await env.service.call(agent, "enableRule", { id })) as { approvalId: string };
    await env.service.call(env.user, "resolveApproval", { id: pending.approvalId, approve: false });
    await env.service.call(env.user, "removeAgent", { id: "native:claude" });
    expect(((await env.service.call(env.user, "getEvents", {})) as Page).events).toEqual([]);
  });
});

describe("getEvents", () => {
  it("waits for the next event, and returns empty when none comes in time", async () => {
    const { env, agent, events, create } = await setup();
    const id = await create();
    const pending = (await env.service.call(agent, "enableRule", { id })) as { approvalId: string };

    const started = Date.now();
    const waiting = events({ waitSec: 5 });
    await settle();
    await env.service.call(env.user, "resolveApproval", { id: pending.approvalId, approve: true });
    expect((await waiting).events.map((e) => e.kind)).toEqual(["approval.approved"]);
    expect(Date.now() - started).toBeLessThan(2000);

    const empty = await events({ since: 1, waitSec: 1 });
    expect(empty).toEqual({ events: [], cursor: 1, truncated: false });
  });

  it(`at most ${MAX_WAITS_PER_AGENT} waiting calls per agent: another lets the oldest return now`, async () => {
    const { env, agent, events, create } = await setup();
    const started = Date.now();
    const waits = Array.from({ length: MAX_WAITS_PER_AGENT }, () => events({ waitSec: 30 }));
    await settle();
    // A client that gave up on its calls and asks again isn't blocked by them.
    const third = events({ waitSec: 30 });
    expect(await waits[0]).toEqual({ events: [], cursor: 0, truncated: false, interrupted: true });
    expect(Date.now() - started).toBeLessThan(2000);
    // An event lets the rest return.
    const id = await create();
    await env.service.call(agent, "enableRule", { id });
    await env.service.call(agent, "disableRule", { id });
    for (const w of [waits[1], third]) expect((await w).events.map((e) => e.kind)).toEqual(["approval.stale"]);
  });

  it("a cursor from before the events were reset starts over, and says so", async () => {
    const { env, events } = await setup();
    const rule = makeRule({ id: "r1" }, { origin: { type: "agent", agentId: "native:claude" } });
    await env.events.rule({ kind: "rule.matched", rule, tabId: TAB, url: ORDER });
    expect(await events({ since: 500 })).toMatchObject({ events: [{ seq: 1 }], cursor: 1, truncated: true });
    expect(await events({ since: 500, kinds: ["rule.error"] })).toEqual({ events: [], cursor: 1, truncated: true });
    // Also when the call has to wait for the next one.
    const waiting = events({ since: 500, kinds: ["rule.error"], waitSec: 5 });
    await settle();
    await env.events.rule({ kind: "rule.error", rule, tabId: TAB, url: ORDER, reason: "click: no element" });
    expect(await waiting).toMatchObject({ events: [{ seq: 2, kind: "rule.error" }], cursor: 2, truncated: true });
  });

  it(`keeps the last ${AGENT_EVENTS_PER_AGENT} per agent and says when some were trimmed`, async () => {
    const { env, events } = await setup();
    const rule = makeRule({ id: "r1" }, { origin: { type: "agent", agentId: "native:claude" } });
    for (let i = 0; i < AGENT_EVENTS_PER_AGENT + 5; i++) await env.events.rule({ kind: "rule.matched", rule, tabId: TAB, url: ORDER });
    const page = await events({ since: 0 });
    expect(page.events).toHaveLength(AGENT_EVENTS_PER_AGENT);
    expect(page.events[0].seq).toBe(6);
    expect(page.truncated).toBe(true);
    expect((await events({ since: 5 })).truncated).toBe(false);
  });

  it("filters by rule and kind; says when the events file is on for a desktop agent", async () => {
    const { env, events } = await setup();
    const mine = (id: string) => makeRule({ id }, { origin: { type: "agent", agentId: "native:claude" } });
    await env.events.rule({ kind: "rule.matched", rule: mine("a"), tabId: TAB, url: ORDER });
    await env.events.rule({ kind: "rule.completed", rule: mine("b"), tabId: TAB, url: ORDER });
    expect((await events({ ruleId: "b" })).events.map((e) => e.ruleId)).toEqual(["b"]);
    expect((await events({ kinds: ["rule.matched"] })).events.map((e) => e.ruleId)).toEqual(["a"]);
    expect((await events()).file).toBeUndefined();
    await env.service.call(env.user, "updateSettings", { agentEventsFile: true });
    expect((await events()).file).toBe(true);
    await expect(events({ waitSec: MAX_WAIT_SECONDS + 1 })).rejects.toMatchObject({ code: "invalid_params" });
  });
});
