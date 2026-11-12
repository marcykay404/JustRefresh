/**
 * Extension contracts for conditions, triggers and actions.
 *
 * Adding a new capability = implementing one of these interfaces and
 * registering it. The scheduler, engine and UI contracts do not change.
 */
import type { z } from "../core/zod";
import type { ConditionNode, Diagnostic, EvaluationResult, ExecutionStatus } from "../core/types";

export type RequiredPermission = "host" | "notifications" | "tabs";

export interface ValidationContext {
  path: string;
  depth: number;
  /** Validate a nested condition (used by logical handlers). */
  validateChild(input: unknown, path: string): Diagnostic[];
}

export interface RuleContext {
  now: number;
  tab: { id: number; url: string; status?: string };
  runtime: { refreshCount: number; navigationCount: number; startedAt: number };
  /** Evaluate a nested condition (used by logical handlers). */
  evaluateChild(node: ConditionNode): Promise<EvaluationResult>;
  /** Result of a page-side evaluation computed in a batched round-trip. */
  pageResult(node: ConditionNode): EvaluationResult;
}

export interface ConditionHandler<TConfig extends ConditionNode = ConditionNode> {
  type: string;
  title: string;
  description: string;
  /** Where the condition executes. */
  context: "page" | "browser" | "logical";
  /** Shape of the configuration (strict; unknown keys are rejected). */
  schema: z.ZodMiniType<TConfig>;
  permissions: RequiredPermission[];
  /** Extra semantic validation beyond the schema. */
  check?(config: TConfig, ctx: ValidationContext): Diagnostic[];
  /** Validate and return a typed config (throws on invalid input). */
  validate(input: unknown): TConfig;
  evaluate(config: TConfig, ctx: RuleContext): Promise<EvaluationResult>;
  /** Child nodes for logical handlers. */
  children?(config: TConfig): ConditionNode[];
}

export type TriggerEvent = "alarm" | "navigation" | "urlChange" | "startup" | "manual";

export interface TriggerHandler<TConfig extends { type: string } = { type: string }> {
  type: string;
  title: string;
  description: string;
  schema: z.ZodMiniType<TConfig>;
  /** Events that fire this trigger. "manual" is always accepted. */
  events: TriggerEvent[];
  /** For scheduled triggers: the next due timestamp. */
  nextDueAt?(config: TConfig, now: number, random: () => number): number;
  /** Whether a `refresh` action is allowed (false prevents reload loops). */
  allowsRefresh: boolean;
  check?(config: TConfig, path: string, ctx?: TriggerCheckContext): Diagnostic[];
}

/** User settings that affect which trigger configurations are allowed. */
export interface TriggerCheckContext {
  /** undefined = structural validation only (e.g. re-validating stored rules). */
  allowFastIntervals?: boolean;
}

export interface NotifyOptions {
  /** Play a short alert sound as well. */
  sound?: boolean;
}

export interface ActionContext {
  tabId: number;
  url: string;
  ruleId: string;
  ruleName: string;
  /** What the check found: why these actions run. */
  condition: "matched" | "not_matched" | "unknown";
  now: number;
  reload(opts: { bypassCache: boolean; keepScroll?: boolean }): Promise<void>;
  /** Click an element on the page. Waits like a refresh while you type or have unsaved changes (throws to postpone). */
  click(selector: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** POST JSON to a local webhook, when webhooks are switched on in Settings. */
  webhook(url: string, payload: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }>;
  setStatus(status: ExecutionStatus, reason: string, resumeAt?: number): void;
  notify(title: string, message: string, opts?: NotifyOptions): Promise<void>;
  log(level: "info" | "warn", message: string): void;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  /** Ends the current run: later non-disruptive actions (notify, log) still run, refreshes are skipped. */
  terminal?: boolean;
  /** The action reloaded the tab. */
  reloaded?: boolean;
}

export interface ActionHandler<TConfig extends { type: string } = { type: string }> {
  type: string;
  title: string;
  description: string;
  schema: z.ZodMiniType<TConfig>;
  permissions: RequiredPermission[];
  /** Disruptive actions mutate tabs or external systems. */
  disruptive: boolean;
  execute(config: TConfig, ctx: ActionContext): Promise<ActionResult>;
}

/** Helper: make a `validate()` from a schema. */
export function schemaValidator<T>(schema: z.ZodMiniType<T>): (input: unknown) => T {
  return (input) => schema.parse(input);
}
