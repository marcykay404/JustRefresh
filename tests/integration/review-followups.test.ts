/**
 * Follow-ups from the competitive review: agent security defaults, fewer
 * config writes, alert sound, give-up notifications, and refreshing a tab
 * without site access only when the user chose to.
 */
import { createApiEnv } from "../helpers/api-env";
import { createEnv } from "../helpers/fake-env";
import { makeRule } from "../helpers/fixtures";
import { handleExternalMessage, RateLimiter } from "@/integrations/external-messaging";
import { exportBundle, parseImport } from "@/integrations/json-import";
import { defaultRegistries } from "@/registries";
import { DEFAULT_SAFETY } from "@/core/defaults";
import { AGENT_LAST_SEEN_RESOLUTION_MS } from "@/api/rule-api";

const EXT = "abcdefghijklmnopabcdefghijklmnop";
const pair = { protocol: "justrefresh-agent/1", method: "pair", name: "Some extension" };

describe("extension allowlist (agent messaging)", () => {
  it("rejects extensions that are not allowlisted before anything is recorded", async () => {
    const env = createApiEnv();
    const limiter = new RateLimiter(60, 60_000);
    const res = await handleExternalMessage(env.service, limiter, async () => false, EXT, pair);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(Object.keys((await env.config.get()).agents)).toEqual([]);
  });

  it("allowlisted extensions can request pairing (still pending user approval)", async () => {
    const env = createApiEnv();
    await env.service.call(env.user, "updateSettings", { allowedExtensionIds: [EXT] });
    const isAllowed = async (id: string) => (await env.config.get()).settings.allowedExtensionIds.includes(id);
    const res = await handleExternalMessage(env.service, new RateLimiter(60, 60_000), isAllowed, EXT, pair);
    expect(res).toMatchObject({ ok: true, result: { status: "pending", scopes: [] } });
    expect(await handleExternalMessage(env.service, new RateLimiter(60, 60_000), isAllowed, undefined, pair)).toMatchObject({ ok: false });
  });

  it("validates extension IDs and never exports or imports the allowlist", async () => {
    const env = createApiEnv();
    await expect(env.service.call(env.user, "updateSettings", { allowedExtensionIds: ["not-an-id"] })).rejects.toMatchObject({ code: "invalid_params" });
    await env.service.call(env.user, "updateSettings", { allowedExtensionIds: [EXT] });
    const bundle = exportBundle(await env.config.get(), { includeSettings: true, now: 0 });
    expect(JSON.stringify(bundle)).not.toContain(EXT);
    const crafted = JSON.stringify({ ...bundle, settings: { ...bundle.settings, allowedExtensionIds: [EXT], nativeBridgeEnabled: true } });
    const parsed = parseImport(crafted, { registries: defaultRegistries(), defaultSafety: DEFAULT_SAFETY, now: 0 });
    expect(parsed.settings).not.toHaveProperty("allowedExtensionIds");
    expect(parsed.settings).not.toHaveProperty("nativeBridgeEnabled");
  });
});

describe("agent lastSeenAt", () => {
  it("is written at most once per resolution window, not on every call", async () => {
    const env = createApiEnv();
    await env.pairAgent();
    const agent = env.agent();
    await env.service.call(agent, "listRules", undefined);
    const first = (await env.config.get()).agents["native:claude"].lastSeenAt;
    expect(first).toBe(env.clock.t);

    const updates = vi.spyOn(env.config, "update");
    env.clock.advance(5_000);
    await env.service.call(agent, "listRules", undefined);
    await env.service.call(agent, "listTabs", undefined);
    expect(updates).not.toHaveBeenCalled();
    expect((await env.config.get()).agents["native:claude"].lastSeenAt).toBe(first);

    env.clock.advance(AGENT_LAST_SEEN_RESOLUTION_MS);
    await env.service.call(agent, "listRules", undefined);
    expect((await env.config.get()).agents["native:claude"].lastSeenAt).toBe(env.clock.t);
  });
});

describe("notify action sound", () => {
  it("passes the sound option through to the browser", async () => {
    const env = createEnv();
    await env.config.update((c) => {
      c.rules.r = makeRule({
        id: "r",
        stopWhen: { type: "dom.exists", selector: "#ok" },
        actions: { onMatched: [{ type: "stopRefresh" }, { type: "notify", title: "Ready", sound: true }] },
      });
    });
    env.browser.addTab(1, "https://example.com/a");
    env.page.setHtml(1, `<div id="ok"></div>`);
    await env.engine.syncTab(1);
    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.notifications).toEqual([{ title: "Ready", message: "https://example.com/a", sound: true }]);
  });
});

describe("monitor stopping on unknown", () => {
  it("onUnknown=stop notifies", async () => {
    const env = createEnv();
    await env.config.update((c) => {
      c.rules.r = makeRule({ id: "r", name: "Stock", stopWhen: { type: "dom.exists", selector: "#x" }, safety: { onUnknown: "stop" } });
    });
    env.browser.addTab(1, "https://example.com/a");
    env.page.unavailable.add(1);
    await env.engine.syncTab(1);
    env.clock.advance(30_000);
    await env.fireDue();
    expect((await env.runtime.get(1))?.status).toBe("stopped");
    expect(env.browser.notifications.map((n) => n.title)).toEqual(["Monitoring stopped: Stock"]);
  });
});

describe("tab without site access", () => {
  it("by default pauses (safety), and refreshes only when started without protection", async () => {
    const env = createApiEnv();
    env.browser.addTab(7, "https://news.test/");
    env.page.unavailable.add(7); // no site access: activity cannot be observed

    await env.service.call(env.user, "startTab", { tabId: 7, intervalSeconds: 30 });
    env.clock.advance(30_000);
    await env.fireDue();
    expect((await env.runtime.get(7))?.status).toBe("paused_activity");
    expect(env.browser.reloads).toEqual([]);

    await env.service.call(env.user, "startTab", { tabId: 7, intervalSeconds: 30, safety: { onActivityUnavailable: "refresh" } });
    expect((await env.config.get()).tabOverrides["7"]).toMatchObject({ intervalSeconds: 30, safety: { onActivityUnavailable: "refresh" } });
    env.clock.advance(30_000);
    await env.fireDue();
    expect(env.browser.reloads).toEqual([7]);
  });
});
