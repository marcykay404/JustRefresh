import { createApiEnv } from "../helpers/api-env";
import { SPEC_EXAMPLE } from "../helpers/fixtures";
import type { Rule } from "@/core/types";

describe("Rule Management API — user", () => {
  it("creates, updates with optimistic concurrency, and deletes", async () => {
    const env = createApiEnv();
    const r = (await env.service.call(env.user, "createRule", { rule: SPEC_EXAMPLE })) as Rule;
    expect(r).toMatchObject({ id: "rule-001", enabled: true, meta: { revision: 1, draft: false, origin: { type: "user" } } });
    const u = (await env.service.call(env.user, "updateRule", { id: r.id, patch: { priority: 5 }, expectedRevision: 1 })) as Rule;
    expect(u.meta.revision).toBe(2);
    await expect(env.service.call(env.user, "updateRule", { id: r.id, patch: { priority: 6 }, expectedRevision: 1 })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(env.service.call(env.user, "createRule", { rule: SPEC_EXAMPLE })).rejects.toMatchObject({ code: "conflict" });
    await env.service.call(env.user, "deleteRule", { id: r.id });
    await expect(env.service.call(env.user, "getRule", { id: r.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns structured diagnostics agents can act on", async () => {
    const env = createApiEnv();
    const e = (await env.service
      .call(env.user, "createRule", { rule: { ...SPEC_EXAMPLE, trigger: { type: "interval", seconds: 5 } } })
      .catch((x: { code: string; diagnostics: unknown[] }) => x)) as { code: string; diagnostics: unknown[] };
    expect(e.code).toBe("validation_failed");
    expect(e.diagnostics[0]).toMatchObject({ path: "trigger.seconds", severity: "error" });
  });

  it("rejects unknown methods and unknown arguments", async () => {
    const env = createApiEnv();
    await expect(env.service.call(env.user, "eval", {})).rejects.toMatchObject({ code: "unsupported_method" });
    await expect(env.service.call(env.user, "getRule", { id: "x", extra: 1 })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(env.service.call(env.user, "__proto__", {})).rejects.toMatchObject({ code: "unsupported_method" });
  });

  it("imports bundles as drafts with duplicate handling and exports them back", async () => {
    const env = createApiEnv();
    await env.service.call(env.user, "createRule", { rule: SPEC_EXAMPLE });
    const bundle = await env.service.call(env.user, "exportConfig", {});
    const report = (await env.service.call(env.user, "importConfig", { json: JSON.stringify(bundle) })) as { imported: string[] };
    expect(report.imported).toHaveLength(1);
    expect(report.imported[0]).not.toBe("rule-001");
    const imported = (await env.service.call(env.user, "getRule", { id: report.imported[0] })) as Rule;
    expect(imported).toMatchObject({ enabled: false, meta: { draft: true, origin: { type: "import" } } });

    const bad = (await env.service.call(env.user, "importConfig", { json: JSON.stringify([{ name: "x" }, SPEC_EXAMPLE]), onDuplicate: "skip" })) as {
      errors: unknown[];
      skipped: unknown[];
    };
    expect(bad.errors).toHaveLength(1);
    expect(bad.skipped).toHaveLength(1);
    const notJson = (await env.service.call(env.user, "importConfig", { json: "{oops" })) as { errors: { diagnostics: { code: string }[] }[] };
    expect(notJson.errors[0].diagnostics[0].code).toBe("json_invalid");
  });

  it("tests patterns with precedence and exclusions", async () => {
    const env = createApiEnv();
    await env.service.call(env.user, "createRule", { rule: { ...SPEC_EXAMPLE, target: { patterns: ["example.com/*"] } } });
    await env.service.call(env.user, "addExclusion", { pattern: "https://example.com/checkout/*" });
    const r = (await env.service.call(env.user, "testPattern", { pattern: "*.example.com", url: "https://example.com/checkout/1" })) as {
      matches: boolean;
      rulesMatchingUrl: unknown[];
      excludedBy: string[];
    };
    expect(r.matches).toBe(true);
    expect(r.rulesMatchingUrl).toHaveLength(1);
    expect(r.excludedBy).toEqual(["https://example.com/checkout/*"]);
  });
});

describe("Scenario G: agent integration & security", () => {
  it("unpaired agents are refused; pairing requires user approval", async () => {
    const env = createApiEnv();
    await expect(env.service.call(env.agent("native:x"), "listRules", undefined)).rejects.toMatchObject({ code: "pairing_required" });
    await env.service.ensureAgent({ id: "native:x", name: "X", transport: "native" });
    await expect(env.service.call(env.agent("native:x"), "listRules", undefined)).rejects.toMatchObject({ code: "pairing_required" });
    const audit = await env.audit.list();
    expect(audit.some((a) => a.outcome === "denied")).toBe(true);
  });

  it("validate → dry run → draft → approval → active", async () => {
    const env = createApiEnv();
    await env.pairAgent();
    env.browser.addTab(7, "https://example.com/products/42?token=secret");
    env.page.setHtml(7, `<div id="status">Available</div>`);

    const caps = (await env.service.call(env.agent(), "getCapabilities", undefined)) as { conditions: { type: string }[]; ruleSchema: object };
    expect(caps.conditions.map((c) => c.type)).toContain("dom.text");
    expect(caps.ruleSchema).toBeTruthy();

    const tabs = (await env.service.call(env.agent(), "listTabs", undefined)) as { url: string }[];
    expect(tabs[0].url).toBe("https://example.com/products/42?…");

    const v = (await env.service.call(env.agent(), "validateRule", { rule: SPEC_EXAMPLE })) as { valid: boolean };
    expect(v.valid).toBe(true);

    const dry = (await env.service.call(env.agent(), "testRule", { rule: SPEC_EXAMPLE, tabId: 7 })) as {
      result: { status: string };
      trace: { children: { result: { details?: { element?: { textPreview?: string } } } }[] };
      sideEffects: string;
    };
    expect(dry.result.status).toBe("matched");
    // Agents never receive page text previews.
    expect(dry.trace.children[0].result.details?.element?.textPreview).toBeUndefined();
    expect(env.browser.reloads).toEqual([]);

    const created = (await env.service.call(env.agent(), "createRule", { rule: { ...SPEC_EXAMPLE, enabled: true } })) as Rule;
    expect(created).toMatchObject({ enabled: false, meta: { draft: true, origin: { type: "agent", agentId: "native:claude" } } });

    const pending = (await env.service.call(env.agent(), "enableRule", { id: created.id })) as { status: string; approvalId: string };
    expect(pending.status).toBe("pending_approval");
    expect(((await env.service.call(env.user, "getRule", { id: created.id })) as Rule).enabled).toBe(false);

    await env.service.call(env.user, "resolveApproval", { id: pending.approvalId, approve: true });
    const active = (await env.service.call(env.user, "getRule", { id: created.id })) as Rule;
    expect(active).toMatchObject({ enabled: true, meta: { draft: false } });

    const status = (await env.service.call(env.agent(), "getRuleStatus", { id: created.id })) as { tabs: { status: string }[] };
    expect(status.tabs[0].status).toBe("scheduled");

    const audit = await env.audit.list();
    expect(audit.map((a) => a.operation)).toEqual(expect.arrayContaining(["createRule", "enableRule", "testRule"]));
    expect(audit.find((a) => a.operation === "enableRule")?.outcome).toBe("pending_approval");
  });

  it("approvals go stale when the rule changes after the request", async () => {
    const env = createApiEnv();
    await env.pairAgent();
    const created = (await env.service.call(env.agent(), "createRule", { rule: SPEC_EXAMPLE })) as Rule;
    const pending = (await env.service.call(env.agent(), "enableRule", { id: created.id })) as { approvalId: string };
    await env.service.call(env.agent(), "updateRule", { id: created.id, patch: { trigger: { type: "interval", seconds: 300 } } });
    expect(await env.service.call(env.user, "resolveApproval", { id: pending.approvalId, approve: true })).toEqual({ outcome: "stale" });
    expect(((await env.service.call(env.user, "getRule", { id: created.id })) as Rule).enabled).toBe(false);
  });

  it("agents cannot modify user rules, lack-of-scope is denied, and revocation works", async () => {
    const env = createApiEnv();
    await env.pairAgent("native:a", ["rules:read", "rules:write"]);
    const userRule = (await env.service.call(env.user, "createRule", { rule: SPEC_EXAMPLE })) as Rule;
    await expect(env.service.call(env.agent("native:a"), "updateRule", { id: userRule.id, patch: { priority: 1 } })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(env.service.call(env.agent("native:a"), "deleteRule", { id: userRule.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(env.service.call(env.agent("native:a"), "listTabs", undefined)).rejects.toMatchObject({ code: "forbidden" });
    // user-only methods are never reachable
    await expect(env.service.call(env.agent("native:a"), "pauseAll", undefined)).rejects.toMatchObject({ code: "forbidden" });
    await expect(env.service.call(env.agent("native:a"), "updateAgent", { id: "native:a", scopes: ["rules:delete"] })).rejects.toMatchObject({
      code: "forbidden",
    });
    await env.service.call(env.user, "updateAgent", { id: "native:a", status: "revoked" });
    await expect(env.service.call(env.agent("native:a"), "listRules", undefined)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("agent updates turn an active rule back into a draft", async () => {
    const env = createApiEnv();
    await env.pairAgent("native:t", undefined, true);
    const r = (await env.service.call(env.agent("native:t"), "createRule", { rule: SPEC_EXAMPLE })) as Rule;
    expect(await env.service.call(env.agent("native:t"), "enableRule", { id: r.id })).toEqual({ status: "enabled" });
    const updated = (await env.service.call(env.agent("native:t"), "updateRule", { id: r.id, patch: { priority: 3 } })) as Rule;
    expect(updated.enabled).toBe(false);
    expect(updated.meta.draft).toBe(true);
  });

  it("deleting an enabled rule requires approval unless trusted", async () => {
    const env = createApiEnv();
    await env.pairAgent();
    const r = (await env.service.call(env.agent(), "createRule", { rule: SPEC_EXAMPLE })) as Rule;
    const p = (await env.service.call(env.agent(), "enableRule", { id: r.id })) as { approvalId: string };
    await env.service.call(env.user, "resolveApproval", { id: p.approvalId, approve: true });
    const del = (await env.service.call(env.agent(), "deleteRule", { id: r.id })) as { status: string };
    expect(del.status).toBe("pending_approval");
    expect(await env.service.call(env.user, "getRule", { id: r.id })).toBeTruthy();
  });
});

describe("temporary tab exclusion (FR-01)", () => {
  it("restores the tab's own settings when the tab is included again", async () => {
    const env = createApiEnv();
    env.browser.addTab(7, "https://news.test/");
    await env.service.call(env.user, "startTab", { tabId: 7, intervalSeconds: 45 });

    await env.service.call(env.user, "excludeTab", { tabId: 7 });
    expect(await env.runtime.get(7)).toMatchObject({ status: "excluded" });
    expect(env.alarms.alarms.size).toBe(0);

    const state = (await env.service.call(env.user, "includeTab", { tabId: 7 })) as { statusLabel: string };
    expect((await env.config.get()).tabOverrides["7"]).toMatchObject({ mode: "custom", intervalSeconds: 45 });
    expect(state.statusLabel).toBe("Scheduled");
    expect(env.alarms.alarms.size).toBe(1);
  });

  it("keeps a paused tab paused after exclude → include, and clears a tab that had no settings", async () => {
    const env = createApiEnv();
    env.browser.addTab(7, "https://news.test/");
    env.browser.addTab(8, "https://other.test/");
    await env.service.call(env.user, "startTab", { tabId: 7, intervalSeconds: 60 });
    await env.service.call(env.user, "pauseTab", { tabId: 7 });

    await env.service.call(env.user, "excludeTab", { tabId: 7 });
    await env.service.call(env.user, "excludeTab", { tabId: 7 }); // twice: must not lose the saved settings
    await env.service.call(env.user, "includeTab", { tabId: 7 });
    expect((await env.config.get()).tabOverrides["7"]).toMatchObject({ mode: "custom", intervalSeconds: 60, paused: true });

    await env.service.call(env.user, "excludeTab", { tabId: 8 });
    await env.service.call(env.user, "includeTab", { tabId: 8 });
    expect((await env.config.get()).tabOverrides["8"]).toBeUndefined();
  });
});

it("capabilities say so when the JSON Schema files can't be read", async () => {
  const { RuleManagementService } = await import("@/api/rule-api");
  const env = createApiEnv();
  const svc = new RuleManagementService({
    ...(env.service as unknown as { deps: ConstructorParameters<typeof RuleManagementService>[0] }).deps,
    schemas: async () => {
      throw new Error("missing");
    },
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const caps = (await svc.call(env.user, "getCapabilities", undefined)) as { schemasUnavailable?: boolean; ruleSchema: object };
  expect(caps).toMatchObject({ schemasUnavailable: true, ruleSchema: {} });
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
  expect(((await env.service.call(env.user, "getCapabilities", undefined)) as { schemasUnavailable?: boolean }).schemasUnavailable).toBeUndefined();
});
