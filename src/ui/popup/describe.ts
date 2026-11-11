/**
 * Plain-language helpers for the popup: interval labels, the interval chips,
 * a one-line summary of a rule, and the rule that "Refresh until something
 * appears" creates. Pure functions, so they are unit tested.
 */
import type { ConditionNode, Rule, RuleInput } from "../../core/types";

/** 30 → "30 sec", 60 → "1 min", 90 → "1 min 30 sec", 3600 → "1 hour", 5400 → "1 hr 30 min". */
export function intervalLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} sec`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${m} min ${rest} sec` : `${m} min`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (m) return `${h} hr ${m} min`;
  return h === 1 ? "1 hour" : `${h} hours`;
}

/** The one-tap interval chips (Custom… is added by the UI). */
export function intervalChips(fastAllowed: boolean): number[] {
  return fastAllowed ? [10, 30, 60, 300, 900] : [30, 60, 300, 900, 3600];
}

const quote = (v: unknown) => `“${String(v)}”`;

/** "“In stock” appears", "an element matching .buy appears", … */
export function describeCondition(c: ConditionNode): string {
  const n = c as { type: string; [k: string]: unknown };
  const where = typeof n.selector === "string" && n.selector ? ` in ${n.selector}` : "";
  switch (n.type) {
    case "dom.text":
      switch (n.operator) {
        case "contains":
          return `${quote(n.value)} appears${where}`;
        case "not_contains":
          return `${quote(n.value)} disappears${where}`;
        case "equals":
          return `the text${where} is ${quote(n.value)}`;
        default:
          return `the text${where} matches ${quote(n.value)}`;
      }
    case "dom.exists":
      return `${String(n.selector)} appears on the page`;
    case "dom.missing":
      return `${String(n.selector)} is gone from the page`;
    case "all":
    case "any": {
      const items = (n.conditions as ConditionNode[] | undefined) ?? [];
      if (items.length === 1) return describeCondition(items[0]!);
      return `${n.type === "all" ? "all" : "any"} of ${items.length} conditions match`;
    }
    case "not":
      return "a condition stops matching";
    default:
      return "its condition matches";
  }
}

/** "Refreshing every 10 min until “S$ 3” appears, then notify me". */
export function describeRule(rule: Pick<Rule, "trigger" | "stopWhen" | "actions">): string {
  const t = rule.trigger as { type: string; seconds?: number };
  const every = t.type === "interval" && t.seconds ? `every ${intervalLabel(t.seconds)}` : `on its ${t.type} trigger`;
  if (!rule.stopWhen) return `Refreshing ${every}`;
  const notifies = rule.actions.onMatched.some((a) => a.type === "notify");
  return `Refreshing ${every} until ${describeCondition(rule.stopWhen)}${notifies ? ", then notify me" : ""}`;
}

export type UntilMode = "appears" | "disappears";

/**
 * "Refresh until something appears": refresh this exact page every
 * `seconds` until `text` appears (or disappears) anywhere on it, then stop
 * and notify with a sound.
 */
export function untilRule(o: { url: string; site: string; seconds: number; text: string; mode: UntilMode }): RuleInput {
  const text = o.text.trim();
  return {
    name: `${o.site}: until ${quote(text)} ${o.mode === "appears" ? "appears" : "disappears"}`.slice(0, 100),
    enabled: true,
    target: { type: "url", patterns: [{ type: "exact", value: o.url }], exclusions: [] },
    trigger: { type: "interval", seconds: o.seconds },
    stopWhen: { type: "dom.text", operator: o.mode === "appears" ? "contains" : "not_contains", value: text, caseSensitive: false },
    actions: {
      onMatched: [
        { type: "stopRefresh" },
        { type: "notify", title: o.mode === "appears" ? `Found ${quote(text)}` : `${quote(text)} is gone`, message: o.site, sound: true },
      ],
      onNotMatched: [{ type: "refresh" }],
    },
  } as RuleInput;
}
