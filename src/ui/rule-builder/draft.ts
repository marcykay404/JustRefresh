/** The rule being edited in the builder, and what it starts from. */
import type { ConditionNode, Rule, RuleInput } from "../../core/types";
import type { CapabilityItem } from "./ConditionEditor";
import { isSimpleTree } from "./ConditionEditor";

export interface Capabilities {
  conditions: CapabilityItem[];
  triggers: CapabilityItem[];
  actions: (CapabilityItem & { disruptive: boolean })[];
  limits: { minIntervalSeconds: number };
}

export type Draft = RuleInput & { stopWhen?: ConditionNode };

export function initialDraft(url?: string): Draft {
  let pattern = "https://example.com/*";
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol.startsWith("http")) pattern = `${u.origin}${u.pathname.replace(/[^/]*$/, "")}*`;
    } catch {
      /* ignore */
    }
  }
  return {
    name: url ? `Refresh ${new URL(url).hostname}` : "",
    enabled: true,
    priority: 0,
    target: { type: "url", patterns: [pattern], exclusions: [] },
    trigger: { type: "interval", seconds: 60 },
    actions: { onMatched: [{ type: "stopRefresh" }, { type: "notify" }], onNotMatched: [{ type: "refresh" }] },
    safety: {},
    limits: {},
  };
}

export function stripMeta(rule: Rule): Draft {
  const { meta: _m, schemaVersion: _v, ...rest } = rule;
  return rest as unknown as Draft;
}

/** Remove empty optional sections so the JSON stays tidy. */
export function clean(d: Draft): Draft {
  const out: Record<string, unknown> = { ...d };
  if (!out.stopWhen) delete out.stopWhen;
  if (out.limits && !Object.keys(out.limits as object).length) delete out.limits;
  if (out.safety && !Object.keys(out.safety as object).length) delete out.safety;
  if (!out.description) delete out.description;
  const sch = out.schedule as Record<string, unknown> | undefined;
  if (sch && !sch.days && !sch.startTime) delete out.schedule;
  return out as Draft;
}

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * "Apply JSON": a rule object as agents write it, onto a fresh draft. Returns
 * the draft and whether it needs advanced mode (nested condition groups).
 */
export function draftFromJson(text: string): { draft: Draft; needsAdvanced: boolean } {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a single rule object");
  delete parsed.meta;
  const base = initialDraft();
  return {
    draft: { ...parsed, target: { ...base.target, ...(parsed.target ?? {}) }, trigger: parsed.trigger ?? base.trigger },
    needsAdvanced: !isSimpleTree(parsed.stopWhen),
  };
}
