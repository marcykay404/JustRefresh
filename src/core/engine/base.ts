/**
 * Engine infrastructure shared by the refresh cycle and the event handlers:
 * per-tab locks, bounded page calls, persistence, and keeping a tab's run in
 * step with whatever controls it (sync).
 */
import type { Registries } from "../../registries";
import { defaultRegistries } from "../../registries";
import { evaluateConditionTree } from "../evaluator";
import type { Resolution } from "../rule-resolver";
import { MIN_ALARM_DELAY_MS, restoredDueAt } from "../schedule";
import { newRuntime, transition } from "../state-machine";
import { TimeoutError, withTimeout } from "../timeout";
import type { Config, HistoryEntry, Rule, TabInfo, TabRuntime } from "../types";
import { FAST_WAIT_REASON, FastSiteLimit } from "./fast-site-limit";
import { alarmName, DEFAULT_TIMEOUTS, type CycleResult, type EngineDeps, type EngineTimeouts, type PagePort, type RunEvent } from "./ports";
import { isNewRun, restingState, waitingReason, withoutHash } from "./support";

/** How long after the rule's click a change of page counts as that click's doing. */
const CLICK_NAVIGATION_MS = 15_000;

export abstract class EngineBase {
  protected readonly registries: Registries;
  private readonly locks = new Map<number, Promise<unknown>>();
  protected readonly timeouts: EngineTimeouts;
  /** Page port with bounded waits: a stalled page yields "unavailable"/"unknown", never a hang. */
  protected readonly page: PagePort;
  protected readonly fast = new FastSiteLimit();

  constructor(protected readonly deps: EngineDeps) {
    this.registries = deps.registries ?? defaultRegistries();
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
    const { pageMs } = this.timeouts;
    this.page = {
      // A rejection here is reported by the evaluator as an `unknown` result.
      evaluate: (tabId, leaves, includeText) => withTimeout(deps.page.evaluate(tabId, leaves, includeText), pageMs, "Page"),
      activity: (tabId) => withTimeout(deps.page.activity(tabId), pageMs, "Page").catch((e: Error) => ({ activity: null, reason: e.message })),
      click: (tabId, selector) => withTimeout(deps.page.click(tabId, selector), pageMs, "Page").catch((e: Error) => ({ ok: false as const, error: e.message })),
      highlight: (tabId, target) =>
        withTimeout(deps.page.highlight(tabId, target), pageMs, "Page").catch((e: Error) => ({ ok: false as const, error: e.message })),
      // Best effort: the refresh goes ahead without it.
      saveScroll: (tabId) => withTimeout(deps.page.saveScroll(tabId), pageMs, "Page").catch(() => undefined),
    };
  }

