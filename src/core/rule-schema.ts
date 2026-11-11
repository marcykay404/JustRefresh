/**
 * Authoritative rule validation.
 *
 * The rule *envelope* is described with zod; trigger/condition/action nodes
 * are validated by their registry handlers so that adding a handler extends
 * the schema automatically. `schemas/rule.schema.json` is generated from the
 * same sources (see scripts/gen-schema.ts) for external agents and tooling.
 */
import { z } from "zod";
import type { Registries } from "../registries";
import { defaultRegistries } from "../registries";
import type { ValidationContext } from "../registries/contracts";
import { diag } from "../conditions/helpers";
import { urlPatternSchema } from "./pattern-schema";
import { validatePattern } from "./url-pattern";
import { DEFAULT_SAFETY } from "./defaults";
import type { ActionConfig, ConditionNode, Diagnostic, Rule, SafetyConfig, ValidationResult } from "./types";
import { RULE_SCHEMA_VERSION } from "./types";

export const MAX_CONDITION_DEPTH = 6;
export const MAX_CONDITION_NODES = 50;
export const MAX_ACTIONS = 10;
export const RULE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const node = z.looseObject({ type: z.string().min(1).max(64) });

export const safetyInputSchema = z.strictObject({
  pauseWhileTyping: z.boolean().optional(),
  protectUnsavedChanges: z.boolean().optional(),
  inactivityGraceSeconds: z.number().int().min(0).max(24 * 3600).optional(),
  pauseOnMouse: z.boolean().optional(),
  pauseOnScroll: z.boolean().optional(),
  onUnknown: z.enum(["pause", "skip", "refresh", "stop"]).optional(),
  maxUnknownRetries: z.number().int().min(0).max(100).optional(),
  onActivityUnavailable: z.enum(["pause", "refresh"]).optional(),
  /** Accepted for compatibility; normalized into `limits.maxRefreshes`. */
  maxRefreshes: z.number().int().min(1).max(1_000_000).optional(),
});

export const limitsSchema = z.strictObject({
  maxRefreshes: z.number().int().min(1).max(1_000_000).optional(),
  maxDurationSeconds: z.number().int().min(30).max(365 * 24 * 3600).optional(),
  stopAt: z.iso.datetime({ offset: true }).optional(),
});

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");
export const scheduleSchema = z.strictObject({
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  startTime: timeOfDay.optional(),
  endTime: timeOfDay.optional(),
});

export const ruleInputSchema = z.strictObject({
  schemaVersion: z.literal(RULE_SCHEMA_VERSION).optional(),
  id: z.string().regex(RULE_ID_PATTERN, "IDs may contain letters, digits, '.', '_' and '-' (max 64)").optional(),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  target: z.strictObject({
    type: z.literal("url").optional(),
    patterns: z.array(urlPatternSchema).min(1).max(50),
    exclusions: z.array(urlPatternSchema).max(50).optional(),
  }),
  trigger: node,
  stopWhen: node.optional(),
  actions: z
    .strictObject({
      onMatched: z.array(node).max(MAX_ACTIONS).optional(),
      onNotMatched: z.array(node).max(MAX_ACTIONS).optional(),
      onUnknown: z.array(node).max(MAX_ACTIONS).optional(),
    })
    .optional(),
  safety: safetyInputSchema.optional(),
  limits: limitsSchema.optional(),
  schedule: scheduleSchema.optional(),
  /** Managed by the API; ignored on input. */
  meta: z.unknown().optional(),
});

export type ParsedRuleInput = z.infer<typeof ruleInputSchema>;

export function issuePath(path: PropertyKey[], prefix = ""): string {
  let out = prefix;
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out || "$";
}

export function zodDiagnostics(error: z.ZodError, prefix = ""): Diagnostic[] {
  return error.issues.map((i) => {
    let message = i.message;
    if (i.code === "unrecognized_keys") message = `Unknown field(s): ${i.keys.join(", ")}`;
    return diag(issuePath(i.path, prefix), i.code, message);
  });
}

/* ------------------------------------------------------------------ */
/* Condition trees                                                     */
/* ------------------------------------------------------------------ */

export function validateCondition(input: unknown, path: string, registries: Registries = defaultRegistries()): Diagnostic[] {
  let nodes = 0;
  const visit = (value: unknown, p: string, depth: number): Diagnostic[] => {
    nodes++;
    if (nodes > MAX_CONDITION_NODES) {
      return nodes === MAX_CONDITION_NODES + 1
        ? [diag(p, "too_many_conditions", `Condition trees are limited to ${MAX_CONDITION_NODES} nodes`)]
        : [];
    }
    if (depth > MAX_CONDITION_DEPTH) {
      return [diag(p, "too_deep", `Condition nesting is limited to ${MAX_CONDITION_DEPTH} levels`)];
    }
    if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
      return [diag(p, "invalid_condition", "Condition must be an object with a string `type`")];
    }
    const type = (value as { type: string }).type;
    const handler = registries.conditions.get(type);
    if (!handler) {
      return [
        diag(`${p}.type`, "unknown_condition", `Unknown condition type "${type}". Supported: ${registries.conditions.types().join(", ")}`),
      ];
    }
    const parsed = handler.schema.safeParse(value);
    if (!parsed.success) return zodDiagnostics(parsed.error, p);
    const ctx: ValidationContext = {
      path: p,
      depth,
      validateChild: (child, childPath) => visit(child, childPath, depth + 1),
    };
    return handler.check ? handler.check(parsed.data, ctx) : [];
  };
  return visit(input, path, 1);
}

