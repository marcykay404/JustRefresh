/**
 * Rule engine: the single execution core shared by quick controls, URL rules,
 * imported rules and agent-created rules.
 *
 * The engine knows nothing about specific triggers, conditions or actions —
 * it asks the registries. Browser access goes through ports so the engine
 * can be tested without Chrome.
 */
import type { Registries } from "../registries";
import { defaultRegistries } from "../registries";
import type { ActionContext, TriggerEvent } from "../registries/contracts";
import type { ActivitySnapshot } from "../shared/messaging-types";
import { evaluateConditionTree, explainTrace } from "./evaluator";
import { resolveTab, type Resolution } from "./rule-resolver";
import { decideSafety } from "./safety";
import { checkLimits, inActiveWindow, MIN_ALARM_DELAY_MS, nextWindowStart, restoredDueAt } from "./schedule";
import { isPaused, isTerminal, newRuntime, transition } from "./state-machine";
import type {
  ActionConfig,
  Actor,
  Config,
  ConditionNode,
  EvaluationResult,
  EvaluationTrace,
  ExecutionStatus,
  HistoryEntry,
  Rule,
  TabInfo,
  TabRuntime,
} from "./types";

/* ------------------------------------------------------------------ */
/* Ports                                                               */
/* ------------------------------------------------------------------ */

export interface BrowserPort {
  getTab(tabId: number): Promise<TabInfo | null>;
  listTabs(): Promise<TabInfo[]>;
  reload(tabId: number, bypassCache: boolean): Promise<void>;
  notify(id: string, title: string, message: string): Promise<void>;
}

export interface AlarmPort {
  set(name: string, when: number): Promise<void>;
  clear(name: string): Promise<void>;
  getAll(): Promise<{ name: string; scheduledTime: number }[]>;
}

export type PageAvailability = { available: true } | { available: false; reason: string; code: "missing_permission" | "content_script_unavailable" | "restricted_url" };

export interface PagePort {
  evaluate(tabId: number, leaves: ConditionNode[], includeText: boolean): Promise<EvaluationResult[]>;
  /** null = unavailable (reason in second tuple element). */
  activity(tabId: number): Promise<{ activity: ActivitySnapshot | null; reason?: string }>;
}

export interface ClockPort {
  now(): number;
  random(): number;
}

export interface Stores {
  config: { get(): Promise<Config>; update(fn: (c: Config) => Config | void | Promise<Config | void>): Promise<Config> };
  runtime: {
    get(tabId: number): Promise<TabRuntime | null>;
    getAll(): Promise<TabRuntime[]>;
    put(rt: TabRuntime): Promise<void>;
    delete(tabId: number): Promise<void>;
  };
  history: { append(e: HistoryEntry): Promise<void> };
}

export interface EngineDeps {
  browser: BrowserPort;
  alarms: AlarmPort;
  page: PagePort;
  clock: ClockPort;
  stores: Stores;
  registries?: Registries;
  /** Global spacing between reloads to avoid refresh storms. */
  throttle?: () => Promise<void>;
}

export const ALARM_PREFIX = "sar:tab:";
export const NAVIGATION_TIMEOUT_MS = 60_000;

export const alarmName = (tabId: number) => `${ALARM_PREFIX}${tabId}`;
export const tabIdFromAlarm = (name: string): number | null =>
  name.startsWith(ALARM_PREFIX) ? Number(name.slice(ALARM_PREFIX.length)) : null;

class SafetyBlock extends Error {
  constructor(
    public readonly status: ExecutionStatus,
    public readonly reason: string,
    public readonly retryAt: number,
  ) {
    super(reason);
  }
}