  protected reloadTab(tabId: number, bypassCache: boolean) {
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
  protected withLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(tabId) ?? Promise.resolve();
    // Bound the operation's own run time (not its wait in the queue).
    const run = () =>
      withTimeout(fn(), this.timeouts.lockMs, `Operation on tab ${tabId}`).catch((e) => {
        if (e instanceof TimeoutError) console.warn(`JustRefresh: ${e.message}; releasing the tab lock`);
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

  protected now() {
    return this.deps.clock.now();
  }

  protected log(e: Omit<HistoryEntry, "at" | "actor"> & { actor?: HistoryEntry["actor"] }) {
    void this.deps.stores.history.append({ at: this.now(), actor: "system", ...e });
  }

  /** Tell the agent behind a rule what happened (user rules: nothing to do). Never holds up the run. */
  protected emit(e: RunEvent) {
    if (e.rule.meta.origin.type !== "agent" || !this.deps.events) return;
    void this.deps.events.rule(e).catch((err: Error) => console.warn("JustRefresh: agent event", err));
  }

  /**
   * A run that changed status, for the agent behind the rule: it ended,
   * failed, or paused in a way only the user can clear (a form result, or the
   * rule's own pause with no end). Giving up on an unreadable page is
   * reported where it happens (onUnknown).
   */
  protected reportChange(rule: Rule, tab: Pick<TabInfo, "id" | "url">, before: TabRuntime["status"], after: TabRuntime) {
    if (after.status === before) return;
    const e = { rule, tabId: tab.id, url: tab.url, status: after.status, reason: after.reason };
    const ended = (s: TabRuntime["status"]) => s === "completed" || s === "stopped";
    if (ended(after.status) && !ended(before)) this.emit({ ...e, kind: "rule.completed" });
    else if (after.status === "error") this.emit({ ...e, kind: "rule.error" });
    else if (after.status === "paused_resubmit") this.emit({ ...e, kind: "rule.paused" });
    else if (after.status === "paused_user" && after.resumeAt === null) this.emit({ ...e, kind: "rule.paused" });
  }

  protected async setAlarm(rt: TabRuntime) {
    if (rt.nextDueAt === null) await this.deps.alarms.clear(alarmName(rt.tabId));
    else await this.deps.alarms.set(alarmName(rt.tabId), Math.max(rt.nextDueAt, this.now() + 1000));
  }

  /** Persist a tab's run and its alarm. Only a tab still waiting for its fast turn keeps its place in that queue. */
  protected async save(rt: TabRuntime): Promise<CycleResult> {
    if (rt.reason !== FAST_WAIT_REASON) this.fast.leave(rt.tabId);
    await this.deps.stores.runtime.put(rt);
    await this.setAlarm(rt);
    return { status: rt.status, reason: rt.reason };
  }

  protected nextDue(rule: Rule, from: number): number | null {
    const h = this.registries.triggers.get(rule.trigger.type);
    if (!h?.nextDueAt) return null;
    return h.nextDueAt(rule.trigger, from, this.deps.clock.random);
  }

  protected intervalMs(rule: Rule): number {
    const due = this.nextDue(rule, 0);
    return due === null ? 60_000 : Math.max(due, MIN_ALARM_DELAY_MS);
  }

  async forgetTab(tabId: number) {
    this.fast.leave(tabId);
    await this.deps.stores.runtime.delete(tabId);
    await this.deps.alarms.clear(alarmName(tabId));
  }

  /**
   * Forget every tab's run (Reset to defaults). Each waits for work already
   * running on that tab, so nothing it was doing is written back afterwards.
   */
  async forgetAllTabs() {
    for (const rt of await this.deps.stores.runtime.getAll()) {
      await this.withLock(rt.tabId, () => this.forgetTab(rt.tabId)).catch((e) => console.warn(`JustRefresh: could not forget tab ${rt.tabId}`, e));
    }
  }

  /* ---------------- resolution sync ---------------- */

  /**
   * Align runtime state with the current resolution. Resets the run (new
   * generation) when the controller, its revision, or the page changes.
   */
  protected sync(
    rt: TabRuntime | null,
    tab: TabInfo,
    res: Resolution,
    config: Config,
    opts: { restoring?: boolean; slot?: number; ownNavigation?: boolean } = {},
  ): TabRuntime {
    const cur = rt ?? newRuntime(tab.id, tab.url, this.now());
    if (res.kind !== "controller") return restingState(cur, tab, res);
    const rule = res.controller;
    // A page change shortly after the rule's own click, until that page has loaded, is the click's
    // doing (like the rule's own refresh): part of its run, so its counts and limits go on.
    const clicked = cur.clickedAt !== undefined && this.now() - cur.clickedAt < CLICK_NAVIGATION_MS;
    if (isNewRun(cur, tab, rule, opts.ownNavigation || clicked)) return this.newRun(cur, tab, rule, config, opts);
    return this.carryOn(cur, tab, rule, opts.restoring === true, opts.slot ?? 0);
  }

  /** Same run: follow the tab's address, and resume one that was resting. */
  private carryOn(cur: TabRuntime, tab: TabInfo, rule: Rule, restoring: boolean, slot: number): TabRuntime {
    const now = this.now();
    // Paused on a form result, the run remembers the form page's address.
    const kept = cur.status === "paused_resubmit" ? cur : { ...cur, url: tab.url };
    if (kept.status === "paused_global" || kept.status === "idle" || kept.status === "excluded") {
      // Resuming: do not fire overdue schedules at once.
      const intervalDue = this.nextDue(rule, now);
      return transition(kept, "scheduled", {
        reason: undefined,
        nextDueAt: intervalDue === null ? null : restoredDueAt(kept.nextDueAt, intervalDue, now, slot),
      });
    }
    if (restoring && kept.nextDueAt !== null && kept.status === "scheduled") {
      return { ...kept, nextDueAt: restoredDueAt(kept.nextDueAt, this.nextDue(rule, now) ?? now, now, slot) };
    }
    return kept;
  }

  /** Start a new run (new generation) of `rule` on the tab. */
  protected newRun(cur: TabRuntime, tab: TabInfo, rule: Rule, config: Config, opts: { restoring?: boolean; slot?: number } = {}): TabRuntime {
    const now = this.now();
    const fresh: TabRuntime = { ...newRuntime(tab.id, tab.url, now, cur.generation + 1), controllerId: rule.id, controllerRevision: rule.meta.revision };
    const override = config.tabOverrides[String(tab.id)];
    if (override?.mode === "custom" && override.stopped) return transition(fresh, "stopped", { reason: "Stopped by user" });
    if (override?.mode === "custom" && override.paused) return transition(fresh, "paused_user", { reason: "Paused by user" });
    const intervalDue = this.nextDue(rule, now);
    const nextDueAt = intervalDue === null ? null : opts.restoring ? restoredDueAt(null, intervalDue, now, opts.slot ?? 0) : intervalDue;
    return transition(fresh, "scheduled", { nextDueAt, reason: nextDueAt === null ? waitingReason(rule) : undefined });
  }

  /**
   * Leave the form-page pause. Another page starts a new run, as any
   * navigation does; the same page (ignoring #…) carries on with the run. The
   * run then follows the tab's current address, so the next sync doesn't
   * mistake it for a new page.
   */
  protected leaveFormPause(rt: TabRuntime, tab: TabInfo, rule: Rule, config: Config): TabRuntime {
    if (rule.id !== rt.controllerId || withoutHash(rt.url) !== withoutHash(tab.url)) return this.newRun(rt, tab, rule, config);
    return transition(rt, "scheduled", { reason: undefined, url: tab.url, nextDueAt: this.nextDue(rule, this.now()) });
  }

  /* ---------------- shared by cycle and events ---------------- */

  /**
   * A monitor that ends without its condition matching must not end silently
   * (e.g. an overnight "refresh until in stock" hitting a login page).
   */
  protected async notifyStopped(config: Config, rule: Rule, tab: TabInfo, message: string) {
    if (!config.settings.notificationsEnabled) return;
    await this.deps.browser.notify(`justrefresh:${rule.id}:${tab.id}:${this.now()}`, `Monitoring stopped: ${rule.name}`, message);
  }

  /**
   * Check the rule's condition. Stateful conditions (content changed, text
   * gone) compare with the previous check only on the page they remember (its
   * path: a login redirect isn't a change, and "?…" may differ per load), and
   * not right after the rule's own reload (`justLoaded`), when a page that
   * renders its content later may not have it yet: the next check compares.
   */
  protected async evaluate(rule: Rule, tab: TabInfo, rt: TabRuntime, opts: { justLoaded?: boolean } = {}) {
    const page = pagePath(tab.url);
    const compare = !opts.justLoaded && (rt.memory === undefined || rt.memory[PAGE_KEY] === page);
    const out = await evaluateConditionTree(rule.stopWhen!, {
      now: this.now(),
      tab: { id: tab.id, url: tab.url, status: tab.status },
      runtime: { refreshCount: rt.refreshCount, navigationCount: rt.navigationCount, startedAt: rt.startedAt },
      pageEvaluator: (leaves) => this.page.evaluate(tab.id, leaves, false),
      registries: this.registries,
      memory: compare ? (rt.memory ?? {}) : null,
    });
    return { ...out, memory: compare ? onPage(out.memory, page) : (rt.memory ?? {}) };
  }
}

/** Where TabRuntime.memory records the page it belongs to. */
const PAGE_KEY = "@page";

/** A page as stateful conditions tell pages apart: origin and path. */
function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

/** The memory stamped with its page, or empty when no condition remembered anything. */
function onPage(memory: Record<string, string>, page: string): Record<string, string> {
  const { [PAGE_KEY]: _p, ...kept } = memory;
  return Object.keys(kept).length ? { ...kept, [PAGE_KEY]: page } : {};
}
