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
import type { ActionContext, NotifyOptions, TriggerEvent } from "../registries/contracts";
import type { ActivitySnapshot } from "../shared/messaging-types";
import { evaluateConditionTree, explainTrace } from "./evaluator";
import { resolveTab, type Resolution } from "./rule-resolver";
import { decideSafety, FORM_RESULT_REASON } from "./safety";
import { checkLimits, inActiveWindow, limitDeadline, MIN_ALARM_DELAY_MS, nextWindowStart, restoredDueAt } from "./schedule";
import { isPaused, isTerminal, newRuntime, transition } from "./state-machine";
import { TimeoutError, withTimeout } from "./timeout";
import { FAST_SITE_SPACING_MS, MIN_INTERVAL_SECONDS } from "../triggers/interval";
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
  /** Load `url` in the tab as a normal visit (GET): never resends a form. */
  navigate(tabId: number, url: string): Promise<void>;
  notify(id: string, title: string, message: string, opts?: NotifyOptions): Promise<void>;
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
  /** Override the bounded-wait limits (tests use short values). */
  timeouts?: Partial<EngineTimeouts>;
}

export interface EngineTimeouts {
  /** Max wait for a content-script round trip (activity / DOM evaluation). */
  pageMs: number;
  /** Max wait for chrome.tabs.reload to return. */
  reloadMs: number;
  /** Backstop: max time one operation may hold a tab's lock. */
  lockMs: number;
  /** A tab left in "evaluating" longer than this is re-run by a watchdog alarm. */
  watchdogMs: number;
}

export const DEFAULT_TIMEOUTS: EngineTimeouts = {
  pageMs: 15_000,
  reloadMs: 10_000,
  lockMs: 45_000,
  // Must exceed lockMs so the watchdog cycle can acquire the lock, and be at
  // least Chrome's minimum alarm delay.
  watchdogMs: 60_000,
};

export const ALARM_PREFIX = "sar:tab:";
export const NAVIGATION_TIMEOUT_MS = 60_000;

export const alarmName = (tabId: number) => `${ALARM_PREFIX}${tabId}`;
export const tabIdFromAlarm = (name: string): number | null =>
  name.startsWith(ALARM_PREFIX) ? Number(name.slice(ALARM_PREFIX.length)) : null;

export { FORM_RESULT_REASON } from "./safety";

class SafetyBlock extends Error {
  constructor(
    public readonly status: ExecutionStatus,
    public readonly reason: string,
    /** null = no timer: something else resumes the tab. */
    public readonly retryAt: number | null,
    /** Routine deferrals (e.g. the per-site rate limit) are not written to history. */
    public readonly quiet = false,
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
  /** Last fast-interval automatic reload per host (in memory; resets with the worker). */
  private readonly lastFastReloadByHost = new Map<string, number>();
  private readonly timeouts: EngineTimeouts;
  /** Page port with bounded waits: a stalled page yields "unavailable"/"unknown", never a hang. */
  private readonly page: PagePort;

  constructor(private readonly deps: EngineDeps) {
    this.registries = deps.registries ?? defaultRegistries();
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
    const { pageMs } = this.timeouts;
    this.page = {
      // A rejection here is reported by the evaluator as an `unknown` result.
      evaluate: (tabId, leaves, includeText) => withTimeout(deps.page.evaluate(tabId, leaves, includeText), pageMs, "Page"),
      activity: (tabId) =>
        withTimeout(deps.page.activity(tabId), pageMs, "Page").catch((e: Error) => ({ activity: null, reason: e.message })),
    };
  }

  private reloadTab(tabId: number, bypassCache: boolean) {
    return withTimeout(this.deps.browser.reload(tabId, bypassCache), this.timeouts.reloadMs, "Tab reload");
  }

  /**
   * Serialize all work per tab: one operation per tab at a time.
   *
   * Every browser call inside is bounded, so operations finish on their own.
   * As a backstop, an operation that still holds the lock after `lockMs`
   * releases it (its caller gets a TimeoutError) so one stalled call cannot
   * block the tab — and every API call touching the tab — forever.
   */
  private withLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(tabId) ?? Promise.resolve();
    // Bound the operation's own run time (not its wait in the queue).
    const run = () =>
      withTimeout(fn(), this.timeouts.lockMs, `Operation on tab ${tabId}`).catch((e) => {
        if (e instanceof TimeoutError) console.warn(`[sar] ${e.message}; releasing the tab lock`);
        throw e;
      });
    const next = prev.then(run, run);
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
      await this.resumeAfterFormPage(tabId);
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
    if ((await this.deps.stores.config.get()).tabOverrides[String(tabId)]) {
      await this.deps.stores.config.update((c) => {
        delete c.tabOverrides[String(tabId)];
      });
    }
  }

