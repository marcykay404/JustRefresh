/** Capabilities for agents: a small summary by default, JSON Schemas one piece at a time (#27 phase 2). */
import { createApiEnv } from "../helpers/api-env";
import { defaultRegistries } from "@/registries";

const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x), "utf8");
/** Like the bundle budget: raise it on purpose, not by accident. Agents pay for every byte in tokens. */
const SUMMARY_BUDGET_BYTES = 8 * 1024;
const RULE_SCHEMA_BUDGET_BYTES = 5 * 1024;

type Schema = { properties?: Record<string, { const?: string }>; $defs?: Record<string, { description?: string }> };

async function agentEnv() {
  const env = createApiEnv();
  await env.pairAgent();
  const call = <T>(method: string, params?: unknown) => env.service.call(env.agent(), method, params) as Promise<T>;
  return { env, call };
}

describe("getCapabilities", () => {
  it("is a summary by default: every handler, no schemas, within budget", async () => {
    const { call } = await agentEnv();
    const caps = await call<Record<string, unknown> & { conditions: Record<string, unknown>[] }>("getCapabilities");
    expect(caps.ruleSchema).toBeUndefined();
    expect(caps.conditions.every((c) => !("schema" in c))).toBe(true);
    const r = defaultRegistries();
    expect(caps.conditions.map((c) => c.type)).toEqual(r.conditions.list().map((h) => h.type));
    expect(bytes(caps)).toBeLessThanOrEqual(SUMMARY_BUDGET_BYTES);
    expect(JSON.stringify(caps.notes)).toMatch(/getSchema/);
  });

  it("includeSchemas gives the full payload the rule builder needs", async () => {
    const { call } = await agentEnv();
    const full = await call<{ ruleSchema: Schema; conditions: { type: string; schema: Schema }[] }>("getCapabilities", { includeSchemas: true });
    expect(full.ruleSchema.$defs).toHaveProperty("condition");
    for (const c of full.conditions) expect(c.schema.properties?.type?.const, c.type).toBe(c.type);
  });
});

describe("getSchema", () => {
  it("every registered handler's schema is reachable, one at a time and all of a kind", async () => {
    const { call } = await agentEnv();
    const r = defaultRegistries();
    const kinds = { condition: r.conditions, trigger: r.triggers, action: r.actions } as const;
    for (const [kind, registry] of Object.entries(kinds)) {
      const all = await call<{ schema: Record<string, Schema> }>("getSchema", { kind });
      expect(Object.keys(all.schema), kind).toEqual(registry.list().map((h) => h.type));
      for (const h of registry.list()) {
        const one = await call<{ kind: string; type: string; schema: Schema }>("getSchema", { kind, type: h.type });
        expect(one).toMatchObject({ kind, type: h.type });
        expect(one.schema.properties?.type?.const, `${kind} ${h.type}`).toBe(h.type);
        expect(all.schema[h.type]).toEqual(one.schema);
      }
    }
  });

  it("the rule schema is small and points to getSchema for conditions, triggers and actions", async () => {
    const { call } = await agentEnv();
    const { schema } = await call<{ schema: Schema }>("getSchema", { kind: "rule" });
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(["name", "target", "trigger", "stopWhen", "actions"]));
    expect(bytes(schema)).toBeLessThanOrEqual(RULE_SCHEMA_BUDGET_BYTES);
    // Every $ref still resolves, to a pointer that says where the real definition is.
    const refs = JSON.stringify(schema).match(/"\$ref":"#\/\$defs\/[a-z]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const name = ref.slice(ref.lastIndexOf("/") + 1, -1);
      expect(schema.$defs?.[name]?.description, name).toMatch(new RegExp(`getSchema\\(\\{ kind: '${name}'`));
    }
  });

  it("says which types exist when asked for one that doesn't", async () => {
    const { call } = await agentEnv();
    await expect(call("getSchema", { kind: "condition", type: "dom.nope" })).rejects.toMatchObject({ code: "not_found", message: /dom\.exists/ });
    await expect(call("getSchema", { kind: "rule", type: "x" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(call("getSchema", { kind: "page" })).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("needs rules:read, like the capabilities", async () => {
    const env = createApiEnv();
    await env.pairAgent("native:claude", ["tabs:read"]);
    await expect(env.service.call(env.agent(), "getSchema", { kind: "rule" })).rejects.toMatchObject({ code: "forbidden" });
  });
});
