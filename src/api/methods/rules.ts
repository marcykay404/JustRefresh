/** Rules: discover, validate, create, edit, test, switch on/off, delete. */
import { urlPatternSchema } from "../../core/pattern-schema";
import { matchingRules, resolveTab } from "../../core/rule-resolver";
import { validateRule } from "../../core/rule-schema";
import type { RuleInput } from "../../core/types";
import { STATUS_LABELS } from "../../core/types";
import { compilePattern, matchesAny, patternToString, validatePattern } from "../../core/url-pattern";
import { z } from "../../core/zod";
import { buildCapabilities, NO_SCHEMAS } from "../capabilities";
import { ApiError, assertCanModify, redactUrl } from "../permissions";
import { m, none, ruleId, ruleInput, type MethodDef } from "../method";
import type { ServiceInternals } from "../rule-api";

export function rulesMethods(svc: ServiceInternals): Record<string, MethodDef> {
  const d = svc.deps;
  return {
    getCapabilities: m({
      scope: "rules:read",
      params: none,
      handler: async () =>
        buildCapabilities(
          svc.registries,
          (await d.config.get()).settings,
          (await d.schemas?.().catch((e: Error) => {
            console.warn("JustRefresh: JSON Schemas unavailable for capabilities", e);
            return null;
          })) ?? NO_SCHEMAS,
        ),
    }),
    listRules: m({
      scope: "rules:read",
      params: none,
      handler: async (actor) =>
        svc.rulesFor(
          actor,
          Object.values((await d.config.get()).rules).sort((a, b) => b.priority - a.priority || a.meta.createdAt - b.meta.createdAt),
        ),
    }),
    getRule: m({ scope: "rules:read", params: ruleId, handler: async (actor, p) => (await svc.rulesFor(actor, [await svc.getRuleOrThrow(p.id)]))[0] }),
    validateRule: m({
      scope: "rules:read",
      params: z.strictObject({ rule: z.unknown() }),
      handler: async (_a, p) => {
        const config = await d.config.get();
        const v = validateRule(p.rule, {
          registries: svc.registries,
          defaultSafety: config.settings.defaultSafety,
          now: d.clock.now(),
          allowFastIntervals: config.settings.allowFastIntervals,
        });
        return { valid: v.valid, diagnostics: v.diagnostics, normalized: v.normalized ? svc.stripMeta(v.normalized) : undefined };
      },
    }),
    createRule: m({
      scope: "rules:write",
      params: z.strictObject({ rule: ruleInput }),
      mutates: true,
      handler: async (actor, p) => svc.saveRule(actor, p.rule, null),
    }),
    updateRule: m({
      scope: "rules:write",
      params: z.strictObject({ id: z.string().check(z.minLength(1), z.maxLength(64)), patch: ruleInput, expectedRevision: z.optional(z.int()) }),
      mutates: true,
      handler: async (actor, p) => {
        const existing = await svc.getRuleOrThrow(p.id);
        assertCanModify(actor, existing);
        if (p.expectedRevision !== undefined && p.expectedRevision !== existing.meta.revision) {
          throw new ApiError("conflict", `Rule was modified (revision ${existing.meta.revision}, expected ${p.expectedRevision})`);
        }
        const merged = { ...svc.stripMeta(existing), ...p.patch, id: existing.id } as RuleInput;
        return svc.saveRule(actor, merged, existing);
      },
    }),
    deleteRule: m({
      scope: "rules:delete",
      params: z.strictObject({ id: z.string().check(z.minLength(1), z.maxLength(64)), expectedRevision: z.optional(z.int()) }),
      mutates: true,
      handler: async (actor, p) => {
        const existing = await svc.getRuleOrThrow(p.id);
        assertCanModify(actor, existing);
        if (p.expectedRevision !== undefined && p.expectedRevision !== existing.meta.revision) {
          throw new ApiError("conflict", "Rule was modified since it was read");
        }
        if (actor.type === "agent" && existing.enabled) {
          const pending = await svc.requestApproval(actor, "delete", existing);
          if (pending) return pending;
        }
        await d.config.update((c) => {
          delete c.rules[p.id];
        });
        return { status: "deleted" };
      },
    }),
    testRule: m({
      scope: "rules:test",
      params: z.strictObject({ rule: z.unknown(), tabId: z.int().check(z.nonnegative()) }),
      handler: async (actor, p) => {
        const config = await d.config.get();
        const v = validateRule(p.rule, {
          registries: svc.registries,
          defaultSafety: config.settings.defaultSafety,
          now: d.clock.now(),
          allowFastIntervals: config.settings.allowFastIntervals,
        });
        if (!v.valid) return { valid: false, diagnostics: v.diagnostics };
        const tab = await d.browser.getTab(p.tabId);
        if (!tab) throw new ApiError("not_found", "Tab not found");
        const rule = v.normalized!;
        const targets = !!matchesAny(rule.target.patterns, tab.url) && !matchesAny(rule.target.exclusions, tab.url);
        const res = resolveTab(tab, {
          ...config,
          rules: { ...config.rules, [rule.id || "__test__"]: { ...rule, id: rule.id || "__test__", enabled: true, meta: { ...rule.meta, draft: false } } },
        });
        const hostAccess = await d.hostAccess(tab.url).catch(() => false);
        const dry = await d.engine.dryRun(rule, p.tabId, actor.type !== "agent");
        const explanations: string[] = [];
        if (!targets) explanations.push("The rule's URL patterns do not match this tab");
        if (res.kind !== "controller") explanations.push(`If activated, this tab would not run it: ${res.reason}`);
        else if (res.controller.id !== (rule.id || "__test__")) explanations.push(`Another controller has precedence on this tab: ${res.controller.name}`);
        if (!hostAccess && rule.stopWhen) explanations.push("Site access is not granted; DOM conditions will report unknown");
        return {
          valid: true,
          diagnostics: v.diagnostics,
          tab: { id: tab.id, title: tab.title, url: actor.type === "agent" ? redactUrl(tab.url, config.settings.redactUrlsForAgents) : tab.url },
          targetsTab: targets,
          hostAccess,
          result: dry.ok ? dry.result : { status: "unknown", reason: dry.error },
          trace: dry.ok ? dry.trace : null,
          explanations,
          sideEffects: "none (dry run: no refresh, no actions executed)",
        };
      },
    }),
    enableRule: m({
      scope: "rules:activate",
      params: ruleId,
      mutates: true,
      handler: async (actor, p) => {
        const rule = await svc.getRuleOrThrow(p.id);
        if (actor.type === "agent") {
          assertCanModify(actor, rule);
          const pending = await svc.requestApproval(actor, "activate", rule);
          if (pending) return pending;
        }
        await svc.setEnabled(p.id, true);
        return { status: "enabled" };
      },
    }),
    disableRule: m({
      scope: "rules:activate",
      params: ruleId,
      mutates: true,
      handler: async (_actor, p) => {
        // Disabling is always safe; agents may disable any rule.
        await svc.setEnabled(p.id, false);
        return { status: "disabled" };
      },
    }),
    getRuleStatus: m({
      scope: "status:read",
      params: ruleId,
      handler: async (actor, p) => {
        const rule = await svc.getRuleOrThrow(p.id);
        const config = await d.config.get();
        const runtimes = (await d.runtime.getAll()).filter((r) => r.controllerId === rule.id);
        const approvals = config.approvals.filter((a) => a.ruleId === rule.id && a.status === "pending");
        return {
          id: rule.id,
          enabled: rule.enabled,
          draft: rule.meta.draft,
          revision: rule.meta.revision,
          pendingApprovals: approvals.map((a) => ({ id: a.id, kind: a.kind })),
          tabs: runtimes.map((r) => ({
            tabId: r.tabId,
            url: actor.type === "agent" ? redactUrl(r.url, config.settings.redactUrlsForAgents) : r.url,
            status: r.status,
            statusLabel: STATUS_LABELS[r.status],
            reason: r.reason,
            nextDueAt: r.nextDueAt,
            lastAttemptAt: r.lastAttemptAt,
            refreshCount: r.refreshCount,
            lastEvaluation: r.lastEvaluation,
            lastError: r.lastError,
          })),
        };
      },
    }),
    duplicateRule: m({
      scope: null,
      params: ruleId,
      mutates: true,
      handler: async (actor, p) => {
        const r = await svc.getRuleOrThrow(p.id);
        const input = { ...svc.stripMeta(r), id: undefined, name: `${r.name} (copy)`.slice(0, 100), enabled: false };
        return svc.saveRule(actor, input as RuleInput, null);
      },
    }),
    testPattern: m({
      scope: null,
      params: z.strictObject({ pattern: urlPatternSchema, url: z.string().check(z.maxLength(8192)) }),
      handler: async (_a, p) => {
        const problem = validatePattern(p.pattern);
        if (problem) return { valid: false, error: problem };
        const compiled = compilePattern(p.pattern);
        const config = await d.config.get();
        return {
          valid: true,
          type: compiled.type,
          matches: compiled.test(p.url),
          rulesMatchingUrl: matchingRules(Object.values(config.rules), p.url).map((r) => ({ id: r.id, name: r.name, priority: r.priority })),
          excludedBy: config.exclusions.filter((e) => matchesAny([e.pattern], p.url)).map((e) => patternToString(e.pattern)),
        };
      },
    }),
    testSelector: m({
      scope: null,
      params: z.strictObject({ tabId: z.int().check(z.nonnegative()), selector: z.string().check(z.minLength(1), z.maxLength(500)) }),
      handler: async (_a, p) => {
        if (!d.testSelector) throw new ApiError("unsupported_method", "Selector testing unavailable");
        return d.testSelector(p.tabId, p.selector, true);
      },
    }),
    // The user picks an element in a tab; the selector goes straight back to the builder page.
    startPicker: m({
      scope: null,
      params: z.strictObject({ tabId: z.int().check(z.nonnegative()), session: z.string().check(z.regex(/^[\w-]{1,64}$/)) }),
      handler: async (_a, p) => {
        if (!d.picker) throw new ApiError("unsupported_method", "The element picker is unavailable");
        const r = await d.picker.start(p.tabId, p.session);
        if (!r.ok) throw new ApiError("conflict", `Can't pick on that tab: ${r.error}`);
        return { started: true };
      },
    }),
    cancelPicker: m({
      scope: null,
      params: z.strictObject({ tabId: z.int().check(z.nonnegative()) }),
      handler: async (_a, p) => {
        await d.picker?.cancel(p.tabId);
        return { cancelled: true };
      },
    }),
  };
}