  /**
   * A tab paused on a form result has loaded a page: carry on with the
   * schedule. If the new page is a form result too, the next refresh attempt
   * pauses it again.
   */
  private async resumeAfterFormPage(tabId: number) {
    await this.withLock(tabId, async () => {
      const rt = await this.deps.stores.runtime.get(tabId);
      if (rt?.status !== "paused_resubmit") return;
      const tab = await this.deps.browser.getTab(tabId);
      if (!tab) return;
      const res = resolveTab(tab, await this.deps.stores.config.get());
      if (res.kind !== "controller") return;
      const next = transition(rt, "scheduled", { reason: undefined, nextDueAt: this.nextDue(res.controller, this.now()) });
      await this.deps.stores.runtime.put(next);
      await this.setAlarm(next);
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

      // We hold the tab lock, so an "evaluating" state here was left by a cycle
      // that never finished (worker terminated, or released by the lock
      // backstop). Recover it instead of failing the transition below.
      if (rt.status === "evaluating") {
        this.log({ ruleId: rule.id, tabId, url: tab.url, trigger: event, action: "recover", outcome: "ok", reason: "Previous evaluation did not finish; retrying" });
        rt = transition(rt, "scheduled", { reason: undefined });
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
        // A rule waiting for something on the page must not end silently: say
        // it stopped without finding it. Plain timers end quietly.
        if (rule.stopWhen) await this.notifyStopped(config, rule, tab, `${limit.reason} before the condition was met. Open the popup to start again.`);
        return save(transition(rt, "completed", { reason: rule.stopWhen ? `${limit.reason}; the condition wasn't met` : limit.reason, nextDueAt: null }));
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
      // Watchdog: if this cycle never finishes (worker killed, stalled call),
      // the alarm fires again and re-runs it. A normal finish replaces it.
      await this.deps.alarms.set(alarmName(tabId), now + this.timeouts.watchdogMs);
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
          if (giveUp) await this.notifyStopped(config, rule, tab, `Gave up after ${streak} checks could not read the page: ${reason}. Open the popup to retry.`);
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
          await this.notifyStopped(config, rule, tab, `The page could not be checked: ${reason}`);
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

  /**
   * A monitor that ends without its condition matching must not end silently
   * (e.g. an overnight "refresh until in stock" hitting a login page).
   */
  private async notifyStopped(config: Config, rule: Rule, tab: TabInfo, message: string) {
    if (!config.settings.notificationsEnabled) return;
    await this.deps.browser.notify(`sar:${rule.id}:${tab.id}:${this.now()}`, `Monitoring stopped: ${rule.name}`, message);
  }

  private async evaluate(rule: Rule, tab: TabInfo, rt: TabRuntime) {
    return evaluateConditionTree(rule.stopWhen!, {
      now: this.now(),
      tab: { id: tab.id, url: tab.url, status: tab.status },
      runtime: { refreshCount: rt.refreshCount, navigationCount: rt.navigationCount, startedAt: rt.startedAt },
      pageEvaluator: (leaves) => this.page.evaluate(tab.id, leaves, false),
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
        notify: async (title, message, opts) => {
          if (!config.settings.notificationsEnabled) return;
          await this.deps.browser.notify(`sar:${rule.id}:${tab.id}:${this.now()}`, title, message, opts);
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
          if (!e.quiet) this.log({ ruleId: rule.id, tabId: tab.id, url: tab.url, trigger: event, condition, action: action.type, outcome: "skipped", reason: e.reason });
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
    const { activity, reason } = await this.page.activity(tab.id);
    // Never reload a form result: Chrome would ask to resend it (and an
    // unattended tab gets stuck on that prompt). Applies whatever the
    // protection settings, and is announced once.
    if (activity?.formResult) {
      // The status has moved on to "evaluating" by now; the reason is kept.
      const already = rt.reason === FORM_RESULT_REASON;
      if (!already && _config.settings.notificationsEnabled) {
        await this.deps.browser.notify(`sar:form:${tab.id}:${now}`, `Refreshing paused: ${siteKey(tab.url) ?? "this page"}`, "This page came from submitting a form, so refreshing it could send the form again. Open the JustRefresh popup to open the page fresh.");
      }
      // No retry timer: nothing changes while the tab stays on this page. It
      // resumes when the tab loads another page (onTabUpdated) or is opened
      // fresh. A time limit still ends the run on time.
      const deadline = limitDeadline(rule.limits, rt);
      throw new SafetyBlock("paused_resubmit", FORM_RESULT_REASON, deadline === null ? null : Math.max(deadline, now + MIN_ALARM_DELAY_MS), already);
    }
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
    // Fast intervals (< 30 s): at most one automatic refresh per site per
    // FAST_SITE_SPACING_MS across all tabs, so many tabs on one site cannot
    // add up to a flood of requests.
    const intervalMs = this.nextDue(rule, 0);
    const host = siteKey(tab.url);
    const fast = intervalMs !== null && intervalMs < MIN_INTERVAL_SECONDS * 1000 && host !== null;
    if (fast) {
      const last = this.lastFastReloadByHost.get(host) ?? -Infinity;
      if (now - last < FAST_SITE_SPACING_MS) {
        throw new SafetyBlock("scheduled", "Waiting: at most one fast refresh per site every 5 seconds", last + FAST_SITE_SPACING_MS, true);
      }
      this.lastFastReloadByHost.set(host, now);
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
      await this.reloadTab(tab.id, bypassCache);
    } catch (e) {
      // A slow reload call may still go through: keep it pending. Navigation
      // completion or NAVIGATION_TIMEOUT_MS settles it either way.
      if (e instanceof TimeoutError) {
        console.warn(`[sar] ${e.message} (tab ${tab.id}); tracking it as pending`);
        return next;
      }
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
  async refreshNow(tabId: number, opts: { force?: boolean; actor?: Actor } = {}): Promise<{ refreshed: boolean; reason?: string; formResult?: boolean }> {
    return this.withLock(tabId, async () => {
      const tab = await this.deps.browser.getTab(tabId);
      if (!tab) return { refreshed: false, reason: "Tab not found" };
      const config = await this.deps.stores.config.get();
      const res = resolveTab(tab, config);
      if (res.kind === "restricted") return { refreshed: false, reason: res.reason };
      if (!opts.force && (res.kind === "tab_excluded" || res.kind === "url_excluded")) return { refreshed: false, reason: res.reason };
      const { activity, reason } = await this.page.activity(tabId);
      // Not even a forced refresh may resend a form: "Open this page fresh" is the way out.
      if (activity?.formResult) return { refreshed: false, reason: FORM_RESULT_REASON, formResult: true };
      if (!opts.force) {
        const safety = res.kind === "controller" ? res.controller.safety : config.settings.defaultSafety;
        // Manual refresh is an explicit gesture: only unsaved-change protection applies.
        const decision = decideSafety({
          safety: { ...safety, pauseWhileTyping: false, pauseOnMouse: false, pauseOnScroll: false, onActivityUnavailable: "refresh" },
          activity,
          unavailableReason: reason,
          fallbackRetryMs: 0,
        });
        if (!decision.allowed) return { refreshed: false, reason: decision.reason };
      }
      await this.reloadTab(tabId, false);
      if (res.kind === "controller") await this.restartCountdown(tabId, res.controller);
      const actor = opts.actor?.type === "agent" ? "agent" : "user";
      this.log({ ruleId: res.kind === "controller" ? res.controller.id : null, tabId, url: tab.url, trigger: "manual", action: "refresh", outcome: "ok", actor, reason: opts.force ? "forced" : undefined });
      return { refreshed: true };
    });
  }

  /**
   * "Open this page fresh": load the tab's address as a normal visit, which
   * never resends a form, and carry on refreshing a tab that was paused on a
   * form result.
   */
  async openFresh(tabId: number, opts: { actor?: Actor } = {}): Promise<{ opened: boolean; reason?: string }> {
    return this.withLock(tabId, async () => {
      const tab = await this.deps.browser.getTab(tabId);
      if (!tab) return { opened: false, reason: "Tab not found" };
      const config = await this.deps.stores.config.get();
      const res = resolveTab(tab, config);
      if (res.kind === "restricted") return { opened: false, reason: res.reason };
      // Without the #fragment: navigating to the same URL with a fragment is an
      // in-page jump that loads nothing.
      await this.deps.browser.navigate(tabId, tab.url.split("#")[0]!);
      const rt = await this.deps.stores.runtime.get(tabId);
      if (rt?.status === "paused_resubmit" && res.kind === "controller") {
        const next = transition(rt, "scheduled", { reason: undefined, nextDueAt: this.nextDue(res.controller, this.now()) });
        await this.deps.stores.runtime.put(next);
        await this.setAlarm(next);
      }
      const actor = opts.actor?.type === "agent" ? "agent" : "user";
      this.log({ ruleId: res.kind === "controller" ? res.controller.id : null, tabId, url: tab.url, trigger: "manual", action: "refresh", outcome: "ok", actor, reason: "Opened fresh (no form resent)" });
      return { opened: true };
    });
  }

  /**
   * After a manual refresh the next automatic one comes a full interval
   * later. Only an active schedule is touched (never restarts a paused,
   * stopped or completed tab — FR-02), and the due time only moves later,
   * so waits such as "outside active hours" are kept.
   */
  private async restartCountdown(tabId: number, rule: Rule) {
    const rt = await this.deps.stores.runtime.get(tabId);
    const due = this.nextDue(rule, this.now());
    if (!rt || rt.status !== "scheduled" || rt.nextDueAt === null || due === null) return;
    const next = { ...rt, nextDueAt: Math.max(rt.nextDueAt, due) };
    await this.deps.stores.runtime.put(next);
    await this.setAlarm(next);
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
      pageEvaluator: (leaves) => this.page.evaluate(tab.id, leaves, includeText),
      registries: this.registries,
    });
    return { ok: true as const, tab, result: out.result, trace: out.trace };
  }

  isPausedStatus = isPaused;
}

/** Host used for the per-site fast-refresh limit (null for non-web URLs). */
function siteKey(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : null;
  } catch {
    return null;
  }
}
