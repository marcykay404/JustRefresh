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
    const handle = createMcpHandler({
      callApi: (method: string, params: unknown) => handleAgentMessage(env.service, limiter, identity, { protocol: "justrefresh-agent/1", method, params }),
      onInitialize: () => handleAgentMessage(env.service, limiter, identity, { protocol: "justrefresh-agent/1", method: "pair", name: "Claude" }),
    });
    return { env, handle };
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
  const { readFileSync } = await import("node:fs");
  const { NATIVE_HOST } = await import("@/integrations/native-bridge");
  expect(readFileSync("bridge/install.mjs", "utf8")).toContain(`const HOST = "${NATIVE_HOST}";`);
});
