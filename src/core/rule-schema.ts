/**
 * Authoritative rule validation.
 *
 * The rule *envelope* is described with zod; trigger/condition/action nodes
 * are validated by their registry handlers so that adding a handler extends
 * the schema automatically. `schemas/rule.schema.json` is generated from the
 * same sources (see scripts/gen-schema.ts) for external agents and tooling.
 */
import { z } from "./zod";
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

const node = z.looseObject({ type: z.string().check(z.minLength(1), z.maxLength(64)) });

export const safetyInputSchema = z.strictObject({
  pauseWhileTyping: z.optional(z.boolean()),
  protectUnsavedChanges: z.optional(z.boolean()),
  inactivityGraceSeconds: z.optional(z.int().check(z.gte(0), z.lte(24 * 3600))),
  pauseOnMouse: z.optional(z.boolean()),
  pauseOnScroll: z.optional(z.boolean()),
  onUnknown: z.optional(z.enum(["pause", "skip", "refresh", "stop"])),
  maxUnknownRetries: z.optional(z.int().check(z.gte(0), z.lte(100))),
  onActivityUnavailable: z.optional(z.enum(["pause", "refresh"])),
  /** Accepted for compatibility; normalized into `limits.maxRefreshes`. */
  maxRefreshes: z.optional(z.int().check(z.gte(1), z.lte(1_000_000))),
});

export const limitsSchema = z.strictObject({
  maxRefreshes: z.optional(z.int().check(z.gte(1), z.lte(1_000_000))).check(z.describe("Stop after this many refreshes; the rule's clicks count too")),
  maxDurationSeconds: z.optional(z.int().check(z.gte(30), z.lte(365 * 24 * 3600))),
  stopAt: z.optional(z.iso.datetime({ offset: true })),
});