export interface CycleResult {
  status: ExecutionStatus;
  reason?: string;
  evaluation?: EvaluationTrace;
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class RuleEngine {
  private readonly registries: Registries;
  private readonly locks = new Map<number, Promise<unknown>>();

  constructor(private readonly deps: EngineDeps) {
    this.registries = deps.registries ?? defaultRegistries();
  }

  /** Serialize all work per tab: one operation per tab at a time. */
  private withLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(tabId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(tabId, tail);
    void tail.then(() => {
      if (this.locks.get(tabId) === tail) this.locks.delete(tabId);
    });
    return next;
  }

  private now() {
    return this.deps.clock.now();
  }

  private log(e: Omit<HistoryEntry, "at" | "actor"> & { actor?: HistoryEntry["actor"] }) {
    void this.deps.stores.history.append({ at: this.now(), actor: "system", ...e });
  }

  private async setAlarm(rt: TabRuntime) {
    if (rt.nextDueAt === null) await this.deps.alarms.clear(alarmName(rt.tabId));
    else await this.deps.alarms.set(alarmName(rt.tabId), Math.max(rt.nextDueAt, this.now() + 1000));
  }

  private nextDue(rule: Rule, from: number): number | null {
    const h = this.registries.triggers.get(rule.trigger.type);
    if (!h?.nextDueAt) return null;
    return h.nextDueAt(rule.trigger, from, this.deps.clock.random);
  }

  private intervalMs(rule: Rule): number {
    const due = this.nextDue(rule, 0);
    return due === null ? 60_000 : Math.max(due, MIN_ALARM_DELAY_MS);
  }

  /* ---------------- resolution sync ---------------- */

  /**
   * Align runtime state with the current resolution. Resets the run (new
   * generation) when the controller, its revision, or the page changes.
   */
  private sync(
    rt: TabRuntime | null,
    tab: TabInfo,
    res: Resolution,
    config: Config,
    opts: { restoring?: boolean; slot?: number; ownNavigation?: boolean } = {},
  ): TabRuntime {
    const now = this.now();
    let cur = rt ?? newRuntime(tab.id, tab.url, now);

    if (res.kind !== "controller") {
      const status: ExecutionStatus =
        res.kind === "paused" ? "paused_global" : res.kind === "restricted" || res.kind.endsWith("excluded") ? "excluded" : "idle";
      const controllerId = res.kind === "paused" ? (res.controller?.id ?? null) : null;
      if (res.kind === "paused" && !res.controller) {
        return transition(cur, "idle", { reason: "No rule applies to this tab", nextDueAt: null, controllerId: null, url: tab.url });
      }
      return transition(cur, status, {
        reason: res.reason,
        nextDueAt: null,
        controllerId,
        url: tab.url,
        pendingReload: status === "paused_global" ? cur.pendingReload : null,
      });
    }

    const rule = res.controller;
    const changed =
      cur.controllerId !== rule.id ||
      cur.controllerRevision !== rule.meta.revision ||
      (cur.url !== tab.url && !opts.ownNavigation && !cur.pendingReload);

    if (changed) {
      const generation = cur.generation + 1;
      cur = { ...newRuntime(tab.id, tab.url, now, generation), controllerId: rule.id, controllerRevision: rule.meta.revision };
      const override = config.tabOverrides[String(tab.id)];
      if (override?.mode === "custom" && override.stopped) {
        return transition(cur, "stopped", { reason: "Stopped by user" });
      }
      if (override?.mode === "custom" && override.paused) {
        return transition(cur, "paused_user", { reason: "Paused by user" });
      }
      const intervalDue = this.nextDue(rule, now);
      const nextDueAt = intervalDue === null ? null : opts.restoring ? restoredDueAt(null, intervalDue, now, opts.slot ?? 0) : intervalDue;
      return transition(cur, "scheduled", {
        nextDueAt,
        reason: nextDueAt === null ? `Waiting for ${rule.trigger.type} trigger` : undefined,
      });
    }

    cur = { ...cur, url: tab.url };
    if (cur.status === "paused_global" || cur.status === "idle" || cur.status === "excluded") {
      // Resuming: do not fire overdue schedules at once.
      const intervalDue = this.nextDue(rule, now);
      return transition(cur, "scheduled", {
        reason: undefined,
        nextDueAt: intervalDue === null ? null : restoredDueAt(cur.nextDueAt, intervalDue, now, opts.slot ?? 0),
      });
    }
    if (opts.restoring && cur.nextDueAt !== null && cur.status === "scheduled") {
      const intervalDue = this.nextDue(rule, now) ?? now;
      return { ...cur, nextDueAt: restoredDueAt(cur.nextDueAt, intervalDue, now, opts.slot ?? 0) };
    }
    return cur;
  }

  /* ---------------- reconciliation ---------------- */

  /**
   * Reconcile every open tab with the configuration: used on startup, on
   * service-worker wake, and after configuration changes. Recreates missing
   * alarms, removes stale ones, and staggers overdue schedules.
   */
  async reconcileAll(reason: "startup" | "wake" | "config"): Promise<void> {
    const [config, tabs, runtimes, alarms] = await Promise.all([
      this.deps.stores.config.get(),
      this.deps.browser.listTabs(),
      this.deps.stores.runtime.getAll(),
      this.deps.alarms.getAll(),
    ]);
    const open = new Set(tabs.map((t) => t.id));
    for (const rt of runtimes) {
      if (!open.has(rt.tabId)) await this.deps.stores.runtime.delete(rt.tabId);
    }
    for (const a of alarms) {
      const id = tabIdFromAlarm(a.name);
      if (id !== null && !open.has(id)) await this.deps.alarms.clear(a.name);
    }
    const alarmMap = new Map(alarms.map((a) => [a.name, a.scheduledTime]));
    let slot = 0;
    for (const tab of tabs) {
      await this.withLock(tab.id, async () => {
        const rt = await this.deps.stores.runtime.get(tab.id);
        const res = resolveTab(tab, config);
        const next = this.sync(rt, tab, res, config, { restoring: reason !== "config", slot });
        if (next.nextDueAt !== null) slot++;
        if (next.status === "idle" && !rt) return; // nothing to track
        await this.deps.stores.runtime.put(next);
        const existing = alarmMap.get(alarmName(tab.id));
        if (next.nextDueAt === null) {
          if (existing !== undefined) await this.deps.alarms.clear(alarmName(tab.id));
        } else if (existing === undefined || Math.abs(existing - next.nextDueAt) > 1000) {
          await this.setAlarm(next);
        }
      });
    }
    if (reason === "startup") {
      for (const tab of tabs) await this.handleEvent(tab.id, "startup");
    }
  }

  /** Re-sync a single tab after a configuration or control change. */
  async syncTab(tabId: number): Promise<TabRuntime | null> {
    return this.withLock(tabId, async () => {
      const tab = await this.deps.browser.getTab(tabId);
      if (!tab) {
        await this.forgetTab(tabId);
        return null;
      }
      const config = await this.deps.stores.config.get();
      const rt = await this.deps.stores.runtime.get(tabId);
      const next = this.sync(rt, tab, resolveTab(tab, config), config);
      await this.deps.stores.runtime.put(next);
      await this.setAlarm(next);
      return next;
    });
  }

  async forgetTab(tabId: number) {
    await this.deps.stores.runtime.delete(tabId);
    await this.deps.alarms.clear(alarmName(tabId));
  }

  /* ---------------- events ---------------- */

  async handleAlarm(name: string): Promise<CycleResult | null> {
    const tabId = tabIdFromAlarm(name);
    if (tabId === null) return null;
    return this.runCycle(tabId, "alarm");
  }

  async handleEvent(tabId: number, event: TriggerEvent): Promise<CycleResult | null> {
    return this.runCycle(tabId, event);
  }

  /** chrome.tabs.onUpdated */
  async onTabUpdated(tabId: number, change: { status?: string; url?: string }): Promise<void> {
    if (change.url !== undefined) {
      const rt = await this.deps.stores.runtime.get(tabId);
      const own = !!rt?.pendingReload;
      if (!own) {
        await this.syncTab(tabId);
        await this.runCycle(tabId, "urlChange");
      }
    }
    if (change.status === "complete") {
      const handledOwn = await this.onNavigationComplete(tabId);
      if (!handledOwn) await this.runCycle(tabId, "navigation");
    }
  }

  async onTabReplaced(addedTabId: number, removedTabId: number) {
    await this.deps.stores.config.update((c) => {
      const o = c.tabOverrides[String(removedTabId)];
      if (o) {
        delete c.tabOverrides[String(removedTabId)];
        c.tabOverrides[String(addedTabId)] = { ...o, tabId: addedTabId };
      }
    });
    const rt = await this.deps.stores.runtime.get(removedTabId);
    await this.forgetTab(removedTabId);
    if (rt) await this.deps.stores.runtime.put({ ...rt, tabId: addedTabId, controllerId: rt.controllerId?.startsWith("tab:") ? `tab:${addedTabId}` : rt.controllerId });
    await this.syncTab(addedTabId);
  }

  async onTabRemoved(tabId: number) {
    await this.withLock(tabId, () => this.forgetTab(tabId));
    await this.deps.stores.config.update((c) => {
      delete c.tabOverrides[String(tabId)];
    });
  }

  /** Our own reload finished loading: count it and evaluate post-navigation. */
  private async onNavigationComplete(tabId: number): Promise<boolean> {
    return this.withLock(tabId, async () => {
      const rt = await this.deps.stores.runtime.get(tabId);
      if (!rt?.pendingReload) return false;
      const config = await this.deps.stores.config.get();
      const tab = await this.deps.browser.getTab(tabId);
      if (!tab) return true;
      const res = resolveTab(tab, config);
      const now = this.now();
      let cur: TabRuntime = { ...rt, pendingReload: null, navigationCount: rt.navigationCount + 1, lastNavigationAt: now, url: tab.url };
      if (res.kind !== "controller" || res.controller.id !== rt.controllerId) {
        cur = this.sync(cur, tab, res, config, { ownNavigation: true });
        await this.deps.stores.runtime.put(cur);
        await this.setAlarm(cur);
        return true;
      }
      const rule = res.controller;
      if (rule.stopWhen && cur.status === "refreshing") {
        cur = transition(cur, "evaluating");
        await this.deps.stores.runtime.put(cur);
        const evalOut = await this.evaluate(rule, tab, cur);
        const latest = await this.deps.stores.runtime.get(tabId);
        if (!latest || latest.generation !== cur.generation) return true; // stale
        cur = { ...latest, lastEvaluation: { at: now, status: evalOut.result.status, reason: explainTrace(evalOut.trace) } };
        if (evalOut.result.status === "matched") {
          cur = await this.runActions(rule, tab, cur, rule.actions.onMatched, "navigation", evalOut.result.status, { allowRefresh: false });
        } else {
          cur = transition(cur, "scheduled", { reason: undefined });
        }
      } else if (cur.status === "refreshing") {
        cur = transition(cur, "scheduled", { reason: undefined });
      }
      await this.deps.stores.runtime.put(cur);
      await this.setAlarm(cur);
      return true;
    });
  }

  /* ---------------- the cycle ---------------- */

  /**
   * One evaluation lifecycle (FR-08):
   * trigger → eligibility & safety → evaluate stop conditions → actions →
   * refresh → (navigation tracked separately) → re-evaluate.
   */
  async runCycle(tabId: number, event: TriggerEvent, opts: { actor?: Actor } = {}): Promise<CycleResult | null> {
    return this.withLock(tabId, async () => {
      const config = await this.deps.stores.config.get();
      const tab = await this.deps.browser.getTab(tabId);
      if (!tab) {
        await this.forgetTab(tabId);
        return null;
      }
      const res = resolveTab(tab, config);
      const prev = await this.deps.stores.runtime.get(tabId);
      let rt = this.sync(prev, tab, res, config);
      const save = async (r: TabRuntime) => {
        await this.deps.stores.runtime.put(r);
        await this.setAlarm(r);
        return { status: r.status, reason: r.reason };
      };

      if (res.kind !== "controller") {
        if (!prev && rt.status === "idle") return { status: "idle", reason: rt.reason };
        return save(rt);
      }
      const rule = res.controller;
      const trigger = this.registries.triggers.get(rule.trigger.type);
      const now = this.now();

      if (!trigger) return save(transition(rt, "error", { lastError: `Unknown trigger ${rule.trigger.type}`, nextDueAt: null }));
      if (event !== "manual" && !trigger.events.includes(event)) {
        // Not our trigger: keep state, but make sure the alarm is consistent.
        return save(rt);
      }

      // User / rule pauses.
      if (rt.status === "paused_user") {
        if (rt.resumeAt !== null && rt.resumeAt <= now) {
          rt = transition(rt, "scheduled", { resumeAt: null, reason: undefined });
        } else {
          return save({ ...rt, nextDueAt: rt.resumeAt });
        }
      }
      if (isTerminal(rt.status)) {
        if (event !== "manual") return save({ ...rt, nextDueAt: null });
        rt = transition(rt, "scheduled", { reason: undefined });
      }

      // A reload is in flight: never overlap.
      if (rt.pendingReload) {
        if (now - rt.pendingReload.startedAt < NAVIGATION_TIMEOUT_MS) {
          return save({ ...rt, nextDueAt: now + MIN_ALARM_DELAY_MS });
        }
        this.log({ ruleId: rule.id, tabId, url: tab.url, trigger: event, action: "refresh", outcome: "error", reason: "Navigation did not complete" });
        rt = { ...rt, pendingReload: null, lastError: "Previous reload did not complete in time", status: rt.status === "refreshing" ? "scheduled" : rt.status };
      }

      // Limits and active window.
      const limit = checkLimits(rule.limits, rt, now);
      if (limit.reached) {
        this.log({ ruleId: rule.id, tabId, url: tab.url, trigger: event, action: "stop", outcome: "ok", reason: limit.reason });
        return save(transition(rt, "completed", { reason: limit.reason, nextDueAt: null }));
      }
      if (!inActiveWindow(rule.schedule, now)) {
        const opens = nextWindowStart(rule.schedule, now);
        return save(transition(rt, "scheduled", { reason: "Outside active hours", nextDueAt: opens ?? this.nextDue(rule, now) }));
      }
      if (tab.discarded && config.settings.skipDiscardedTabs && event !== "manual") {
        return save(transition(rt, "scheduled", { reason: "Tab is discarded (memory saver); skipped", nextDueAt: this.nextDue(rule, now) }));
      }

      // Evaluate.
      rt = transition(rt, "evaluating", { lastAttemptAt: now });
      await this.deps.stores.runtime.put(rt);
      const generation = rt.generation;

      let status: EvaluationResult["status"] = "not_matched";
      let trace: EvaluationTrace | undefined;
      if (rule.stopWhen) {
        const out = await this.evaluate(rule, tab, rt);
        status = out.result.status;
        trace = out.trace;
      }
      const latest = await this.deps.stores.runtime.get(tabId);
      if (!latest || latest.generation !== generation || latest.status !== "evaluating") {
        return { status: latest?.status ?? "idle", reason: "Stale evaluation discarded" };
      }
      rt = {
        ...latest,
        lastEvaluation: rule.stopWhen ? { at: now, status, reason: trace ? explainTrace(trace) : undefined } : latest.lastEvaluation,
      };

      if (status === "matched") {
        rt = { ...rt, unknownStreak: 0 };
        rt = await this.runActions(rule, tab, rt, rule.actions.onMatched, event, status, { allowRefresh: true });
        if (rt.status === "evaluating") rt = transition(rt, "scheduled", { nextDueAt: this.nextDue(rule, now) });
        return { ...(await save(rt)), evaluation: trace };
      }

      if (status === "unknown") {
        const policy = rule.safety.onUnknown;
        const reason = trace ? explainTrace(trace) : "unknown";
        if (rule.actions.onUnknown?.length) {
          rt = await this.runActions(rule, tab, rt, rule.actions.onUnknown, event, status, { allowRefresh: policy === "refresh" });
          if (rt.status !== "evaluating") return { ...(await save(rt)), evaluation: trace };
        }
        if (policy === "pause") {
          const streak = rt.unknownStreak + 1;
          const giveUp = streak > rule.safety.maxUnknownRetries;
          this.log({ ruleId: rule.id, tabId, url: tab.url, trigger: event, condition: "unknown", action: "pause", outcome: "skipped", reason });
          return {
            ...(await save(
              transition(rt, "paused_unknown", {
                unknownStreak: streak,
                reason: giveUp ? `Condition unknown after ${streak} attempts: ${reason}. Resume to retry.` : `Condition unknown (retry ${streak}/${rule.safety.maxUnknownRetries}): ${reason}`,
                nextDueAt: giveUp ? null : this.nextDue(rule, now),
              }),
            )),
            evaluation: trace,
          };
        }
        if (policy === "stop") {
          this.log({ ruleId: rule.id, tabId, url: tab.url, trigger: event, condition: "unknown", action: "stop", outcome: "ok", reason });
          return { ...(await save(transition(rt, "stopped", { reason: `Stopped: condition unknown (${reason})`, nextDueAt: null }))), evaluation: trace };
        }
        if (policy === "skip") {
          this.log({ ruleId: rule.id, tabId, url: tab.url, trigger: event, condition: "unknown", action: "skip", outcome: "skipped", reason });
          return { ...(await save(transition(rt, "scheduled", { reason: `Skipped: condition unknown (${reason})`, nextDueAt: this.nextDue(rule, now) }))), evaluation: trace };
        }
        // policy === "refresh": fall through and treat like not_matched.
      }

      rt = { ...rt, unknownStreak: status === "unknown" ? rt.unknownStreak + 1 : 0 };
      rt = await this.runActions(rule, tab, rt, rule.actions.onNotMatched, event, status, { allowRefresh: true });
      if (rt.status === "evaluating") {
        rt = transition(rt, "scheduled", {
          reason: this.nextDue(rule, now) === null ? `Waiting for ${rule.trigger.type} trigger` : undefined,
          nextDueAt: this.nextDue(rule, now),
        });
      }
      return { ...(await save(rt)), evaluation: trace };
    });
  }

  private async evaluate(rule: Rule, tab: TabInfo, rt: TabRuntime) {
    return evaluateConditionTree(rule.stopWhen!, {
      now: this.now(),
      tab: { id: tab.id, url: tab.url, status: tab.status },
      runtime: { refreshCount: rt.refreshCount, navigationCount: rt.navigationCount, startedAt: rt.startedAt },
      pageEvaluator: (leaves) => this.deps.page.evaluate(tab.id, leaves, false),
      registries: this.registries,
    });
  }

  /** Execute an action list. Returns the updated runtime (status may change). */
  private async runActions(
    rule: Rule,
    tab: TabInfo,
    start: TabRuntime,
    actions: ActionConfig[],
    event: TriggerEvent,
    condition: EvaluationResult["status"],
    opts: { allowRefresh: boolean },
  ): Promise<TabRuntime> {
    let rt = start;
    const config = await this.deps.stores.config.get();
    let ended = false;
    for (const action of actions) {
      const handler = this.registries.actions.get(action.type);
      // After a terminal action (stop/pause) later actions may still notify/log, but never reload.
      if (ended && handler?.disruptive) continue;
      if (!handler) {
        this.log({ ruleId: rule.id, tabId: tab.id, url: tab.url, trigger: event, condition, action: action.type, outcome: "error", reason: "Unknown action" });
        continue;
      }
      const ctx: ActionContext = {
        tabId: tab.id,
        url: tab.url,
        ruleName: rule.name,
        reload: async ({ bypassCache }) => {
          if (!opts.allowRefresh) throw new Error("Refresh is not allowed in this phase");
          rt = await this.performReload(rule, tab, rt, bypassCache, config);
        },
        setStatus: (status, reason, resumeAt) => {
          rt = transition(rt, status, {
            reason,
            resumeAt: resumeAt ?? null,
            nextDueAt: status === "scheduled" ? this.nextDue(rule, this.now()) : (resumeAt ?? null),
          });
        },
        notify: async (title, message) => {
          if (!config.settings.notificationsEnabled) return;
          await this.deps.browser.notify(`sar:${rule.id}:${tab.id}:${this.now()}`, title, message);
        },
        log: (level, message) => {
          this.log({ ruleId: rule.id, tabId: tab.id, url: tab.url, trigger: event, condition, action: "log", outcome: "ok", reason: `${level}: ${message}` });
        },
      };
      try {
        const result = await handler.execute(action, ctx);
        if (action.type !== "log") {
          this.log({ ruleId: rule.id, tabId: tab.id, url: tab.url, trigger: event, condition, action: action.type, outcome: result.ok ? "ok" : "error", reason: result.message });
        }
        if (result.terminal) ended = true;
      } catch (e) {
        if (e instanceof SafetyBlock) {
          this.log({ ruleId: rule.id, tabId: tab.id, url: tab.url, trigger: event, condition, action: action.type, outcome: "skipped", reason: e.reason });
          rt = transition(rt, e.status, { reason: e.reason, nextDueAt: e.retryAt });
          break;
        }
        this.log({ ruleId: rule.id, tabId: tab.id, url: tab.url, trigger: event, condition, action: action.type, outcome: "error", reason: (e as Error).message });
        rt = transition(rt, "error", { lastError: (e as Error).message, reason: (e as Error).message, nextDueAt: this.nextDue(rule, this.now()) });
        break;
      }
    }
    return rt;
  }

  /** Safety gate + throttled reload. Persists state BEFORE reloading. */
  private async performReload(rule: Rule, tab: TabInfo, rt: TabRuntime, bypassCache: boolean, _config: Config): Promise<TabRuntime> {
    const now = this.now();
    const { activity, reason } = await this.deps.page.activity(tab.id);
    const decision = decideSafety({
      safety: rule.safety,
      activity,
      unavailableReason: reason,
      ignoreUnsaved: rt.ignoreUnsavedOnce === true,
      fallbackRetryMs: this.intervalMs(rule),
    });
    if (!decision.allowed) {
      throw new SafetyBlock(decision.status, decision.reason, now + Math.max(decision.retryInMs, MIN_ALARM_DELAY_MS));
    }
    if (this.deps.throttle) await this.deps.throttle();
    const next = transition(rt, "refreshing", {
      refreshCount: rt.refreshCount + 1,
      pendingReload: { startedAt: this.now(), generation: rt.generation },
      nextDueAt: this.nextDue(rule, this.now()) ?? this.now() + NAVIGATION_TIMEOUT_MS,
      reason: undefined,
      lastError: null,
      ignoreUnsavedOnce: false,
    });
    await this.deps.stores.runtime.put(next);
    await this.setAlarm(next);
    try {
      await this.deps.browser.reload(tab.id, bypassCache);
    } catch (e) {
      const failed = { ...next, pendingReload: null, refreshCount: rt.refreshCount };
      await this.deps.stores.runtime.put(failed);
      throw e;
    }
    return next;
  }

  /* ---------------- user controls ---------------- */

  /** Explicit user override of unsaved-change protection for the next reload. */
  async allowUnsavedOnce(tabId: number): Promise<CycleResult | null> {
    await this.withLock(tabId, async () => {
      const rt = await this.deps.stores.runtime.get(tabId);
      if (rt) await this.deps.stores.runtime.put({ ...rt, ignoreUnsavedOnce: true });
    });
    return this.runCycle(tabId, "manual");
  }

  async setTabStatus(tabId: number, status: "paused_user" | "stopped" | "scheduled", reason: string): Promise<TabRuntime | null> {
    return this.withLock(tabId, async () => {
      const tab = await this.deps.browser.getTab(tabId);
      if (!tab) return null;
      const config = await this.deps.stores.config.get();
      const res = resolveTab(tab, config);
      let rt = this.sync(await this.deps.stores.runtime.get(tabId), tab, res, config);
      if (res.kind !== "controller") {
        await this.deps.stores.runtime.put(rt);
        return rt;
      }
      if (status === "scheduled") {
        const restart = rt.status === "completed" || rt.status === "stopped";
        rt = transition(rt, "scheduled", {
          reason: undefined,
          resumeAt: null,
          unknownStreak: 0,
          nextDueAt: this.nextDue(res.controller, this.now()),
          ...(restart ? { refreshCount: 0, navigationCount: 0, startedAt: this.now(), generation: rt.generation + 1 } : {}),
        });
      } else {
        rt = transition(rt, status, { reason, nextDueAt: null, resumeAt: null, generation: rt.generation + 1 });
      }
      await this.deps.stores.runtime.put(rt);
      await this.setAlarm(rt);
      return rt;
    });
  }

  /**
   * Manual "refresh now". Does not change the run state (a stopped rule stays
   * stopped). Respects exclusions and safety unless `force` is set.
   */
  async refreshNow(tabId: number, opts: { force?: boolean; actor?: Actor } = {}): Promise<{ refreshed: boolean; reason?: string }> {
    return this.withLock(tabId, async () => {
      const tab = await this.deps.browser.getTab(tabId);
      if (!tab) return { refreshed: false, reason: "Tab not found" };
      const config = await this.deps.stores.config.get();
      const res = resolveTab(tab, config);
      if (res.kind === "restricted") return { refreshed: false, reason: res.reason };
      if (!opts.force) {
        if (res.kind === "tab_excluded" || res.kind === "url_excluded") return { refreshed: false, reason: res.reason };
        const safety = res.kind === "controller" ? res.controller.safety : config.settings.defaultSafety;
        const { activity, reason } = await this.deps.page.activity(tabId);
        // Manual refresh is an explicit gesture: only unsaved-change protection applies.
        const decision = decideSafety({
          safety: { ...safety, pauseWhileTyping: false, pauseOnMouse: false, pauseOnScroll: false, onActivityUnavailable: "refresh" },
          activity,
          unavailableReason: reason,
          fallbackRetryMs: 0,
        });
        if (!decision.allowed) return { refreshed: false, reason: decision.reason };
      }
      await this.deps.browser.reload(tabId, false);
      const actor = opts.actor?.type === "agent" ? "agent" : "user";
      this.log({ ruleId: res.kind === "controller" ? res.controller.id : null, tabId, url: tab.url, trigger: "manual", action: "refresh", outcome: "ok", actor, reason: opts.force ? "forced" : undefined });
      return { refreshed: true };
    });
  }

  async refreshAll(opts: { force?: boolean } = {}): Promise<{ refreshed: number[]; skipped: { tabId: number; reason: string }[] }> {
    const config = await this.deps.stores.config.get();
    const tabs = await this.deps.browser.listTabs();
    const refreshed: number[] = [];
    const skipped: { tabId: number; reason: string }[] = [];
    for (const tab of tabs) {
      const res = resolveTab(tab, config);
      if (res.kind !== "controller" && !(res.kind === "paused" && res.controller)) {
        skipped.push({ tabId: tab.id, reason: "reason" in res ? res.reason : "Not eligible" });
        continue;
      }
      if (this.deps.throttle) await this.deps.throttle();
      const r = await this.refreshNow(tab.id, { force: opts.force });
      if (r.refreshed) refreshed.push(tab.id);
      else skipped.push({ tabId: tab.id, reason: r.reason ?? "Skipped" });
    }
    return { refreshed, skipped };
  }

  /** Dry run: evaluate a rule's conditions against a tab with no side effects. */
  async dryRun(rule: Rule, tabId: number, includeText: boolean) {
    const tab = await this.deps.browser.getTab(tabId);
    if (!tab) return { ok: false as const, error: "Tab not found" };
    const rt = (await this.deps.stores.runtime.get(tabId)) ?? newRuntime(tabId, tab.url, this.now());
    if (!rule.stopWhen) return { ok: true as const, tab, result: { status: "not_matched" } as EvaluationResult, trace: null };
    const out = await evaluateConditionTree(rule.stopWhen, {
      now: this.now(),
      tab: { id: tab.id, url: tab.url, status: tab.status },
      runtime: { refreshCount: rt.refreshCount, navigationCount: rt.navigationCount, startedAt: rt.startedAt },
      pageEvaluator: (leaves) => this.deps.page.evaluate(tab.id, leaves, includeText),
      registries: this.registries,
    });
    return { ok: true as const, tab, result: out.result, trace: out.trace };
  }

  isPausedStatus = isPaused;
}
