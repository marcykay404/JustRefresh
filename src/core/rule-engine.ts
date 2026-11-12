/**
 * Rule engine: the single execution core shared by quick controls, URL rules,
 * imported rules and agent-created rules.
 *
 * The engine knows nothing about specific triggers, conditions or actions —
 * it asks the registries. Browser access goes through ports so the engine
 * can be tested without Chrome. Layers (src/core/engine/):
 *
 *   ports.ts   what the engine needs from the browser and storage
 *   base.ts    per-tab locks, persistence, keeping a run in step (sync)
 *   cycle.ts   one refresh cycle: eligibility → evaluate → act → refresh
 *   this file  events, reconciliation, and user controls
 */
import type { TriggerEvent } from "../registries/contracts";
import { evaluateConditionTree, explainTrace } from "./evaluator";
import { resolveTab, type Resolution } from "./rule-resolver";
import { decideSafety, FORM_RESULT_REASON } from "./safety";
import { isPaused, newRuntime, transition } from "./state-machine";
import type { Actor, Config, EvaluationResult, Rule, TabInfo, TabRuntime } from "./types";
import { CycleEngine } from "./engine/cycle";
import { FAST_WAIT_REASON } from "./engine/fast-site-limit";
import { alarmName, tabIdFromAlarm, type CycleResult } from "./engine/ports";
import { resolutionKey, waitingReason, withMemory, withoutHash } from "./engine/support";

export * from "./engine/ports";
export { FORM_RESULT_REASON } from "./safety";
export { FAST_WAIT_REASON } from "./engine/fast-site-limit";

export class RuleEngine extends CycleEngine {
  /* ---------------- reconciliation ---------------- */

  /**
   * Reconcile every open tab with the configuration: used on startup, on
   * service-worker wake, and after configuration changes. Recreates missing
   * alarms, removes stale ones, and staggers overdue schedules.
   */
  async reconcileAll(reason: "startup" | "wake" | "config", opts: { before?: Config } = {}): Promise<void> {
    // One at a time: a later reconcile that skips unaffected tabs must not
    // overtake an earlier one still waiting for a busy tab, or the earlier one
    // would write last, with the older config.
    const run = this.reconcileChain.then(() => this.reconcileOnce(reason, opts));
    this.reconcileChain = run.catch(() => undefined);
    const tabs = await run;
    if (reason === "startup") {
      for (const tab of tabs) await this.handleEvent(tab.id, "startup");
    }
  }

  private reconcileChain: Promise<unknown> = Promise.resolve();

