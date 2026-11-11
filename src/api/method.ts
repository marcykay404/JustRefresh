/** How an API method is declared: its parameters, the scope an agent needs, and its handler. */
import { z } from "../core/zod";
import type { Actor, AgentScope, RuleInput } from "../core/types";

type Handler<P> = (actor: Actor, params: P) => Promise<unknown>;

export interface MethodDef<P = any> {
  scope: AgentScope | null;
  params: z.ZodMiniType<P>;
  /** Whether a successful call changed configuration (triggers reconciliation). */
  mutates?: boolean;
  handler: Handler<P>;
}

/** Declare a method (keeps its parameter type for the handler). */
export const m = <P>(def: MethodDef<P>) => def as MethodDef;

export const none = z.optional(z.strictObject({}));
export const ruleId = z.strictObject({ id: z.string().check(z.minLength(1), z.maxLength(64)) });
export const tabId = z.strictObject({ tabId: z.int().check(z.nonnegative()) });
/** Tab-specific safety overrides (popup / dashboard). */
export const tabSafety = z.strictObject({
  pauseWhileTyping: z.optional(z.boolean()),
  protectUnsavedChanges: z.optional(z.boolean()),
  inactivityGraceSeconds: z.optional(z.int().check(z.gte(0), z.lte(86400))),
  pauseOnMouse: z.optional(z.boolean()),
  pauseOnScroll: z.optional(z.boolean()),
  /** "refresh": keep refreshing a page the extension cannot observe (no site access). */
  onActivityUnavailable: z.optional(z.enum(["pause", "refresh"])),
});
/** Rule bodies are validated by validateRule (with diagnostics), not here. */
export const ruleInput = z.looseObject({}) as unknown as z.ZodMiniType<RuleInput>;
