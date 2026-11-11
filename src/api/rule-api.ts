/**
 * Rule Management API — the single entry point for the popup, dashboard,
 * rule builder, JSON import, external extensions and the MCP bridge.
 *
 * Every method has a strict parameter schema (unknown arguments are
 * rejected), an authorization scope, and goes through centralized
 * validation. Agents are audited.
 */
import type { BrowserPort, ClockPort, RuleEngine } from "../core/rule-engine";
import { resolveTab, rulesForOtherQuery, type Resolution } from "../core/rule-resolver";
import { validateRule, zodDiagnostics } from "../core/rule-schema";
import type {
  Actor,
  AgentRecord,
  AgentScope,
  ApprovalRequest,
  AuditEntry,
  Config,
  HistoryEntry,
  Rule,
  RuleInput,
  TabInfo,
  TabOverride,
  TabRuntime,
} from "../core/types";
import { RULE_SCHEMA_VERSION, STATUS_LABELS } from "../core/types";
import { defaultRegistries, type Registries } from "../registries";
import type { SchemaBundle } from "./capabilities";
import type { MethodDef } from "./method";
import { agentsMethods } from "./methods/agents";
import { rulesMethods } from "./methods/rules";
import { settingsMethods } from "./methods/settings";
import { tabsMethods } from "./methods/tabs";
import { agentFor, ApiError, authorize, redactConditionUrls, redactPattern, redactUrl } from "./permissions";

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
  /** The generated JSON Schemas (read from the extension package; see capabilities.ts). */
  schemas?: () => Promise<SchemaBundle>;
}

