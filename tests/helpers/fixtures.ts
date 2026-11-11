import { validateRule } from "@/core/rule-schema";
import type { Rule, RuleInput } from "@/core/types";

export function makeRule(input: Partial<RuleInput> & { id: string }, meta: Partial<Rule["meta"]> = {}): Rule {
  const v = validateRule({
    name: input.name ?? input.id,
    target: { patterns: ["https://example.com/*"] },
    trigger: { type: "interval", seconds: 30 },
    ...input,
  });
  if (!v.valid) throw new Error(JSON.stringify(v.diagnostics));
  return { ...v.normalized!, meta: { ...v.normalized!.meta, createdAt: 1, revision: 1, ...meta } };
}

export const SPEC_EXAMPLE = {
  schemaVersion: 1,
  id: "rule-001",
  name: "Monitor availability",
  enabled: true,
  priority: 100,
  target: { type: "url", patterns: ["https://example.com/products/*"], exclusions: [] },
  trigger: { type: "interval", seconds: 30 },
  stopWhen: {
    type: "any",
    conditions: [
      { type: "dom.text", selector: "#status", operator: "contains", value: "Available" },
      { type: "dom.exists", selector: ".buy-button" },
    ],
  },
  actions: {
    onMatched: [{ type: "stopRefresh" }, { type: "notify" }],
    onNotMatched: [{ type: "refresh" }],
  },
  safety: {
    pauseWhileTyping: true,
    protectUnsavedChanges: true,
    inactivityGraceSeconds: 60,
    maxRefreshes: 100,
    onUnknown: "pause",
  },
};
