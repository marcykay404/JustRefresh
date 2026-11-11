// @ts-nocheck — the bridge is plain ESM JavaScript.
import { createLineDecoder, createMcpHandler, createNativeDecoder, encodeNative, sanitizeClientId, TOOLS } from "../../bridge/lib.mjs";
import { createApiEnv } from "../helpers/api-env";
import { handleAgentMessage, RateLimiter } from "@/integrations/external-messaging";
import { SPEC_EXAMPLE } from "../helpers/fixtures";

describe("native messaging framing", () => {
  it("round-trips split chunks", () => {
    const out: unknown[] = [];
    const dec = createNativeDecoder((m: unknown) => out.push(m));
    const buf = Buffer.concat([encodeNative({ a: 1 }), encodeNative({ b: "ü" })]);
    for (let i = 0; i < buf.length; i += 3) dec(buf.subarray(i, i + 3));
    expect(out).toEqual([{ a: 1 }, { b: "ü" }]);
  });
  it("line decoder", () => {
    const out: unknown[] = [];
    const dec = createLineDecoder((m: unknown) => out.push(m));
    dec(Buffer.from('{"x":1}\n{"y"'));
    dec(Buffer.from(":2}\n"));
    expect(out).toEqual([{ x: 1 }, { y: 2 }]);
  });
  it("sanitizes client ids", () => expect(sanitizeClientId("Claude Desktop 2.0!")).toBe("claude-desktop-2.0-"));
});

describe("MCP handler → extension API (end to end, in memory)", () => {
  async function setup() {
    const env = createApiEnv();
    const limiter = new RateLimiter(1000, 60_000);
    const identity = { id: "native:claude", name: "Claude", transport: "native" as const };
    // Like the bridge: keep the key the extension issues and send it with every call.
    const agent = { key: undefined as string | undefined };
    const send = async (method: string, params?: unknown, name?: string) => {
      const res = (await handleAgentMessage(
        env.service,
        limiter,
        { ...identity, key: agent.key },
        { protocol: "justrefresh-agent/1", method, params, name },
      )) as {
        agentKey?: string;
      };
      if (res.agentKey) agent.key = res.agentKey;
      return res;
    };
    const handle = createMcpHandler({
      callApi: (method: string, params: unknown) => send(method, params),
      onInitialize: () => send("pair", undefined, "Claude"),
    });
    return { env, handle, agent, limiter, identity };
  }

  it("initialize pairs; tools are listed with strict schemas", async () => {
    const { env, handle } = await setup();
    const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "Claude" } } });
    expect(init.result.serverInfo.name).toBe("justrefresh");
    expect((await env.config.get()).agents["native:claude"].status).toBe("pending");
    const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t: { name: string }) => t.name));
    expect(list.result.tools.every((t: { inputSchema: { additionalProperties: boolean } }) => t.inputSchema.additionalProperties === false)).toBe(true);
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("unapproved agents get an actionable error", async () => {
    const { handle } = await setup();
    await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "refresh_list_rules", arguments: {} } });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/Agent Integrations/);
  });

  it("full agent workflow: validate → create draft → request activation", async () => {
    const { env, handle } = await setup();
    await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await env.service.call(env.user, "updateAgent", { id: "native:claude", status: "approved", scopes: ["rules:read", "rules:write", "rules:activate"] });
    const call = (name: string, args: unknown) => handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });
    expect(JSON.parse((await call("refresh_validate_rule", { rule: SPEC_EXAMPLE })).result.content[0].text).valid).toBe(true);
    const created = (await call("refresh_create_rule", { rule: SPEC_EXAMPLE })).result.structuredContent;
    expect(created.meta.draft).toBe(true);
    const en = (await call("refresh_enable_rule", { id: created.id })).result.structuredContent;
    expect(en.status).toBe("pending_approval");
    const bad = await call("refresh_get_rule", { id: created.id, sneaky: true });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toMatch(/Unknown argument/);
    const unknown = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "chrome_eval", arguments: {} } });
    expect(unknown.error.code).toBe(-32602);
  });
});

