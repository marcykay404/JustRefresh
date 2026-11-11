/**
 * Deterministic rule resolution (FR-14).
 *
 * Precedence, first applicable wins:
 *  1. Restricted / inaccessible target
 *  2. Global disabled / paused state
 *  3. Explicit tab exclusion (temporary, per tab instance)
 *  4. Matching URL exclusion (persistent, global)
 *  5. Safety restrictions — applied at execution time by the engine
 *  6. Explicit per-tab configuration
 *  7. Highest-priority matching URL rule
 *     tie-breaker: older `meta.createdAt` first, then lexicographic `id`
 *  8. No applicable rule
 */
import { detectPattern, matchesAny, patternToString, restrictedReason } from "./url-pattern";
import { DEFAULT_SAFETY } from "./defaults";
import type { Config, Exclusion, Rule, TabOverride } from "./types";
import { RULE_SCHEMA_VERSION } from "./types";
import { clampToStandard, type IntervalTrigger } from "../triggers/interval";

/**
 * The rule as it runs under the user's settings: while fast intervals are
 * disabled, a stored sub-30 s interval runs at the standard minimum instead
 * (the rule itself is kept, so re-enabling restores it).
 */
function effective(rule: Rule, config: Config): Rule {
  if (config.settings.allowFastIntervals || rule.trigger.type !== "interval") return rule;
  const trigger = clampToStandard(rule.trigger as IntervalTrigger);
  return trigger === rule.trigger ? rule : { ...rule, trigger };
}

export type Resolution =
  | { kind: "restricted"; reason: string }
  | { kind: "disabled"; reason: string }
  | { kind: "paused"; reason: string; controller: Rule | null }
  | { kind: "tab_excluded"; reason: string }
  | { kind: "url_excluded"; reason: string; exclusion: Exclusion }
  | { kind: "controller"; controller: Rule; source: "tab" | "rule"; candidates: Rule[] }
  | { kind: "none"; reason: string };

export function tabControllerId(tabId: number): string {
  return `tab:${tabId}`;
}

export function isTabControllerId(id: string | null | undefined): boolean {
  return !!id && id.startsWith("tab:");
}

export function compareRulePrecedence(a: Rule, b: Rule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.meta.createdAt !== b.meta.createdAt) return a.meta.createdAt - b.meta.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function ruleAppliesTo(rule: Rule, url: string): boolean {
  if (!rule.enabled || rule.meta.draft) return false;
  if (!matchesAny(rule.target.patterns, url)) return false;
  return !matchesAny(rule.target.exclusions, url);
}

export function matchingRules(rules: Iterable<Rule>, url: string): Rule[] {
  return [...rules].filter((r) => ruleAppliesTo(r, url)).sort(compareRulePrecedence);
}

/**
 * Rules set for this exact page with a different "?…" part, which therefore
 * don't run here: some sites change that part on every load, and the tab
 * silently drops out of the rule.
 */
export function rulesForOtherQuery(rules: Iterable<Rule>, url: string): Rule[] {
  const page = (href: string) => {
    try {
      const u = new URL(href);
      return { base: `${u.origin}${u.pathname}`, query: u.search.length > 1 };
    } catch {
      return null;
    }
  };
  const here = page(url);
  if (!here) return [];
  return [...rules].filter(
    (r) =>
      r.enabled &&
      !r.meta.draft &&
      !ruleAppliesTo(r, url) &&
      !matchesAny(r.target.exclusions, url) &&
      r.target.patterns.some((p) => {
        const { type, value } = detectPattern(p);
        const there = type === "exact" ? page(value) : null;
        return !!there && there.base === here.base && (there.query || here.query);
      }),
  );
}

/** Synthesize a rule from a per-tab override so one engine handles both. */
export function ruleFromTabOverride(o: TabOverride, config: Config): Rule {
  const s = config.settings;
  return {
    schemaVersion: RULE_SCHEMA_VERSION,
    id: tabControllerId(o.tabId),
    name: "Tab-specific refresh",
    enabled: true,
    priority: Number.MAX_SAFE_INTEGER,
    target: { type: "url", patterns: [], exclusions: [] },
    trigger: { type: "interval", seconds: o.intervalSeconds ?? s.defaultIntervalSeconds },
    actions: { onMatched: [], onNotMatched: [{ type: "refresh" }] },
    safety: { ...DEFAULT_SAFETY, ...s.defaultSafety, ...(o.safety ?? {}) },
    limits: o.limits ?? {},
    meta: { createdAt: o.createdAt, updatedAt: o.createdAt, revision: o.revision, origin: { type: "user" }, draft: false },
  };
}

export function resolveTab(tab: { id: number; url?: string }, config: Config): Resolution {
  const restricted = restrictedReason(tab.url);
  if (restricted) return { kind: "restricted", reason: restricted };
  const url = tab.url!;

  if (!config.settings.enabled) return { kind: "disabled", reason: "Auto refresh is globally disabled" };

  const override = config.tabOverrides[String(tab.id)];
  const controllerFor = (): { controller: Rule; source: "tab" | "rule"; candidates: Rule[] } | null => {
    const candidates = matchingRules(Object.values(config.rules), url);
    if (override?.mode === "custom") return { controller: effective(ruleFromTabOverride(override, config), config), source: "tab", candidates };
    if (candidates.length) return { controller: effective(candidates[0], config), source: "rule", candidates };
    return null;
  };

  if (config.settings.paused) {
    return { kind: "paused", reason: "All refreshes are paused", controller: controllerFor()?.controller ?? null };
  }

  if (override?.mode === "excluded") return { kind: "tab_excluded", reason: "This tab is temporarily excluded" };

  for (const ex of config.exclusions) {
    if (matchesAny([ex.pattern], url)) {
      return {
        kind: "url_excluded",
        reason: `Excluded by ${patternToString(ex.pattern)}${ex.reason ? ` (${ex.reason})` : ""}`,
        exclusion: ex,
      };
    }
  }

  const c = controllerFor();
  if (c) return { kind: "controller", ...c };
  return { kind: "none", reason: "No rule applies to this tab" };
}

/** Static conflict hints: enabled rules sharing a pattern at equal priority. */
export function detectRuleConflicts(rules: Rule[]): { a: string; b: string; pattern: string }[] {
  const out: { a: string; b: string; pattern: string }[] = [];
  const active = rules.filter((r) => r.enabled && !r.meta.draft);
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.priority !== b.priority) continue;
      const shared = a.target.patterns.map(patternToString).find((p) => b.target.patterns.map(patternToString).includes(p));
      if (shared) out.push({ a: a.id, b: b.id, pattern: shared });
    }
  }
  return out;
}