  private async reconcileOnce(reason: "startup" | "wake" | "config", opts: { before?: Config }): Promise<TabInfo[]> {
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
      // A closed tab's alarm, or one this version doesn't use (e.g. named by an
      // older version: Chrome keeps alarms across updates). Running tabs get
      // their alarm set again below.
      if (id === null || !open.has(id)) await this.deps.alarms.clear(a.name);
    }
    const alarmMap = new Map(alarms.map((a) => [a.name, a.scheduledTime]));
    let slot = 0;
    for (const tab of tabs) {
      const res = resolveTab(tab, config);
      // After a change (an agent's or the user's), only tabs whose controlling
      // rule or state the change affects need a look: the rest are already in
      // sync, and re-checking them costs a lock and a storage write each.
      if (opts.before && resolutionKey(resolveTab(tab, opts.before)) === resolutionKey(res)) continue;
      // One tab failing (e.g. its lock timing out) must not leave the rest unsynced.
      await this.withLock(tab.id, async () => {
        const rt = await this.deps.stores.runtime.get(tab.id);
        const next = this.sync(rt, tab, res, config, { restoring: reason !== "config", slot });
        if (next.nextDueAt !== null) slot++;
        if (next.status === "idle" && !rt) return; // nothing to track
        // Unchanged (the common case on wake): no write, so no storage event either.
        if (!rt || JSON.stringify(rt) !== JSON.stringify(next)) await this.deps.stores.runtime.put(next);
        const existing = alarmMap.get(alarmName(tab.id));
        if (next.nextDueAt === null) {
          if (existing !== undefined) await this.deps.alarms.clear(alarmName(tab.id));
        } else if (existing === undefined || Math.abs(existing - next.nextDueAt) > 1000) {
          await this.setAlarm(next);
        }
      }).catch((e) => console.warn(`JustRefresh: could not re-check tab ${tab.id}`, e));
    }
    return tabs;
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
      if (next.reason !== FAST_WAIT_REASON) this.fast.leave(tabId);
      await this.deps.stores.runtime.put(next);
      await this.setAlarm(next);
      return next;
    });
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
    if (rt)
      await this.deps.stores.runtime.put({
        ...rt,
        tabId: addedTabId,
        controllerId: rt.controllerId?.startsWith("tab:") ? `tab:${addedTabId}` : rt.controllerId,
      });
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
   * A tab paused on a form result has loaded a page: carry on. Another page
   * starts a new run, as any navigation does; the same address loaded as a
   * normal visit keeps the run. If the new page is a form result too, the next
   * refresh attempt pauses it again.
   */
  private async resumeAfterFormPage(tabId: number) {
    await this.withLock(tabId, async () => {
      const rt = await this.deps.stores.runtime.get(tabId);
      if (rt?.status !== "paused_resubmit") return;
      const tab = await this.deps.browser.getTab(tabId);
      if (!tab) return;
      const res = resolveTab(tab, await this.deps.stores.config.get());
      if (res.kind !== "controller") return;
      // Some pages fire "complete" without leaving (e.g. history.pushState to the
      // same address): stay paused, quietly, while it's still the form result.
      const { activity } = await this.page.activity(tabId);
      if (activity?.formResult) return;
      const next = this.leaveFormPause(rt, tab, res.controller, await this.deps.stores.config.get());
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
        cur = { ...latest, lastEvaluation: { at: now, status: evalOut.result.status, reason: explainTrace(evalOut.trace) }, ...withMemory(evalOut.memory) };
        if (evalOut.result.status === "matched") {
          cur = await this.runActions({ rule, tab, event: "navigation" }, cur, rule.actions.onMatched, evalOut.result.status, { allowRefresh: false });
        } else {
          cur = transition(cur, "scheduled", { reason: undefined });
        }
      } else if (cur.status === "refreshing") {
        cur = transition(cur, "scheduled", { reason: undefined });
      }
      // A rule without a timer had only a watchdog for the reload: it loaded, so drop it.
      if (cur.status === "scheduled" && this.nextDue(rule, now) === null) {
        cur = { ...cur, nextDueAt: null, reason: waitingReason(rule) };
      }
      await this.deps.stores.runtime.put(cur);
      await this.setAlarm(cur);
      return true;
    });
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
      // Leaving a form-page pause (which kept the form page's address): follow the tab.
      rt = { ...rt, url: tab.url };
      this.fast.leave(tabId);
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
      const blocked = await this.manualRefreshBlocked(tabId, res, config, opts.force === true);
      if (blocked) return { refreshed: false, ...blocked };
      await this.reloadTab(tabId, false);
      if (res.kind === "controller") await this.restartCountdown(tabId, res.controller);
      const actor = opts.actor?.type === "agent" ? "agent" : "user";
      this.log({
        ruleId: res.kind === "controller" ? res.controller.id : null,
        tabId,
        url: tab.url,
        trigger: "manual",
        action: "refresh",
        outcome: "ok",
        actor,
        reason: opts.force ? "forced" : undefined,
      });
      return { refreshed: true };
    });
  }

  /** Why a manual refresh can't happen now (null = it can). */
  private async manualRefreshBlocked(tabId: number, res: Resolution, config: Config, force: boolean): Promise<{ reason: string; formResult?: boolean } | null> {
    if (res.kind === "restricted") return { reason: res.reason };
    if (!force && (res.kind === "tab_excluded" || res.kind === "url_excluded")) return { reason: res.reason };
    const { activity, reason } = await this.page.activity(tabId);
    // Not even a forced refresh may resend a form: "Open this page fresh" is the way out.
    if (activity?.formResult) return { reason: FORM_RESULT_REASON, formResult: true };
    if (force) return null;
    const safety = res.kind === "controller" ? res.controller.safety : config.settings.defaultSafety;
    // Manual refresh is an explicit gesture: only unsaved-change protection applies.
    const decision = decideSafety({
      safety: { ...safety, pauseWhileTyping: false, pauseOnMouse: false, pauseOnScroll: false, onActivityUnavailable: "refresh" },
      activity,
      unavailableReason: reason,
      fallbackRetryMs: 0,
    });
    return decision.allowed ? null : { reason: decision.reason };
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
      await this.deps.browser.navigate(tabId, withoutHash(tab.url));
      const rt = await this.deps.stores.runtime.get(tabId);
      if (rt?.status === "paused_resubmit" && res.kind === "controller") {
        const next = this.leaveFormPause(rt, { ...tab, url: withoutHash(tab.url) }, res.controller, config);
        await this.deps.stores.runtime.put(next);
        await this.setAlarm(next);
      }
      const actor = opts.actor?.type === "agent" ? "agent" : "user";
      this.log({
        ruleId: res.kind === "controller" ? res.controller.id : null,
        tabId,
        url: tab.url,
        trigger: "manual",
        action: "refresh",
        outcome: "ok",
        actor,
        reason: "Opened fresh (no form resent)",
      });
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
