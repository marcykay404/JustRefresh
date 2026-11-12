// @ts-nocheck — the bridge is plain ESM JavaScript.
import {
  createLineDecoder,
  createMcpHandler,
  createNativeDecoder,
  encodeNative,
  INSTRUCTIONS,
  sanitizeClientId,
  STRUCTURED_MAX_BYTES,
  TOOLS,
} from "../../bridge/lib.mjs";
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

describe("MCP self-description", () => {
  it("every tool has a title and annotations that match what its API method does", () => {
    const methods = (createApiEnv().service as unknown as { methods: Record<string, { scope: string | null; mutates?: boolean }> }).methods;
    for (const t of TOOLS) {
      const def = methods[t.method];
      expect(def, t.method).toBeDefined();
      expect(def.scope, `${t.method} must be callable by agents`).not.toBeNull();
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.annotations.title).toBe(t.title);
      expect(typeof t.annotations.openWorldHint).toBe("boolean");
      // A tool says it's read-only exactly when its method changes nothing.
      expect(t.annotations.readOnlyHint, t.name).toBe(!def.mutates);
      if (def.mutates) expect(typeof t.annotations.destructiveHint, t.name).toBe("boolean");
    }
    const hint = (name: string) => TOOLS.find((t) => t.name === name).annotations;
    // Enabling can take effect at once (trusted agents), and a live rule acts on websites.
    for (const name of ["refresh_update_rule", "refresh_delete_rule", "refresh_disable_rule", "refresh_enable_rule"])
      expect(hint(name).destructiveHint, name).toBe(true);
    expect(hint("refresh_create_rule").destructiveHint).toBe(false);
    // Tab titles come from web pages; enabled rules act on them.
    for (const name of ["refresh_list_tabs", "refresh_test_rule", "refresh_enable_rule", "refresh_get_status", "refresh_get_history"]) {
      expect(hint(name).openWorldHint, name).toBe(true);
    }
    expect(hint("refresh_enable_rule").idempotentHint).toBe(false);
  });

  it("tools/list sends titles and annotations", async () => {
    const handle = createMcpHandler({ callApi: async () => ({ ok: true, result: {} }) });
    const { tools } = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result;
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.annotations, t.name).toBeTruthy();
      expect(t.method).toBeUndefined();
    }
  });

  it("tool descriptions warn about what agents wouldn't expect", () => {
    const desc = (name: string) => TOOLS.find((t) => t.name === name).description;
    expect(desc("refresh_update_rule")).toMatch(/turns the rule OFF/);
    expect(desc("refresh_enable_rule")).toMatch(/pending_approval/);
    expect(desc("refresh_enable_rule")).toMatch(/Agent Integrations/);
    expect(desc("refresh_test_rule")).toMatch(/dom\.exists/);
    expect(desc("refresh_test_rule")).toMatch(/not false/);
    expect(desc("refresh_test_rule")).toMatch(/invalid_selector/);
    expect(desc("refresh_enable_rule")).toMatch(/trusts you/);
    expect(desc("refresh_create_rule")).toMatch(/unless they trust you/);
    expect(desc("refresh_delete_rule")).toMatch(/trusts you/);
    expect(desc("refresh_disable_rule")).toMatch(/withdraws/);
  });

  it("names dashboard places, result codes and limits that exist", async () => {
    const { readFileSync } = await import("node:fs");
    const ui = ["src/ui/dashboard/Dashboard.tsx", "src/ui/dashboard/AgentsView.tsx"].map((f) => readFileSync(f, "utf8")).join("\n");
    const types = readFileSync("src/core/types.ts", "utf8");
    const text = TOOLS.map((t) => t.description).join(" ") + INSTRUCTIONS;
    for (const place of text.match(/Agent Integrations|Waiting for your OK/g)) expect(ui).toContain(place);
    for (const code of ["invalid_selector", "missing_permission", "restricted_url", "page_not_ready", "timeout"]) {
      expect(text).toContain(code);
      expect(types).toContain(`"${code}"`);
    }
    const { MIN_INTERVAL_SECONDS, FAST_MIN_INTERVAL_SECONDS } = await import("@/triggers/interval");
    expect(INSTRUCTIONS).toContain(`minimum ${MIN_INTERVAL_SECONDS} s, or ${FAST_MIN_INTERVAL_SECONDS} s`);
  });

  it("initialize sends short instructions covering the workflow and the gotchas", async () => {
    const handle = createMcpHandler({ callApi: async () => ({ ok: true, result: {} }) });
    const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(init.result.instructions).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS.length).toBeLessThan(1500);
    for (const must of [/refresh_create_rule/, /turns a running rule off/, /unknown means/, /dom\.exists/, /trusted/, /don't try to recover them/]) {
      expect(INSTRUCTIONS).toMatch(must);
    }
    expect(INSTRUCTIONS).not.toMatch(/browser tools/);
    // Every tool it names exists.
    for (const name of INSTRUCTIONS.match(/refresh_[a-z_]+/g))
      expect(
        TOOLS.some((t) => t.name === name),
        name,
      ).toBe(true);
  });

  it("results are compact JSON; a large one isn't repeated in structuredContent", async () => {
    let result: unknown = { status: "enabled", nested: { a: [1, 2] } };
    const handle = createMcpHandler({ callApi: async () => ({ ok: true, result }) });
    const call = () => handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "refresh_list_rules", arguments: {} } });
    const small = (await call()).result;
    expect(small.content[0].text).toBe(JSON.stringify(result));
    expect(small.structuredContent).toEqual(result);
    result = [{ id: "x" }];
    expect((await call()).result.structuredContent).toEqual({ result: [{ id: "x" }] });
    result = { big: "x".repeat(STRUCTURED_MAX_BYTES) };
    const large = (await call()).result;
    expect(JSON.parse(large.content[0].text)).toEqual(result);
    expect(large.structuredContent).toBeUndefined();
    // The limit is in bytes: short in characters, long in UTF-8.
    result = { s: "ü".repeat(STRUCTURED_MAX_BYTES / 2) };
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(STRUCTURED_MAX_BYTES);
    expect((await call()).result.structuredContent).toBeUndefined();
    // Nothing at all: text and structuredContent agree.
    result = undefined;
    const none = (await call()).result;
    expect(none.content[0].text).toBe("null");
    expect(none.structuredContent).toEqual({ result: null });
  });

  it("disable withdraws a waiting enable request; enable or disable of a rule already so changes nothing", async () => {
    const env = createApiEnv();
    const agent = env.agent();
    await env.pairAgent();
    const created = await env.service.call(agent, "createRule", { rule: SPEC_EXAMPLE });
    const revision = async () => (await env.config.get()).rules[created.id].meta.revision;
    const waiting = async () => (await env.service.call(agent, "getRuleStatus", { id: created.id })).pendingApprovals;

    // Asked, then taken back: nothing is left for the user to approve by mistake.
    const first = await env.service.call(agent, "enableRule", { id: created.id });
    expect(first.status).toBe("pending_approval");
    const before = await revision();
    await env.service.call(agent, "disableRule", { id: created.id });
    await env.service.call(agent, "disableRule", { id: created.id });
    expect(await revision()).toBe(before);
    expect(await waiting()).toEqual([]);
    await expect(env.service.call(env.user, "resolveApproval", { id: first.approvalId, approve: true })).rejects.toMatchObject({ code: "not_found" });
    expect((await env.config.get()).rules[created.id].enabled).toBe(false);

    // Asked again and approved: it runs. Asking again while it runs changes nothing.
    const second = await env.service.call(agent, "enableRule", { id: created.id });
    await env.service.call(env.user, "resolveApproval", { id: second.approvalId, approve: true });
    const running = await revision();
    expect(await env.service.call(agent, "enableRule", { id: created.id })).toEqual({ status: "enabled" });
    expect(await env.service.call(env.user, "enableRule", { id: created.id })).toEqual({ status: "enabled" });
    expect(await waiting()).toEqual([]);
    expect(await revision()).toBe(running);
  });

  it("errors are compact too", async () => {
    const handle = createMcpHandler({ callApi: async () => ({ ok: false, error: { code: "forbidden", message: "No" } }) });
    const r = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "refresh_list_rules", arguments: {} } });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toBe('{"code":"forbidden","message":"No"}');
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

  const approve = async (env: ReturnType<typeof createApiEnv>) => {
    await env.service.ensureAgent({ id: "native:claude", name: "Claude", transport: "native" });
    await env.service.call(env.user, "updateAgent", { id: "native:claude", status: "approved", scopes: ["rules:read"] });
  };
  const agentOf = async (env: ReturnType<typeof createApiEnv>) => (await env.config.get()).agents["native:claude"]!;

  it("issues a key after approval and binds it when the agent first uses it; then requires it", async () => {
    const env = createApiEnv();
    await env.service.ensureAgent({ id: "native:claude", name: "Claude", transport: "native" });
    expect((await call(env)).agentKey).toBeUndefined(); // pending: nothing to bind yet
    await env.service.call(env.user, "updateAgent", { id: "native:claude", status: "approved", scopes: ["rules:read"] });
    const first = await call(env);
    expect(first.ok).toBe(true);
    expect(first.agentKey).toMatch(/^[0-9a-f]{64}$/);
    expect((await agentOf(env)).keyHash).toBeUndefined(); // issued, not bound yet
    const second = await call(env, first.agentKey);
    expect(second).toMatchObject({ ok: true });
    expect(second.agentKey).toBeUndefined();
    // Only a hash is stored.
    const bound = (await agentOf(env)).keyHash;
    expect(bound).toMatch(/^[0-9a-f]{64}$/);
    expect(bound).not.toBe(first.agentKey);
    expect(await call(env, first.agentKey)).toMatchObject({ ok: true });
  });

  it("a lost reply doesn't lock the agent out: until a key is used, each call gets a fresh one", async () => {
    const env = createApiEnv();
    await approve(env);
    const lost = (await call(env)).agentKey; // say this reply never arrived
    const next = await call(env);
    expect(next.agentKey).toBeDefined();
    expect(next.agentKey).not.toBe(lost);
    expect(await call(env, lost)).toMatchObject({ ok: true }); // stale: just issued another
    const latest = (await call(env)).agentKey;
    expect(await call(env, latest)).toMatchObject({ ok: true });
    expect((await agentOf(env)).keyHash).toBeDefined();
  });

  it("a failed call still delivers the key", async () => {
    const env = createApiEnv();
    await approve(env);
    const r = (await handleAgentMessage(
      env.service,
      new RateLimiter(1000, 60_000),
      { id: "native:claude", name: "Claude", transport: "native" },
      { protocol: "justrefresh-agent/1", method: "getRule", params: { id: "nope" } },
    )) as { ok: boolean; agentKey?: string };
    expect(r.ok).toBe(false);
    expect(r.agentKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("once bound, refuses another program using the same agent name, with or without a guessed key, and records it", async () => {
    const env = createApiEnv();
    await approve(env);
    await call(env, (await call(env)).agentKey);
    for (const key of [undefined, "0".repeat(64)]) {
      const r = await call(env, key);
      expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(r.error!.message).toMatch(/key .* doesn't match/);
    }
    await new Promise((r) => setTimeout(r, 0));
    expect((await env.audit.list()).filter((a) => a.outcome === "denied" && /agent key/.test(a.detail ?? ""))).toHaveLength(2);
  });

  it("starts over when the user removes the agent: the next approval issues a new key", async () => {
    const env = createApiEnv();
    await env.service.ensureAgent({ id: "native:claude", name: "Claude", transport: "native" });
    await env.service.call(env.user, "updateAgent", { id: "native:claude", status: "approved", scopes: ["rules:read"] });
    const old = (await call(env)).agentKey;
    await call(env, old);
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