/** "Last seen" is informational: record it at most this often (each write rewrites the config). */
export const AGENT_LAST_SEEN_RESOLUTION_MS = 60_000;

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** What the method modules (methods/*.ts) use from the service. */
export type ServiceInternals = Pick<
  RuleManagementService,
  | "deps"
  | "registries"
  | "newId"
  | "tabsFor"
  | "rulesFor"
  | "getRuleOrThrow"
  | "validateOrThrow"
  | "saveRule"
  | "stripMeta"
  | "requestApproval"
  | "setEnabled"
  | "updateOverride"
  | "newOverride"
  | "tabState"
>;

export class RuleManagementService {
  readonly registries: Registries;
  private readonly methods: Record<string, MethodDef>;
  readonly newId: (prefix: string) => string;

  constructor(readonly deps: ApiDeps) {
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
      await this.noteAgentSeen(actor, config);
      const result = await def.handler(actor, parsed.data);
      // Re-check only the tabs this change affects (compared with the config before it).
      if (def.mutates) await this.deps.engine.reconcileAll("config", { before: config });
      const pending = result && typeof result === "object" && (result as { status?: string }).status === "pending_approval";
      audit(pending ? "pending_approval" : "ok", undefined, (parsed.data as { id?: string })?.id);
      return result;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("internal", (e as Error).message);
      audit(err.code === "forbidden" || err.code === "pairing_required" ? "denied" : "error", err.message);
      throw err;
    }
  }

  /** Record when an agent was last active (at most once a minute: each write rewrites the config). */
  private async noteAgentSeen(actor: Actor, config: Config) {
    if (actor.type !== "agent") return;
    const now = this.deps.clock.now();
    if (now - (config.agents[actor.agentId]?.lastSeenAt ?? 0) < AGENT_LAST_SEEN_RESOLUTION_MS) return;
    await this.deps.config.update((c) => {
      if (c.agents[actor.agentId]) c.agents[actor.agentId].lastSeenAt = now;
    });
  }

  /* ------------------------------------------------------------------ */

  async tabsFor(actor: Actor): Promise<TabInfo[]> {
    const tabs = await this.deps.browser.listTabs();
    if (actor.type !== "agent") return tabs;
    const redact = (await this.deps.config.get()).settings.redactUrlsForAgents;
    return tabs.map((t) => ({ ...t, url: redactUrl(t.url, redact) }));
  }

  /**
   * Rules as an agent may see them: with "Hide URL query strings from agents"
   * on, query strings in other people's rules' page patterns are hidden (they
   * can hold order numbers or emails). An agent's own rules stay intact so it
   * can edit them without corrupting their targets.
   */
  async rulesFor(actor: Actor, rules: Rule[]): Promise<Rule[]> {
    if (actor.type !== "agent" || !(await this.deps.config.get()).settings.redactUrlsForAgents) return rules;
    return rules.map((r) =>
      r.meta.origin.type === "agent" && r.meta.origin.agentId === actor.agentId
        ? r
        : {
            ...r,
            target: { ...r.target, patterns: r.target.patterns.map(redactPattern), exclusions: r.target.exclusions.map(redactPattern) },
            ...(r.stopWhen ? { stopWhen: redactConditionUrls(r.stopWhen) } : {}),
          },
    );
  }

  async getRuleOrThrow(id: string): Promise<Rule> {
    const r = (await this.deps.config.get()).rules[id];
    if (!r) throw new ApiError("not_found", `Rule "${id}" not found`);
    return r;
  }

  validateOrThrow(input: unknown, config: Config) {
    const v = validateRule(input, { registries: this.registries, defaultSafety: config.settings.defaultSafety, now: this.deps.clock.now(), allowFastIntervals: config.settings.allowFastIntervals });
    if (!v.valid) throw new ApiError("validation_failed", "Rule failed validation", v.diagnostics);
    return v;
  }

  /** Create or replace a rule, applying ownership/draft policy. */
  async saveRule(actor: Actor, input: RuleInput, existing: Rule | null): Promise<Rule> {
    const now = this.deps.clock.now();
    let saved!: Rule;
    await this.deps.config.update((c) => {
      const n = this.validateOrThrow(input, c).normalized!;
      const id = existing?.id ?? (n.id || this.newId("rule"));
      if (!existing && c.rules[id]) throw new ApiError("conflict", `A rule with id "${id}" already exists`);
      const { enabled, draft } = ownership(actor, existing, n.enabled);
      saved = { ...n, id, enabled, meta: { ...ruleMeta(actor, existing, now), draft } };
      c.rules[id] = saved;
      // Any pending approval for an older revision is now stale.
      for (const a of c.approvals) if (a.ruleId === id && a.status === "pending") a.status = "stale";
    });
    return saved;
  }

  stripMeta(rule: Rule): RuleInput {
    const { meta: _meta, ...rest } = rule;
    return rest as unknown as RuleInput;
  }

  async requestApproval(actor: Actor, kind: ApprovalRequest["kind"], rule: Rule) {
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

  async setEnabled(id: string, enabled: boolean) {
    await this.deps.config.update((c) => {
      const r = c.rules[id];
      if (!r) throw new ApiError("not_found", `Rule "${id}" not found`);
      r.enabled = enabled;
      if (enabled) r.meta.draft = false;
      r.meta.updatedAt = this.deps.clock.now();
      r.meta.revision++;
    });
  }

  async updateOverride(tabIdValue: number, fn: (o: TabOverride | undefined, tab: TabInfo) => TabOverride | undefined) {
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

  newOverride(tab: TabInfo, partial: Partial<TabOverride>): TabOverride {
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
    const controller = controllerOf(res);
    return {
      tab,
      runtime,
      statusLabel: runtime ? STATUS_LABELS[runtime.status] : isResting(res) ? "Excluded" : "Idle",
      resolution: resolutionSummary(res, controller),
      override: config.tabOverrides[String(tabIdValue)] ?? null,
      /** Rules set for this page with a different "?…" part (they don't run here). */
      otherQueryRules: rulesForOtherQuery(Object.values(config.rules), tab.url).map((r) => ({ id: r.id, name: r.name })),
      interval: controller?.trigger.type === "interval" ? (controller.trigger as unknown as { seconds: number }).seconds : null,
      safety: controller?.safety ?? config.settings.defaultSafety,
      hostAccess: await this.deps.hostAccess(tab.url).catch(() => false),
    };
  }

  /* ------------------------------------------------------------------ */

  private defineMethods(): Record<string, MethodDef> {
    return { ...rulesMethods(this), ...tabsMethods(this), ...settingsMethods(this), ...agentsMethods(this) };
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

/**
 * Who owns a saved rule and whether it's on. Agents never activate directly:
 * their writes always produce switched-off drafts.
 */
function ownership(actor: Actor, existing: Rule | null, enabled: boolean) {
  if (actor.type === "agent") return { enabled: false, draft: true };
  return { enabled, draft: existing ? existing.meta.draft && !enabled : false };
}

function ruleMeta(actor: Actor, existing: Rule | null, now: number): Omit<Rule["meta"], "draft"> {
  const origin = existing?.meta.origin ?? (actor.type === "agent" ? { type: "agent" as const, agentId: actor.agentId } : { type: "user" as const });
  return { createdAt: existing?.meta.createdAt ?? now, updatedAt: now, revision: (existing?.meta.revision ?? 0) + 1, origin };
}

function controllerOf(res: Resolution): Rule | null {
  return res.kind === "controller" || res.kind === "paused" ? res.controller : null;
}

function isResting(res: Resolution): boolean {
  return res.kind === "restricted" || res.kind.endsWith("excluded");
}

/** What controls the tab, as the popup shows it. */
function resolutionSummary(res: Resolution, controller: Rule | null) {
  return {
    kind: res.kind,
    reason: "reason" in res ? res.reason : undefined,
    controllerId: controller?.id ?? null,
    controllerName: controller?.name ?? null,
    source: res.kind === "controller" ? res.source : null,
    candidates: res.kind === "controller" ? res.candidates.map((r) => ({ id: r.id, name: r.name, priority: r.priority })) : [],
  };
}
