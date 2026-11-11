/**
 * Rule Management API — the single entry point for the popup, dashboard,
 * rule builder, JSON import, external extensions and the MCP bridge.
 *
 * Every method has a strict parameter schema (unknown arguments are
 * rejected), an authorization scope, and goes through centralized
 * validation. Agents are audited.
 */
import { z } from "zod";
import { defaultRegistries, type Registries } from "../registries";
import { validateRule, zodDiagnostics } from "../core/rule-schema";
import { compilePattern, matchesAny, patternToString, validatePattern } from "../core/url-pattern";
import { detectRuleConflicts, matchingRules, resolveTab } from "../core/rule-resolver";
import { urlPatternSchema } from "../core/pattern-schema";
import type { BrowserPort, ClockPort, RuleEngine } from "../core/rule-engine";
import { STATUS_LABELS } from "../core/types";
import type {
  Actor,
  AgentRecord,
  AgentScope,
  ApprovalRequest,
  AuditEntry,
  Config,
  Exclusion,
  HistoryEntry,
  Rule,
  RuleInput,
  Settings,
  TabInfo,
  TabOverride,
  TabRuntime,
} from "../core/types";
import { ALL_AGENT_SCOPES, RULE_SCHEMA_VERSION } from "../core/types";
import { defaultConfig } from "../core/defaults";
import { MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS } from "../triggers/interval";
import { agentFor, ApiError, assertCanModify, authorize, redactUrl } from "./permissions";
import { buildCapabilities } from "./capabilities";
import { exportBundle, parseImport, type ImportReport } from "../integrations/json-import";

export interface ApiDeps {
  config: { get(): Promise<Config>; update(fn: (c: Config) => Config | void): Promise<Config>; replace(c: Config): Promise<Config> };
  runtime: { get(tabId: number): Promise<TabRuntime | null>; getAll(): Promise<TabRuntime[]> };
  history: { append(e: HistoryEntry): Promise<void>; list(): Promise<HistoryEntry[]>; clear(): Promise<void> };
  audit: { append(e: AuditEntry): Promise<void>; list(): Promise<AuditEntry[]>; clear(): Promise<void> };
  engine: RuleEngine;
  browser: BrowserPort;
  clock: ClockPort;
  hostAccess: (url: string) => Promise<boolean>;
  testSelector?: (tabId: number, selector: string, includeText: boolean) => Promise<unknown>;
  registries?: Registries;
  /** Generate ids (injectable for tests). */
  newId?: (prefix: string) => string;
}

type Handler<P> = (actor: Actor, params: P) => Promise<unknown>;

interface MethodDef<P = any> {
  scope: AgentScope | null;
  params: z.ZodType<P>;
  /** Whether a successful call changed configuration (triggers reconciliation). */
  mutates?: boolean;
  handler: Handler<P>;
}

/** "Last seen" is informational: record it at most this often (each write rewrites the config). */
export const AGENT_LAST_SEEN_RESOLUTION_MS = 60_000;