/** Walk a (valid) condition tree. */
export function walkConditions(node: ConditionNode, fn: (n: ConditionNode) => void, registries: Registries = defaultRegistries()) {
  fn(node);
  const h = registries.conditions.get(node.type);
  for (const child of h?.children?.(node) ?? []) walkConditions(child, fn, registries);
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

export interface ValidateOptions {
  registries?: Registries;
  defaultSafety?: SafetyConfig;
  now?: number;
  /** Settings → fast intervals. Omit for structural validation only. */
  allowFastIntervals?: boolean;
}

export function validateRule(input: unknown, opts: ValidateOptions = {}): ValidationResult {
  const registries = opts.registries ?? defaultRegistries();
  const envelope = ruleInputSchema.safeParse(input);
  if (!envelope.success) return { valid: false, diagnostics: zodDiagnostics(envelope.error) };
  const r = envelope.data;
  const out: Diagnostic[] = [];

  // Patterns
  r.target.patterns.forEach((p, i) => {
    const problem = validatePattern(p);
    if (problem) out.push(diag(`target.patterns[${i}]`, "pattern_invalid", problem));
  });
  (r.target.exclusions ?? []).forEach((p, i) => {
    const problem = validatePattern(p);
    if (problem) out.push(diag(`target.exclusions[${i}]`, "pattern_invalid", problem));
  });

  // Trigger
  const trigger = registries.triggers.get(r.trigger.type);
  if (!trigger) {
    out.push(diag("trigger.type", "unknown_trigger", `Unknown trigger type "${r.trigger.type}". Supported: ${registries.triggers.types().join(", ")}`));
  } else {
    const parsed = trigger.schema.safeParse(r.trigger);
    if (!parsed.success) out.push(...zodDiagnostics(parsed.error, "trigger"));
    else if (trigger.check) out.push(...trigger.check(parsed.data, "trigger", { allowFastIntervals: opts.allowFastIntervals }));
  }

  // Conditions
  if (r.stopWhen) out.push(...validateCondition(r.stopWhen, "stopWhen", registries));

  // Actions
  const actions = {
    onMatched: (r.actions?.onMatched ?? (r.stopWhen ? [{ type: "stopRefresh" }, { type: "notify" }] : [])) as ActionConfig[],
    onNotMatched: (r.actions?.onNotMatched ?? (trigger?.allowsRefresh === false ? [] : [{ type: "refresh" }])) as ActionConfig[],
    ...(r.actions?.onUnknown ? { onUnknown: r.actions.onUnknown as ActionConfig[] } : {}),
  };
  for (const key of ["onMatched", "onNotMatched", "onUnknown"] as const) {
    (actions[key] ?? []).forEach((a, i) => {
      const p = `actions.${key}[${i}]`;
      const h = registries.actions.get(a.type);
      if (!h) {
        out.push(diag(`${p}.type`, "unknown_action", `Unknown action type "${a.type}". Supported: ${registries.actions.types().join(", ")}`));
        return;
      }
      const parsed = h.schema.safeParse(a);
      if (!parsed.success) out.push(...zodDiagnostics(parsed.error, p));
      if (a.type === "refresh" && trigger && !trigger.allowsRefresh) {
        out.push(diag(p, "refresh_loop", `The "${trigger.type}" trigger cannot use the refresh action (it would reload in a loop)`));
      }
    });
  }
  if (r.actions?.onMatched && r.stopWhen === undefined && r.actions.onMatched.length > 0) {
    out.push(diag("actions.onMatched", "unused_actions", "onMatched actions never run without a stopWhen condition", "warning"));
  }
  if (r.stopWhen && !actions.onMatched.some((a) => a.type === "stopRefresh" || a.type === "pauseRefresh")) {
    out.push(diag("actions.onMatched", "no_terminal_action", "The rule keeps running after its condition matches", "warning"));
  }

  // Schedule & limits
  if (r.schedule && (r.schedule.startTime === undefined) !== (r.schedule.endTime === undefined)) {
    out.push(diag("schedule", "schedule_incomplete", "startTime and endTime must be given together"));
  }
  const now = opts.now ?? Date.now();
  if (r.limits?.stopAt && Date.parse(r.limits.stopAt) <= now) {
    out.push(diag("limits.stopAt", "stop_in_past", "stopAt is in the past; the rule will not run", "warning"));
  }

  // Permission hints
  if (r.stopWhen) {
    let needsHost = false;
    walkConditions(r.stopWhen as ConditionNode, (n) => {
      if (registries.conditions.get(n.type)?.permissions.includes("host")) needsHost = true;
    }, registries);
    if (needsHost) {
      out.push(diag("stopWhen", "requires_host_permission", "DOM conditions require site access for the target pages", "warning"));
    }
  }

  const errors = out.filter((d) => d.severity === "error");
  if (errors.length) return { valid: false, diagnostics: out };

  const { maxRefreshes: legacyMax, ...safetyInput } = r.safety ?? {};
  const normalized: Rule = {
    schemaVersion: RULE_SCHEMA_VERSION,
    id: r.id ?? "",
    name: r.name,
    ...(r.description ? { description: r.description } : {}),
    enabled: r.enabled ?? true,
    priority: r.priority ?? 0,
    target: { type: "url", patterns: r.target.patterns, exclusions: r.target.exclusions ?? [] },
    trigger: r.trigger as Rule["trigger"],
    ...(r.stopWhen ? { stopWhen: r.stopWhen as ConditionNode } : {}),
    actions,
    safety: { ...(opts.defaultSafety ?? DEFAULT_SAFETY), ...safetyInput },
    limits: { ...(legacyMax !== undefined ? { maxRefreshes: legacyMax } : {}), ...(r.limits ?? {}) },
    ...(r.schedule ? { schedule: r.schedule } : {}),
    meta: { createdAt: now, updatedAt: now, revision: 0, origin: { type: "user" }, draft: false },
  };
  return { valid: true, diagnostics: out, normalized };
}