const timeOfDay = z.string().check(z.regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM"));
export const scheduleSchema = z.strictObject({
  days: z.optional(z.array(z.int().check(z.gte(0), z.lte(6))).check(z.maxLength(7))),
  startTime: z.optional(timeOfDay),
  endTime: z.optional(timeOfDay),
});

export const ruleInputSchema = z.strictObject({
  schemaVersion: z.optional(z.literal(RULE_SCHEMA_VERSION)),
  id: z.optional(z.string().check(z.regex(RULE_ID_PATTERN, "IDs may contain letters, digits, '.', '_' and '-' (max 64)"))),
  name: z.string().check(z.trim(), z.minLength(1, "Give the rule a name"), z.maxLength(100)),
  description: z.optional(z.string().check(z.maxLength(500))),
  enabled: z.optional(z.boolean()),
  priority: z.optional(z.int().check(z.gte(-1000), z.lte(1000))),
  target: z.strictObject({
    type: z.optional(z.literal("url")),
    patterns: z.array(urlPatternSchema).check(z.minLength(1), z.maxLength(50)),
    exclusions: z.optional(z.array(urlPatternSchema).check(z.maxLength(50))),
  }),
  trigger: node,
  stopWhen: z.optional(node),
  actions: z.optional(
    z.strictObject({
      onMatched: z.optional(z.array(node).check(z.maxLength(MAX_ACTIONS))),
      onNotMatched: z.optional(z.array(node).check(z.maxLength(MAX_ACTIONS))),
      onUnknown: z.optional(z.array(node).check(z.maxLength(MAX_ACTIONS))),
    }),
  ),
  safety: z.optional(safetyInputSchema),
  limits: z.optional(limitsSchema),
  schedule: z.optional(scheduleSchema),
  /** Managed by the API; ignored on input. */
  meta: z.optional(z.unknown()),
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

export function zodDiagnostics(error: z.core.$ZodError, prefix = ""): Diagnostic[] {
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
      return nodes === MAX_CONDITION_NODES + 1 ? [diag(p, "too_many_conditions", `Condition trees are limited to ${MAX_CONDITION_NODES} nodes`)] : [];
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
      return [diag(`${p}.type`, "unknown_condition", `Unknown condition type "${type}". Supported: ${registries.conditions.types().join(", ")}`)];
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
  const now = opts.now ?? Date.now();
  const trigger = registries.triggers.get(r.trigger.type);
  const actions = actionLists(r, trigger);
  const out: Diagnostic[] = [
    ...checkPatterns(r),
    ...checkTrigger(r, registries, opts.allowFastIntervals),
    ...(r.stopWhen ? validateCondition(r.stopWhen, "stopWhen", registries) : []),
    ...checkActions(r, actions, registries, trigger),
    ...checkScheduleAndLimits(r, now),
    ...permissionHints(r, registries),
  ];
  if (out.some((d) => d.severity === "error")) return { valid: false, diagnostics: out };
  return { valid: true, diagnostics: out, normalized: normalizeRule(r, actions, opts.defaultSafety, now) };
}

type TriggerHandlerOf<R extends Registries> = ReturnType<R["triggers"]["get"]>;

function checkPatterns(r: ParsedRuleInput): Diagnostic[] {
  const check = (list: ParsedRuleInput["target"]["patterns"], key: string) =>
    list.flatMap((p, i) => {
      const problem = validatePattern(p);
      return problem ? [diag(`target.${key}[${i}]`, "pattern_invalid", problem)] : [];
    });
  return [...check(r.target.patterns, "patterns"), ...check(r.target.exclusions ?? [], "exclusions")];
}

function checkTrigger(r: ParsedRuleInput, registries: Registries, allowFastIntervals: boolean | undefined): Diagnostic[] {
  const trigger = registries.triggers.get(r.trigger.type);
  if (!trigger)
    return [diag("trigger.type", "unknown_trigger", `Unknown trigger type "${r.trigger.type}". Supported: ${registries.triggers.types().join(", ")}`)];
  const parsed = trigger.schema.safeParse(r.trigger);
  if (!parsed.success) return zodDiagnostics(parsed.error, "trigger");
  return trigger.check ? trigger.check(parsed.data, "trigger", { allowFastIntervals }) : [];
}

/** The rule's action lists, with defaults: stop and notify on a match; refresh otherwise (when the trigger may refresh). */
function actionLists(r: ParsedRuleInput, trigger: TriggerHandlerOf<Registries>): Rule["actions"] {
  return {
    onMatched: (r.actions?.onMatched ?? (r.stopWhen ? [{ type: "stopRefresh" }, { type: "notify" }] : [])) as ActionConfig[],
    onNotMatched: (r.actions?.onNotMatched ?? (trigger?.allowsRefresh === false ? [] : [{ type: "refresh" }])) as ActionConfig[],
    ...(r.actions?.onUnknown ? { onUnknown: r.actions.onUnknown as ActionConfig[] } : {}),
  };
}

function checkActions(r: ParsedRuleInput, actions: Rule["actions"], registries: Registries, trigger: TriggerHandlerOf<Registries>): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const key of ["onMatched", "onNotMatched", "onUnknown"] as const) {
    (actions[key] ?? []).forEach((a, i) => out.push(...checkAction(a, `actions.${key}[${i}]`, registries, trigger)));
  }
  if (r.actions?.onMatched?.length && r.stopWhen === undefined) {
    out.push(diag("actions.onMatched", "unused_actions", "onMatched actions never run without a stopWhen condition", "warning"));
  }
  if (r.stopWhen && !actions.onMatched.some((a) => a.type === "stopRefresh" || a.type === "pauseRefresh")) {
    out.push(diag("actions.onMatched", "no_terminal_action", "The rule keeps running after its condition matches", "warning"));
  }
  return out;
}

function checkAction(a: ActionConfig, p: string, registries: Registries, trigger: TriggerHandlerOf<Registries>): Diagnostic[] {
  const h = registries.actions.get(a.type);
  if (!h) return [diag(`${p}.type`, "unknown_action", `Unknown action type "${a.type}". Supported: ${registries.actions.types().join(", ")}`)];
  const parsed = h.schema.safeParse(a);
  const out = parsed.success ? [] : zodDiagnostics(parsed.error, p);
  if (a.type === "refresh" && trigger && !trigger.allowsRefresh) {
    out.push(diag(p, "refresh_loop", `The "${trigger.type}" trigger cannot use the refresh action (it would reload in a loop)`));
  }
  if (a.type === "click" && trigger && !trigger.allowsRefresh) {
    out.push(diag(p, "click_loop", `The "${trigger.type}" trigger cannot use the click action (a click that loads a page would run it again, in a loop)`));
  }
  if (a.type === "highlight" && !a.selector && !a.text) {
    out.push(diag(p, "highlight_target", "Say what to highlight: an element (selector), a text, or both"));
  }
  return out;
}

function checkScheduleAndLimits(r: ParsedRuleInput, now: number): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (r.schedule && (r.schedule.startTime === undefined) !== (r.schedule.endTime === undefined)) {
    out.push(diag("schedule", "schedule_incomplete", "startTime and endTime must be given together"));
  }
  if (r.limits?.stopAt && Date.parse(r.limits.stopAt) <= now) {
    out.push(diag("limits.stopAt", "stop_in_past", "stopAt is in the past; the rule will not run", "warning"));
  }
  return out;
}

/** DOM conditions need site access for the pages: say so up front. */
function permissionHints(r: ParsedRuleInput, registries: Registries): Diagnostic[] {
  if (!r.stopWhen) return [];
  let needsHost = false;
  walkConditions(
    r.stopWhen as ConditionNode,
    (n) => {
      if (registries.conditions.get(n.type)?.permissions.includes("host")) needsHost = true;
    },
    registries,
  );
  return needsHost ? [diag("stopWhen", "requires_host_permission", "DOM conditions require site access for the target pages", "warning")] : [];
}

function normalizeRule(r: ParsedRuleInput, actions: Rule["actions"], defaultSafety: SafetyConfig | undefined, now: number): Rule {
  const { maxRefreshes: legacyMax, ...safetyInput } = r.safety ?? {};
  return {
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
    safety: { ...(defaultSafety ?? DEFAULT_SAFETY), ...safetyInput },
    limits: { ...(legacyMax !== undefined ? { maxRefreshes: legacyMax } : {}), ...(r.limits ?? {}) },
    ...(r.schedule ? { schedule: r.schedule } : {}),
    meta: { createdAt: now, updatedAt: now, revision: 0, origin: { type: "user" }, draft: false },
  };
}