const none = z.strictObject({}).optional();
const ruleId = z.strictObject({ id: z.string().min(1).max(64) });
const tabId = z.strictObject({ tabId: z.number().int().nonnegative() });
/** Tab-specific safety overrides (popup / dashboard). */
const tabSafety = z.strictObject({
  pauseWhileTyping: z.boolean().optional(),
  protectUnsavedChanges: z.boolean().optional(),
  inactivityGraceSeconds: z.number().int().min(0).max(86400).optional(),
  pauseOnMouse: z.boolean().optional(),
  pauseOnScroll: z.boolean().optional(),
  /** "refresh": keep refreshing a page the extension cannot observe (no site access). */
  onActivityUnavailable: z.enum(["pause", "refresh"]).optional(),
});

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export class RuleManagementService {
  private readonly registries: Registries;
  private readonly methods: Record<string, MethodDef>;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly deps: ApiDeps) {
    this.registries = deps.registries ?? defaultRegistries();
    this.newId = deps.newId ?? randomId;
    this.methods = this.defineMethods();
  }

  listMethods(): { name: string; scope: AgentScope | null }[] {
    return Object.entries(this.methods).map(([name, m]) => ({ name, scope: m.scope }));
  }

  /** Dispatch a call with validation, authorization and auditing. */
  async call(actor: Actor, method: string, rawParams: unknown): Promise<unknown> {
    const def = Object.prototype.hasOwnProperty.call(this.methods, method) ? this.methods[method] : undefined;
    const audit = (outcome: AuditEntry["outcome"], detail?: string, ruleId?: string) => {
      if (actor.type === "agent") void this.deps.audit.append({ at: this.deps.clock.now(), agentId: actor.agentId, operation: method, outcome, detail, ruleId });
    };
    try {
      if (!def) throw new ApiError("unsupported_method", `Unknown method "${method}"`);
      const config = await this.deps.config.get();
      authorize(actor, def.scope, config);
      const parsed = def.params.safeParse(rawParams ?? undefined);
      if (!parsed.success) throw new ApiError("invalid_params", "Invalid parameters", zodDiagnostics(parsed.error, "params"));
      if (actor.type === "agent") {
        const now = this.deps.clock.now();
        const seen = config.agents[actor.agentId]?.lastSeenAt ?? 0;
        if (now - seen >= AGENT_LAST_SEEN_RESOLUTION_MS) {
          await this.deps.config.update((c) => {
            if (c.agents[actor.agentId]) c.agents[actor.agentId].lastSeenAt = now;
          });
        }
      }
      const result = await def.handler(actor, parsed.data);
      if (def.mutates) await this.deps.engine.reconcileAll("config");
      const pending = result && typeof result === "object" && (result as { status?: string }).status === "pending_approval";
      audit(pending ? "pending_approval" : "ok", undefined, (parsed.data as { id?: string })?.id);
      return result;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("internal", (e as Error).message);
      audit(err.code === "forbidden" || err.code === "pairing_required" ? "denied" : "error", err.message);
      throw err;
    }
  }

  /* ------------------------------------------------------------------ */

  private async tabsFor(actor: Actor): Promise<TabInfo[]> {
    const tabs = await this.deps.browser.listTabs();
    if (actor.type !== "agent") return tabs;
    const redact = (await this.deps.config.get()).settings.redactUrlsForAgents;
    return tabs.map((t) => ({ ...t, url: redactUrl(t.url, redact) }));
  }

  private async getRuleOrThrow(id: string): Promise<Rule> {
    const r = (await this.deps.config.get()).rules[id];
    if (!r) throw new ApiError("not_found", `Rule "${id}" not found`);
    return r;
  }

  private validateOrThrow(input: unknown, config: Config) {
    const v = validateRule(input, { registries: this.registries, defaultSafety: config.settings.defaultSafety, now: this.deps.clock.now() });
    if (!v.valid) throw new ApiError("validation_failed", "Rule failed validation", v.diagnostics);
    return v;
  }

  /** Create or replace a rule, applying ownership/draft policy. */
  private async saveRule(actor: Actor, input: RuleInput, existing: Rule | null): Promise<Rule> {
    const now = this.deps.clock.now();
    let saved!: Rule;
    await this.deps.config.update((c) => {
      const v = this.validateOrThrow(input, c);
      const n = v.normalized!;
      const id = existing?.id ?? (n.id || this.newId("rule"));
      if (!existing && c.rules[id]) throw new ApiError("conflict", `A rule with id "${id}" already exists`);
      const isAgent = actor.type === "agent";
      const origin = existing?.meta.origin ?? (isAgent ? { type: "agent" as const, agentId: actor.agentId } : { type: "user" as const });
      // Agents never activate directly: their writes always produce drafts.
      const enabled = isAgent ? false : n.enabled;
      const draft = isAgent ? true : existing ? existing.meta.draft && !enabled : false;
      saved = {
        ...n,
        id,
        enabled,
        meta: {
          createdAt: existing?.meta.createdAt ?? now,
          updatedAt: now,
          revision: (existing?.meta.revision ?? 0) + 1,
          origin,
          draft,
        },
      };
      c.rules[id] = saved;
      // Any pending approval for an older revision is now stale.
      for (const a of c.approvals) if (a.ruleId === id && a.status === "pending") a.status = "stale";
    });
    return saved;
  }

  private stripMeta(rule: Rule): RuleInput {
    const { meta: _meta, ...rest } = rule;
    return rest as unknown as RuleInput;
  }

  private async requestApproval(actor: Actor, kind: ApprovalRequest["kind"], rule: Rule) {
    const config = await this.deps.config.get();
    const agent = agentFor(actor, config)!;
    if (agent.trustedActivation) return null;
    const req: ApprovalRequest = {
      id: this.newId("approval"),
      kind,
      ruleId: rule.id,
      ruleRevision: rule.meta.revision,
      agentId: agent.id,
      createdAt: this.deps.clock.now(),
      status: "pending",
    };
    await this.deps.config.update((c) => {
      c.approvals = c.approvals.filter((a) => !(a.ruleId === rule.id && a.kind === kind && a.status === "pending"));
      c.approvals.push(req);
      c.approvals = c.approvals.slice(-200);
    });
    return { status: "pending_approval" as const, approvalId: req.id, message: "Waiting for the user to approve in the extension dashboard" };
  }

  private async setEnabled(id: string, enabled: boolean) {
    await this.deps.config.update((c) => {
      const r = c.rules[id];
      if (!r) throw new ApiError("not_found", `Rule "${id}" not found`);
      r.enabled = enabled;
      if (enabled) r.meta.draft = false;
      r.meta.updatedAt = this.deps.clock.now();
      r.meta.revision++;
    });
  }

  private async updateOverride(tabIdValue: number, fn: (o: TabOverride | undefined, tab: TabInfo) => TabOverride | undefined) {
    const tab = await this.deps.browser.getTab(tabIdValue);
    if (!tab) throw new ApiError("not_found", "Tab not found");
    await this.deps.config.update((c) => {
      const key = String(tabIdValue);
      const next = fn(c.tabOverrides[key], tab);
      if (next) c.tabOverrides[key] = { ...next, revision: (c.tabOverrides[key]?.revision ?? 0) + 1 };
      else delete c.tabOverrides[key];
    });
    return this.deps.engine.syncTab(tabIdValue);
  }

  private newOverride(tab: TabInfo, partial: Partial<TabOverride>): TabOverride {
    return {
      tabId: tab.id,
      mode: "custom",
      revision: 0,
      createdAt: this.deps.clock.now(),
      restore: { url: tab.url, windowIndex: tab.windowId, tabIndex: tab.index, title: tab.title },
      ...partial,
    };
  }

  async tabState(tabIdValue: number) {
    const tab = await this.deps.browser.getTab(tabIdValue);
    if (!tab) throw new ApiError("not_found", "Tab not found");
    const config = await this.deps.config.get();
    const res = resolveTab(tab, config);
    const runtime = await this.deps.runtime.get(tabIdValue);
    const controller = res.kind === "controller" ? res.controller : res.kind === "paused" ? res.controller : null;
    return {
      tab,
      runtime,
      statusLabel: runtime ? STATUS_LABELS[runtime.status] : res.kind === "restricted" || res.kind.endsWith("excluded") ? "Excluded" : "Idle",
      resolution: {
        kind: res.kind,
        reason: "reason" in res ? res.reason : undefined,
        controllerId: controller?.id ?? null,
        controllerName: controller?.name ?? null,
        source: res.kind === "controller" ? res.source : null,
        candidates: res.kind === "controller" ? res.candidates.map((r) => ({ id: r.id, name: r.name, priority: r.priority })) : [],
      },
      override: config.tabOverrides[String(tabIdValue)] ?? null,
      interval: controller?.trigger.type === "interval" ? (controller.trigger as unknown as { seconds: number }).seconds : null,
      safety: controller?.safety ?? config.settings.defaultSafety,
      hostAccess: await this.deps.hostAccess(tab.url).catch(() => false),
    };
  }

  /* ------------------------------------------------------------------ */

  private defineMethods(): Record<string, MethodDef> {
    const d = this.deps;
    const m = <P>(def: MethodDef<P>) => def as MethodDef;
    const ruleInput = z.looseObject({}) as unknown as z.ZodType<RuleInput>;

    return {
      /* ------------- Agent-facing (scoped) ------------- */
      getCapabilities: m({
        scope: "rules:read",
        params: none,
        handler: async () => buildCapabilities(this.registries),
      }),
      listTabs: m({
        scope: "tabs:read",
        params: none,
        handler: async (actor) => this.tabsFor(actor),
      }),
      listRules: m({
        scope: "rules:read",
        params: none,
        handler: async () => Object.values((await d.config.get()).rules).sort((a, b) => b.priority - a.priority || a.meta.createdAt - b.meta.createdAt),
      }),
      getRule: m({ scope: "rules:read", params: ruleId, handler: async (_a, p) => this.getRuleOrThrow(p.id) }),
      validateRule: m({
        scope: "rules:read",
        params: z.strictObject({ rule: z.unknown() }),
        handler: async (_a, p) => {
          const config = await d.config.get();
          const v = validateRule(p.rule, { registries: this.registries, defaultSafety: config.settings.defaultSafety, now: d.clock.now() });
          return { valid: v.valid, diagnostics: v.diagnostics, normalized: v.normalized ? this.stripMeta(v.normalized) : undefined };
        },
      }),
      createRule: m({
        scope: "rules:write",
        params: z.strictObject({ rule: ruleInput }),
        mutates: true,
        handler: async (actor, p) => this.saveRule(actor, p.rule, null),
      }),
      updateRule: m({
        scope: "rules:write",
        params: z.strictObject({ id: z.string().min(1).max(64), patch: ruleInput, expectedRevision: z.number().int().optional() }),
        mutates: true,
        handler: async (actor, p) => {
          const existing = await this.getRuleOrThrow(p.id);
          assertCanModify(actor, existing);
          if (p.expectedRevision !== undefined && p.expectedRevision !== existing.meta.revision) {
            throw new ApiError("conflict", `Rule was modified (revision ${existing.meta.revision}, expected ${p.expectedRevision})`);
          }
          const merged = { ...this.stripMeta(existing), ...p.patch, id: existing.id } as RuleInput;
          return this.saveRule(actor, merged, existing);
        },
      }),
      deleteRule: m({
        scope: "rules:delete",
        params: z.strictObject({ id: z.string().min(1).max(64), expectedRevision: z.number().int().optional() }),
        mutates: true,
        handler: async (actor, p) => {
          const existing = await this.getRuleOrThrow(p.id);
          assertCanModify(actor, existing);
          if (p.expectedRevision !== undefined && p.expectedRevision !== existing.meta.revision) {
            throw new ApiError("conflict", "Rule was modified since it was read");
          }
          if (actor.type === "agent" && existing.enabled) {
            const pending = await this.requestApproval(actor, "delete", existing);
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
        params: z.strictObject({ rule: z.unknown(), tabId: z.number().int().nonnegative() }),
        handler: async (actor, p) => {
          const config = await d.config.get();
          const v = validateRule(p.rule, { registries: this.registries, defaultSafety: config.settings.defaultSafety, now: d.clock.now() });
          if (!v.valid) return { valid: false, diagnostics: v.diagnostics };
          const tab = await d.browser.getTab(p.tabId);
          if (!tab) throw new ApiError("not_found", "Tab not found");
          const rule = v.normalized!;
          const targets = !!matchesAny(rule.target.patterns, tab.url) && !matchesAny(rule.target.exclusions, tab.url);
          const res = resolveTab(tab, { ...config, rules: { ...config.rules, [rule.id || "__test__"]: { ...rule, id: rule.id || "__test__", enabled: true, meta: { ...rule.meta, draft: false } } } });
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
          const rule = await this.getRuleOrThrow(p.id);
          if (actor.type === "agent") {
            assertCanModify(actor, rule);
            const pending = await this.requestApproval(actor, "activate", rule);
            if (pending) return pending;
          }
          await this.setEnabled(p.id, true);
          return { status: "enabled" };
        },
      }),
      disableRule: m({
        scope: "rules:activate",
        params: ruleId,
        mutates: true,
        handler: async (_actor, p) => {
          // Disabling is always safe; agents may disable any rule.
          await this.setEnabled(p.id, false);
          return { status: "disabled" };
        },
      }),
      getRuleStatus: m({
        scope: "status:read",
        params: ruleId,
        handler: async (actor, p) => {
          const rule = await this.getRuleOrThrow(p.id);
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
      getHistory: m({
        scope: "status:read",
        params: z.strictObject({ limit: z.number().int().min(1).max(500).optional(), ruleId: z.string().optional() }).optional(),
        handler: async (actor, p) => {
          let h = await d.history.list();
          if (p?.ruleId) h = h.filter((e) => e.ruleId === p.ruleId);
          h = h.slice(-(p?.limit ?? 100)).reverse();
          if (actor.type === "agent") {
            const redact = (await d.config.get()).settings.redactUrlsForAgents;
            h = h.map((e) => ({ ...e, url: e.url ? redactUrl(e.url, redact) : undefined }));
          }
          return h;
        },
      }),

      /* ------------- User-only ------------- */
      getOverview: m({
        scope: null,
        params: none,
        handler: async () => {
          const config = await d.config.get();
          const tabs = await d.browser.listTabs();
          const runtimes = new Map((await d.runtime.getAll()).map((r) => [r.tabId, r]));
          const rows = tabs.map((tab) => {
            const res = resolveTab(tab, config);
            const rt = runtimes.get(tab.id) ?? null;
            const controller = res.kind === "controller" ? res.controller : null;
            return {
              tab,
              runtime: rt,
              status: rt?.status ?? (res.kind === "restricted" || res.kind.endsWith("excluded") ? "excluded" : "idle"),
              reason: rt?.reason ?? ("reason" in res ? res.reason : undefined),
              controllerId: controller?.id ?? rt?.controllerId ?? null,
              controllerName: controller?.name ?? null,
            };
          });
          const count = (pred: (s: string) => boolean) => rows.filter((r) => pred(r.status)).length;
          return {
            settings: config.settings,
            tabs: rows,
            counts: {
              running: count((s) => s === "scheduled" || s === "evaluating" || s === "refreshing"),
              paused: count((s) => s.startsWith("paused")),
              stopped: count((s) => s === "stopped" || s === "completed"),
              excluded: count((s) => s === "excluded"),
            },
            pendingApprovals: config.approvals.filter((a) => a.status === "pending").length,
            pendingAgents: Object.values(config.agents).filter((a) => a.status === "pending").length,
            conflicts: detectRuleConflicts(Object.values(config.rules)),
          };
        },
      }),
      getTabState: m({ scope: null, params: tabId, handler: async (_a, p) => this.tabState(p.tabId) }),
      startTab: m({
        scope: null,
        params: z.strictObject({
          tabId: z.number().int().nonnegative(),
          intervalSeconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(MAX_INTERVAL_SECONDS).optional(),
          safety: tabSafety.optional(),
        }),
        handler: async (_a, p) => {
          const config = await d.config.get();
          await this.updateOverride(p.tabId, (o, tab) => {
            const prev = o?.mode === "custom" ? o : undefined;
            const safety = p.safety || prev?.safety ? { ...(prev?.safety ?? {}), ...(p.safety ?? {}) } : undefined;
            return this.newOverride(tab, {
              ...(prev ?? {}),
              mode: "custom",
              intervalSeconds: p.intervalSeconds ?? prev?.intervalSeconds ?? config.settings.defaultIntervalSeconds,
              ...(safety ? { safety } : {}),
              stopped: false,
              paused: false,
            });
          });
          await d.engine.setTabStatus(p.tabId, "scheduled", "Started by user");
          return this.tabState(p.tabId);
        },
      }),
      setTabSafety: m({
        scope: null,
        params: z.strictObject({
          tabId: z.number().int().nonnegative(),
          safety: tabSafety,
        }),
        handler: async (_a, p) => {
          await this.updateOverride(p.tabId, (o, tab) =>
            o?.mode === "custom" ? { ...o, safety: { ...(o.safety ?? {}), ...p.safety } } : this.newOverride(tab, { mode: "custom", safety: p.safety, stopped: true }),
          );
          return this.tabState(p.tabId);
        },
      }),
      stopTab: m({
        scope: null,
        params: tabId,
        handler: async (_a, p) => {
          const o = (await d.config.get()).tabOverrides[String(p.tabId)];
          if (o?.mode === "custom") await this.updateOverride(p.tabId, (cur) => cur && { ...cur, stopped: true, paused: false });
          await d.engine.setTabStatus(p.tabId, "stopped", "Stopped by user");
          return this.tabState(p.tabId);
        },
      }),
      clearTabOverride: m({
        scope: null,
        params: tabId,
        handler: async (_a, p) => {
          await this.updateOverride(p.tabId, () => undefined);
          return this.tabState(p.tabId);
        },
      }),
      pauseTab: m({
        scope: null,
        params: tabId,
        handler: async (_a, p) => {
          const o = (await d.config.get()).tabOverrides[String(p.tabId)];
          if (o?.mode === "custom") {
            await d.config.update((c) => {
              c.tabOverrides[String(p.tabId)].paused = true;
            });
          }
          await d.engine.setTabStatus(p.tabId, "paused_user", "Paused by user");
          return this.tabState(p.tabId);
        },
      }),
      resumeTab: m({
        scope: null,
        params: tabId,
        handler: async (_a, p) => {
          const o = (await d.config.get()).tabOverrides[String(p.tabId)];
          if (o?.mode === "custom") {
            await d.config.update((c) => {
              Object.assign(c.tabOverrides[String(p.tabId)], { paused: false, stopped: false });
            });
          }
          await d.engine.setTabStatus(p.tabId, "scheduled", "Resumed by user");
          return this.tabState(p.tabId);
        },
      }),
      excludeTab: m({
        scope: null,
        params: tabId,
        handler: async (_a, p) => {
          // Keep the tab's own settings so "include" can restore them.
          await this.updateOverride(p.tabId, (o, tab) => {
            const previous = o?.mode === "custom" ? o : o?.previous;
            return this.newOverride(tab, { mode: "excluded", ...(previous ? { previous } : {}) });
          });
          return this.tabState(p.tabId);
        },
      }),
      includeTab: m({
        scope: null,
        params: tabId,
        handler: async (_a, p) => {
          await this.updateOverride(p.tabId, (o) => (o?.mode === "excluded" ? o.previous : o));
          return this.tabState(p.tabId);
        },
      }),
      allowUnsavedOnce: m({
        scope: null,
        params: tabId,
        handler: async (_a, p) => d.engine.allowUnsavedOnce(p.tabId),
      }),
      refreshNow: m({
        scope: null,
        params: z.strictObject({ tabId: z.number().int().nonnegative(), force: z.boolean().optional() }),
        handler: async (actor, p) => d.engine.refreshNow(p.tabId, { force: p.force, actor }),
      }),
      runNow: m({
        scope: null,
        params: tabId,
        handler: async (_a, p) => d.engine.runCycle(p.tabId, "manual"),
      }),
      pauseAll: m({
        scope: null,
        params: none,
        mutates: true,
        handler: async () => d.config.update((c) => void (c.settings.paused = true)).then(() => ({ paused: true })),
      }),
      resumeAll: m({
        scope: null,
        params: none,
        mutates: true,
        handler: async () => d.config.update((c) => void (c.settings.paused = false)).then(() => ({ paused: false })),
      }),
      refreshAll: m({
        scope: null,
        params: z.strictObject({ force: z.boolean().optional() }).optional(),
        handler: async (_a, p) => d.engine.refreshAll({ force: p?.force }),
      }),
      updateSettings: m({
        scope: null,
        params: z.strictObject({
          enabled: z.boolean().optional(),
          paused: z.boolean().optional(),
          defaultIntervalSeconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(MAX_INTERVAL_SECONDS).optional(),
          defaultSafety: z
            .strictObject({
              pauseWhileTyping: z.boolean().optional(),
              protectUnsavedChanges: z.boolean().optional(),
              inactivityGraceSeconds: z.number().int().min(0).max(86400).optional(),
              pauseOnMouse: z.boolean().optional(),
              pauseOnScroll: z.boolean().optional(),
              onUnknown: z.enum(["pause", "skip", "refresh", "stop"]).optional(),
              maxUnknownRetries: z.number().int().min(0).max(100).optional(),
              onActivityUnavailable: z.enum(["pause", "refresh"]).optional(),
            })
            .optional(),
          historyLimit: z.number().int().min(10).max(5000).optional(),
          historyRetentionDays: z.number().int().min(1).max(365).optional(),
          notificationsEnabled: z.boolean().optional(),
          skipDiscardedTabs: z.boolean().optional(),
          redactUrlsForAgents: z.boolean().optional(),
          nativeBridgeEnabled: z.boolean().optional(),
          allowedExtensionIds: z
            .array(z.string().regex(/^[a-p]{32}$/, "Chrome extension IDs are 32 letters a–p"))
            .max(50)
            .optional(),
        }),
        mutates: true,
        handler: async (_a, p) => {
          const next = await d.config.update((c) => {
            const { defaultSafety, ...rest } = p;
            Object.assign(c.settings, rest);
            if (defaultSafety) c.settings.defaultSafety = { ...c.settings.defaultSafety, ...defaultSafety };
          });
          return next.settings as Settings;
        },
      }),
      duplicateRule: m({
        scope: null,
        params: ruleId,
        mutates: true,
        handler: async (actor, p) => {
          const r = await this.getRuleOrThrow(p.id);
          const input = { ...this.stripMeta(r), id: undefined, name: `${r.name} (copy)`.slice(0, 100), enabled: false };
          return this.saveRule(actor, input as RuleInput, null);
        },
      }),
      testPattern: m({
        scope: null,
        params: z.strictObject({ pattern: urlPatternSchema, url: z.string().max(8192) }),
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
        params: z.strictObject({ tabId: z.number().int().nonnegative(), selector: z.string().min(1).max(500) }),
        handler: async (_a, p) => {
          if (!d.testSelector) throw new ApiError("unsupported_method", "Selector testing unavailable");
          return d.testSelector(p.tabId, p.selector, true);
        },
      }),
      addExclusion: m({
        scope: null,
        params: z.strictObject({ pattern: urlPatternSchema, reason: z.string().max(200).optional() }),
        mutates: true,
        handler: async (_a, p) => {
          const problem = validatePattern(p.pattern);
          if (problem) throw new ApiError("validation_failed", problem, [{ path: "pattern", code: "pattern_invalid", message: problem, severity: "error" }]);
          const ex: Exclusion = { id: this.newId("excl"), pattern: p.pattern, ...(p.reason ? { reason: p.reason } : {}), createdAt: d.clock.now() };
          await d.config.update((c) => {
            c.exclusions.push(ex);
          });
          return ex;
        },
      }),
      removeExclusion: m({
        scope: null,
        params: ruleId,
        mutates: true,
        handler: async (_a, p) => {
          await d.config.update((c) => {
            c.exclusions = c.exclusions.filter((e) => e.id !== p.id);
          });
          return { removed: p.id };
        },
      }),
      listExclusions: m({
        scope: null,
        params: none,
        handler: async () => {
          const c = await d.config.get();
          const tabs = await d.browser.listTabs();
          return {
            exclusions: c.exclusions,
            tabExclusions: Object.values(c.tabOverrides)
              .filter((o) => o.mode === "excluded")
              .map((o) => ({ ...o, tab: tabs.find((t) => t.id === o.tabId) ?? null })),
          };
        },
      }),
      exportConfig: m({
        scope: null,
        params: z.strictObject({ includeSettings: z.boolean().optional(), ruleIds: z.array(z.string()).optional() }).optional(),
        handler: async (_a, p) => exportBundle(await d.config.get(), { includeSettings: p?.includeSettings ?? true, ruleIds: p?.ruleIds, now: d.clock.now() }),
      }),
      importConfig: m({
        scope: null,
        params: z.strictObject({
          json: z.string().max(5_000_000),
          onDuplicate: z.enum(["rename", "replace", "skip"]).optional(),
          activate: z.boolean().optional(),
          includeSettings: z.boolean().optional(),
        }),
        mutates: true,
        handler: async (_a, p) => {
          const config = await d.config.get();
          const parsed = parseImport(p.json, { registries: this.registries, defaultSafety: config.settings.defaultSafety, now: d.clock.now() });
          const report: ImportReport = { imported: [], skipped: [], errors: parsed.errors, warnings: parsed.warnings };
          if (parsed.fatal) return report;
          await d.config.update((c) => {
            for (const rule of parsed.rules) {
              let id = rule.id || this.newId("rule");
              if (c.rules[id]) {
                const mode = p.onDuplicate ?? "rename";
                if (mode === "skip") {
                  report.skipped.push({ id, reason: "Duplicate id" });
                  continue;
                }
                if (mode === "rename") id = this.newId(id.slice(0, 50));
              }
              const now = d.clock.now();
              const existing = c.rules[id];
              c.rules[id] = {
                ...rule,
                id,
                enabled: p.activate === true ? rule.enabled : false,
                meta: {
                  createdAt: existing?.meta.createdAt ?? now,
                  updatedAt: now,
                  revision: (existing?.meta.revision ?? 0) + 1,
                  origin: { type: "import" },
                  draft: p.activate !== true,
                },
              };
              report.imported.push(id);
            }
            for (const ex of parsed.exclusions) {
              if (!c.exclusions.some((e) => patternToString(e.pattern) === patternToString(ex.pattern))) {
                c.exclusions.push({ ...ex, id: this.newId("excl"), createdAt: d.clock.now() });
              }
            }
            if (p.includeSettings && parsed.settings) Object.assign(c.settings, parsed.settings);
          });
          return report;
        },
      }),
      resetConfig: m({
        scope: null,
        params: z.strictObject({ confirm: z.literal(true) }),
        mutates: true,
        handler: async () => {
          await d.config.replace(defaultConfig());
          return { reset: true };
        },
      }),
      clearHistory: m({ scope: null, params: none, handler: async () => d.history.clear().then(() => ({ cleared: true })) }),
      getAudit: m({ scope: null, params: none, handler: async () => (await d.audit.list()).slice().reverse() }),
      clearAudit: m({ scope: null, params: none, handler: async () => d.audit.clear().then(() => ({ cleared: true })) }),
      listAgents: m({
        scope: null,
        params: none,
        handler: async () => {
          const c = await d.config.get();
          return { agents: Object.values(c.agents), approvals: c.approvals.slice().reverse(), allScopes: ALL_AGENT_SCOPES };
        },
      }),
      updateAgent: m({
        scope: null,
        params: z.strictObject({
          id: z.string(),
          status: z.enum(["approved", "revoked"]).optional(),
          scopes: z.array(z.enum(ALL_AGENT_SCOPES as [AgentScope, ...AgentScope[]])).optional(),
          trustedActivation: z.boolean().optional(),
        }),
        handler: async (_a, p) => {
          await d.config.update((c) => {
            const a = c.agents[p.id];
            if (!a) throw new ApiError("not_found", "Agent not found");
            if (p.status) a.status = p.status;
            if (p.scopes) a.scopes = p.scopes;
            if (p.trustedActivation !== undefined) a.trustedActivation = p.trustedActivation;
          });
          return (await d.config.get()).agents[p.id];
        },
      }),
      removeAgent: m({
        scope: null,
        params: ruleId,
        handler: async (_a, p) => {
          await d.config.update((c) => {
            delete c.agents[p.id];
            c.approvals = c.approvals.filter((a) => a.agentId !== p.id);
          });
          return { removed: p.id };
        },
      }),
      resolveApproval: m({
        scope: null,
        params: z.strictObject({ id: z.string(), approve: z.boolean() }),
        mutates: true,
        handler: async (_a, p) => {
          let outcome = "rejected";
          await d.config.update((c) => {
            const req = c.approvals.find((a) => a.id === p.id);
            if (!req || req.status !== "pending") throw new ApiError("not_found", "No pending approval with that id");
            const rule = c.rules[req.ruleId];
            if (!rule || rule.meta.revision !== req.ruleRevision) {
              req.status = "stale";
              outcome = "stale";
              return;
            }
            if (!p.approve) {
              req.status = "rejected";
              return;
            }
            req.status = "approved";
            outcome = req.kind === "activate" ? "activated" : "deleted";
            if (req.kind === "activate") {
              rule.enabled = true;
              rule.meta.draft = false;
              rule.meta.revision++;
              rule.meta.updatedAt = d.clock.now();
            } else {
              delete c.rules[req.ruleId];
            }
          });
          return { outcome };
        },
      }),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Pairing (external transports)                                        */
  /* ------------------------------------------------------------------ */

  /** Register (or look up) an agent identity. New agents start pending with no scopes. */
  async ensureAgent(identity: { id: string; name: string; transport: AgentRecord["transport"]; extensionId?: string }): Promise<AgentRecord> {
    const config = await this.deps.config.get();
    const existing = config.agents[identity.id];
    if (existing) return existing;
    const record: AgentRecord = {
      id: identity.id,
      name: identity.name.slice(0, 80),
      transport: identity.transport,
      ...(identity.extensionId ? { extensionId: identity.extensionId } : {}),
      scopes: [],
      trustedActivation: false,
      status: "pending",
      createdAt: this.deps.clock.now(),
    };
    await this.deps.config.update((c) => {
      // Bound the number of pending pairing requests to avoid spam.
      const pending = Object.values(c.agents).filter((a) => a.status === "pending");
      if (pending.length >= 10) delete c.agents[pending[0].id];
      c.agents[record.id] = record;
    });
    void this.deps.audit.append({ at: this.deps.clock.now(), agentId: record.id, operation: "pair", outcome: "pending_approval", detail: `${identity.transport} pairing requested` });
    return record;
  }
}

export { ApiError, RULE_SCHEMA_VERSION };
