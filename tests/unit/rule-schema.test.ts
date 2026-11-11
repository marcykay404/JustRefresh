import { validateRule, validateCondition, MAX_CONDITION_DEPTH } from "@/core/rule-schema";
import { SPEC_EXAMPLE } from "../helpers/fixtures";

describe("validateRule", () => {
  it("accepts the specification example and normalizes it", () => {
    const v = validateRule(SPEC_EXAMPLE);
    expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(v.valid).toBe(true);
    expect(v.normalized!.limits.maxRefreshes).toBe(100);
    expect(v.normalized!.safety.maxUnknownRetries).toBe(3);
    expect((v.normalized!.safety as unknown as Record<string, unknown>).maxRefreshes).toBeUndefined();
  });

  it("fills default actions", () => {
    const v = validateRule({ name: "x", target: { patterns: ["example.com"] }, trigger: { type: "interval", seconds: 60 } });
    expect(v.normalized!.actions).toEqual({ onMatched: [], onNotMatched: [{ type: "refresh" }] });
    const w = validateRule({
      name: "x",
      target: { patterns: ["example.com"] },
      trigger: { type: "interval", seconds: 60 },
      stopWhen: { type: "dom.exists", selector: "#a" },
    });
    expect(w.normalized!.actions.onMatched).toEqual([{ type: "stopRefresh" }, { type: "notify" }]);
  });

  it("rejects unknown fields, types and short intervals with paths", () => {
    const v = validateRule({
      name: "x",
      bogus: 1,
      target: { patterns: ["example.com"] },
      trigger: { type: "interval", seconds: 5 },
    });
    expect(v.valid).toBe(false);
    expect(v.diagnostics.map((d) => d.code)).toContain("unrecognized_keys");

    // Below the 5 s hard floor: always invalid.
    const t = validateRule({ name: "x", target: { patterns: ["example.com"] }, trigger: { type: "interval", seconds: 4 } });
    expect(t.diagnostics[0].path).toBe("trigger.seconds");
    // 5–29 s: only when the user enabled fast intervals (structural validation alone accepts it).
    const fast = { name: "x", target: { patterns: ["example.com"] }, trigger: { type: "interval", seconds: 5 } };
    expect(validateRule(fast, { allowFastIntervals: false }).diagnostics[0]).toMatchObject({ path: "trigger.seconds", code: "fast_intervals_disabled" });
    expect(validateRule(fast, { allowFastIntervals: true }).valid).toBe(true);
    expect(validateRule(fast).valid).toBe(true);

    const c = validateRule({
      name: "x",
      target: { patterns: ["example.com"] },
      trigger: { type: "interval", seconds: 30 },
      stopWhen: { type: "dom.magic" },
    });
    expect(c.diagnostics[0]).toMatchObject({ path: "stopWhen.type", code: "unknown_condition" });

    const a = validateRule({
      name: "x",
      target: { patterns: ["example.com"] },
      trigger: { type: "interval", seconds: 30 },
      actions: { onNotMatched: [{ type: "explode" }] },
    });
    expect(a.diagnostics[0]).toMatchObject({ path: "actions.onNotMatched[0].type", code: "unknown_action" });
  });

  it("rejects invalid patterns and unsafe regex", () => {
    const v = validateRule({ name: "x", target: { patterns: ["^(a+)+$"] }, trigger: { type: "interval", seconds: 30 } });
    expect(v.diagnostics[0]).toMatchObject({ path: "target.patterns[0]", code: "pattern_invalid" });
  });

  it("rejects refresh with navigation trigger (reload loop)", () => {
    const v = validateRule({
      name: "x",
      target: { patterns: ["example.com"] },
      trigger: { type: "navigation" },
      actions: { onNotMatched: [{ type: "refresh" }] },
    });
    expect(v.diagnostics.map((d) => d.code)).toContain("refresh_loop");
    const ok = validateRule({ name: "x", target: { patterns: ["example.com"] }, trigger: { type: "navigation" } });
    expect(ok.valid).toBe(true);
    expect(ok.normalized!.actions.onNotMatched).toEqual([]);
  });

  it("validates nested conditions with precise paths", () => {
    const d = validateCondition({ type: "all", conditions: [{ type: "not", condition: { type: "refreshCount", operator: "~", value: 1 } }] }, "stopWhen");
    expect(d[0].path).toBe("stopWhen.conditions[0].condition.operator");
  });

  it("limits nesting depth", () => {
    let node: Record<string, unknown> = { type: "dom.exists", selector: "#a" };
    for (let i = 0; i < MAX_CONDITION_DEPTH + 1; i++) node = { type: "not", condition: node };
    expect(validateCondition(node, "stopWhen").map((d) => d.code)).toContain("too_deep");
  });

  it("requires value for attribute comparison", () => {
    const d = validateCondition({ type: "dom.attribute", selector: "a", attribute: "href", operator: "equals" }, "c");
    expect(d[0].code).toBe("value_required");
  });

  it("warns when DOM conditions need host permission", () => {
    const v = validateRule(SPEC_EXAMPLE);
    expect(v.diagnostics.find((d) => d.code === "requires_host_permission")?.severity).toBe("warning");
  });
});