it("the installer registers the native host under the name the extension connects to", async () => {
  const { NATIVE_HOST } = await import("@/integrations/native-bridge");
  const { HOST } = await import("../../bridge/install-lib.mjs");
  expect(HOST).toBe(NATIVE_HOST);
});

describe("agent keys (desktop agents)", () => {
  const call = (env: ReturnType<typeof createApiEnv>, key?: string) =>
    handleAgentMessage(
      env.service,
      new RateLimiter(1000, 60_000),
      { id: "native:claude", name: "Claude", transport: "native", ...(key ? { key } : {}) },
      { protocol: "justrefresh-agent/1", method: "listRules" },
    ) as Promise<{ ok: boolean; agentKey?: string; error?: { code: string; message: string } }>;

  it("issues a key on the first call after approval, then requires it", async () => {
    const env = createApiEnv();
    await env.service.ensureAgent({ id: "native:claude", name: "Claude", transport: "native" });
    expect((await call(env)).agentKey).toBeUndefined(); // pending: nothing to bind yet
    await env.service.call(env.user, "updateAgent", { id: "native:claude", status: "approved", scopes: ["rules:read"] });
    const first = await call(env);
    expect(first.ok).toBe(true);
    expect(first.agentKey).toMatch(/^[0-9a-f]{64}$/);
    // Only a hash is stored.
    const stored = (await env.config.get()).agents["native:claude"]!.keyHash;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toBe(first.agentKey);
    expect(await call(env, first.agentKey)).toMatchObject({ ok: true });
    expect((await call(env, first.agentKey)).agentKey).toBeUndefined();
  });

  it("refuses another program using the same agent name, with or without a guessed key", async () => {
    const env = createApiEnv();
    await env.service.ensureAgent({ id: "native:claude", name: "Claude", transport: "native" });
    await env.service.call(env.user, "updateAgent", { id: "native:claude", status: "approved", scopes: ["rules:read"] });
    await call(env);
    for (const key of [undefined, "0".repeat(64)]) {
      const r = await call(env, key);
      expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(r.error!.message).toMatch(/key .* doesn't match/);
    }
  });

  it("starts over when the user removes the agent: the next approval issues a new key", async () => {
    const env = createApiEnv();
    await env.service.ensureAgent({ id: "native:claude", name: "Claude", transport: "native" });
    await env.service.call(env.user, "updateAgent", { id: "native:claude", status: "approved", scopes: ["rules:read"] });
    const old = (await call(env)).agentKey;
    await env.service.call(env.user, "removeAgent", { id: "native:claude" });
    await env.service.ensureAgent({ id: "native:claude", name: "Claude", transport: "native" });
    await env.service.call(env.user, "updateAgent", { id: "native:claude", status: "approved", scopes: ["rules:read"] });
    const fresh = await call(env, old);
    expect(fresh.ok).toBe(true);
    expect(fresh.agentKey).toBeDefined();
    expect(fresh.agentKey).not.toBe(old);
  });

  it("doesn't apply to extensions, which Chrome identifies", async () => {
    const env = createApiEnv();
    await env.service.ensureAgent({ id: "ext:abc", name: "Ext", transport: "extension", extensionId: "abc" });
    await env.service.call(env.user, "updateAgent", { id: "ext:abc", status: "approved", scopes: ["rules:read"] });
    const r = await handleAgentMessage(
      env.service,
      new RateLimiter(1000, 60_000),
      { id: "ext:abc", name: "Ext", transport: "extension", extensionId: "abc" },
      {
        protocol: "justrefresh-agent/1",
        method: "listRules",
      },
    );
    expect(r).toMatchObject({ ok: true });
    expect((r as { agentKey?: string }).agentKey).toBeUndefined();
  });
});
