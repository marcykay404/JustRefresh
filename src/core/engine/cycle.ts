/**
 * One evaluation lifecycle (FR-08), in steps:
 *
 *   start         → load the tab, resolve its controller, sync its run
 *   foreign event → an event that isn't the rule's trigger (only the
 *                   engine's own alarms do anything then)
 *   eligibility   → pauses, finished runs, a reload in flight, limits,
 *                   active hours, discarded tabs
 *   evaluate      → the stop condition, then the matching action list
 *   refresh       → safety gate, form-result guard, fast-site limit, reload
 *
 * Navigation completion is tracked separately (rule-engine.ts).
 */
import { isLocalWebhookUrl } from "../../actions/page";
import type { ActionContext, TriggerEvent, TriggerHandler } from "../../registries/contracts";
import type { ActivitySnapshot } from "../../shared/messaging-types";
import { explainTrace, onlyFramesNotReady } from "../evaluator";
import { resolveTab } from "../rule-resolver";
import { decideSafety, FORM_RESULT_REASON } from "../safety";
import { checkLimits, inActiveWindow, limitDeadline, MIN_ALARM_DELAY_MS, nextWindowStart } from "../schedule";
import { isTerminal, transition } from "../state-machine";
import { TimeoutError } from "../timeout";
import { MIN_INTERVAL_SECONDS } from "../../triggers/interval";
import type { ActionConfig, Actor, Config, EvaluationResult, EvaluationTrace, HistoryEntry, Rule, TabInfo, TabRuntime } from "../types";
import { EngineBase } from "./base";
import { FAST_WAIT_REASON } from "./fast-site-limit";
import { alarmName, NAVIGATION_TIMEOUT_MS, type CycleResult } from "./ports";
import { SafetyBlock, siteKey, waitingReason, withMemory } from "./support";

/** Everything one cycle works with. `rt` is updated as the cycle moves on. */
interface Cycle {
  tabId: number;
  event: TriggerEvent;
  config: Config;
  tab: TabInfo;
  rule: Rule;
  trigger: TriggerHandler;
  now: number;
  rt: TabRuntime;
}

type Outcome = EvaluationResult["status"];

export abstract class CycleEngine extends EngineBase {
  async runCycle(tabId: number, event: TriggerEvent, _opts: { actor?: Actor } = {}): Promise<CycleResult | null> {
    return this.withLock(tabId, async () => {
      const start = await this.startCycle(tabId, event);
      if ("result" in start) return start.result;
      return (await this.foreignEvent(start)) ?? (await this.checkEligibility(start)) ?? (await this.evaluateAndAct(start));
    });
  }

  /** Load the tab and its controller. Ends here for tabs no rule runs. */
  private async startCycle(tabId: number, event: TriggerEvent): Promise<Cycle | { result: CycleResult | null }> {
    const config = await this.deps.stores.config.get();
    const tab = await this.deps.browser.getTab(tabId);
    if (!tab) {
      await this.forgetTab(tabId);
      return { result: null };
    }
    const res = resolveTab(tab, config);
    const prev = await this.deps.stores.runtime.get(tabId);
    const rt = this.sync(prev, tab, res, config);
    if (res.kind !== "controller") {
      if (!prev && rt.status === "idle") return { result: { status: "idle", reason: rt.reason } };
      return { result: await this.save(rt) };
    }
    const rule = res.controller;
    const trigger = this.registries.triggers.get(rule.trigger.type);
    if (!trigger) return { result: await this.save(transition(rt, "error", { lastError: `Unknown trigger ${rule.trigger.type}`, nextDueAt: null })) };
    return { tabId, event, config, tab, rule, trigger, now: this.now(), rt };
  }

  /** A time limit that has passed ends the run (and says so when it was waiting for something). */
  private async endOnLimit(c: Cycle): Promise<CycleResult | null> {
    const { rule, tab } = c;
    const limit = checkLimits(rule.limits, c.rt, c.now);
    if (!limit.reached) return null;
    this.log({ ruleId: rule.id, tabId: c.tabId, url: tab.url, trigger: c.event, action: "stop", outcome: "ok", reason: limit.reason });
    // A rule waiting for something on the page must not end silently: say it
    // stopped without finding it. Plain timers end quietly.
    if (rule.stopWhen) await this.notifyStopped(c.config, rule, tab, `${limit.reason} before the condition was met. Open the popup to start again.`);
    return this.save(transition(c.rt, "completed", { reason: rule.stopWhen ? `${limit.reason}; the condition wasn't met` : limit.reason, nextDueAt: null }));
  }

  /**
   * An event that isn't this rule's trigger. For rules not run by a timer
   * (page load, startup, manual) an alarm is one the engine set itself: a time
   * limit, a postponed refresh, a timed pause, active hours opening, or a
   * watchdog. A postponed refresh carries on with the cycle; the rest settle here.
   */
  private async foreignEvent(c: Cycle): Promise<CycleResult | null> {
    const ownAlarm = c.event === "alarm" && !c.trigger.events.includes("alarm");
    if (ownAlarm && !isTerminal(c.rt.status) && !c.rt.pendingReload) {
      const ended = await this.endOnLimit(c);
      if (ended) return ended;
    }
    const postponed = (c.rt.status === "paused_activity" || c.rt.status === "paused_unsaved") && !c.rt.pendingReload;
    if (c.event === "manual" || c.trigger.events.includes(c.event) || (ownAlarm && postponed)) return null;
    return this.save(ownAlarm ? this.settleOwnAlarm(c) : c.rt);
  }

  /** The engine's own alarm for a rule without a timer: recover, re-arm the watchdog, or clear a past alarm. */
  private settleOwnAlarm(c: Cycle): TabRuntime {
    const { rt, now, rule } = c;
    const waiting = waitingReason(rule);
    // The watchdog of a reload or check that never finished (worker killed,
    // page never loaded): recover without running the rule again.
    const stalledReload = !!rt.pendingReload && now - rt.pendingReload.startedAt >= NAVIGATION_TIMEOUT_MS;
    if (stalledReload || rt.status === "evaluating") {
      const reason = stalledReload ? "Previous reload did not complete in time" : "Previous evaluation did not finish";
      this.log({ ruleId: rule.id, tabId: c.tabId, url: c.tab.url, trigger: c.event, action: "recover", outcome: "ok", reason });
      const cleared = { ...rt, pendingReload: null, ...(stalledReload ? { lastError: reason } : {}) };
      const back = cleared.status === "refreshing" || cleared.status === "evaluating" ? transition(cleared, "scheduled", { reason: waiting }) : cleared;
      return { ...back, nextDueAt: null };
    }
    if (rt.pendingReload) return { ...rt, nextDueAt: rt.pendingReload.startedAt + NAVIGATION_TIMEOUT_MS };
    // Nothing else to do: don't re-arm a past alarm (it would fire every 30 s
    // forever). A timed pause that is over ends here; the rule then waits for
    // its own trigger.
    if (rt.nextDueAt === null || rt.nextDueAt > now) return rt;
    if (rt.status === "paused_user" && rt.resumeAt !== null && rt.resumeAt <= now) {
      return transition(rt, "scheduled", { resumeAt: null, reason: waiting, nextDueAt: null });
    }
    return { ...rt, nextDueAt: null, ...(rt.status === "scheduled" ? { reason: waiting } : {}) };
  }

  /** Whether the rule may run now. Returns the result when it may not. */
  private async checkEligibility(c: Cycle): Promise<CycleResult | null> {
    this.recoverUnfinished(c);
    const held = this.holdWhilePaused(c) ?? this.waitForPendingReload(c);
    if (held) return this.save(held);
    const ended = await this.endOnLimit(c);
    if (ended) return ended;
    const waiting = this.waitForHoursOrTab(c);
    return waiting ? this.save(waiting) : null;
  }

  /**
   * We hold the tab lock, so an "evaluating" state here was left by a cycle
   * that never finished (worker terminated, or released by the lock
   * backstop). Recover it instead of failing the transition later.
   */
  private recoverUnfinished(c: Cycle) {
    if (c.rt.status !== "evaluating") return;
    this.log({
      ruleId: c.rule.id,
      tabId: c.tabId,
      url: c.tab.url,
      trigger: c.event,
      action: "recover",
      outcome: "ok",
      reason: "Previous evaluation did not finish; retrying",
    });
    c.rt = transition(c.rt, "scheduled", { reason: undefined });
  }

  /** A user or rule pause that hasn't ended, or a finished run (a manual run restarts it). */
  private holdWhilePaused(c: Cycle): TabRuntime | null {
    if (c.rt.status === "paused_user") {
      if (c.rt.resumeAt === null || c.rt.resumeAt > c.now) return { ...c.rt, nextDueAt: c.rt.resumeAt };
      c.rt = transition(c.rt, "scheduled", { resumeAt: null, reason: undefined });
    }
    if (isTerminal(c.rt.status)) {
      if (c.event !== "manual") return { ...c.rt, nextDueAt: null };
      // Running it again starts over: what stateful conditions saw before doesn't count.
      c.rt = transition(c.rt, "scheduled", { reason: undefined, memory: undefined });
    }
    return null;
  }

  /** A reload is in flight: never overlap. One that never finished is given up. */
  private waitForPendingReload(c: Cycle): TabRuntime | null {
    const pending = c.rt.pendingReload;
    if (!pending) return null;
    if (c.now - pending.startedAt < NAVIGATION_TIMEOUT_MS) return { ...c.rt, nextDueAt: c.now + MIN_ALARM_DELAY_MS };
    this.log({
      ruleId: c.rule.id,
      tabId: c.tabId,
      url: c.tab.url,
      trigger: c.event,
      action: "refresh",
      outcome: "error",
      reason: "Navigation did not complete",
    });
    c.rt = {
      ...c.rt,
      pendingReload: null,
      lastError: "Previous reload did not complete in time",
      status: c.rt.status === "refreshing" ? "scheduled" : c.rt.status,
    };
    return null;
  }

  /** Outside active hours, or a discarded tab (Memory Saver) that isn't to be woken. */
  private waitForHoursOrTab(c: Cycle): TabRuntime | null {
    const { rule, now } = c;
    if (!inActiveWindow(rule.schedule, now)) {
      const opens = nextWindowStart(rule.schedule, now);
      return transition(c.rt, "scheduled", { reason: "Outside active hours", nextDueAt: opens ?? this.nextDue(rule, now) });
    }
    if (c.tab.discarded && c.config.settings.skipDiscardedTabs && c.event !== "manual") {
      return transition(c.rt, "scheduled", { reason: "Tab is discarded (memory saver); skipped", nextDueAt: this.nextDue(rule, now) });
    }
    return null;
  }

  /** Check the stop condition, then run the matching action list. */
  private async evaluateAndAct(c: Cycle): Promise<CycleResult> {
    const { rule, now } = c;
    c.rt = transition(c.rt, "evaluating", { lastAttemptAt: now });
    await this.deps.stores.runtime.put(c.rt);
    // Watchdog: if this cycle never finishes (worker killed, stalled call),
    // the alarm fires again and re-runs it. A normal finish replaces it.
    await this.deps.alarms.set(alarmName(c.tabId), now + this.timeouts.watchdogMs);
    const generation = c.rt.generation;

    const out = rule.stopWhen ? await this.evaluate(rule, c.tab, c.rt) : null;
    const status: Outcome = out?.result.status ?? "not_matched";
    const trace: EvaluationTrace | undefined = out?.trace;
    const latest = await this.deps.stores.runtime.get(c.tabId);
    if (!latest || latest.generation !== generation || latest.status !== "evaluating") {
      return { status: latest?.status ?? "idle", reason: "Stale evaluation discarded" };
    }
    c.rt = out ? { ...latest, lastEvaluation: { at: now, status, reason: explainTrace(out.trace) }, ...withMemory(out.memory) } : latest;

    return { ...(await this.act(c, status, trace)), evaluation: trace };
  }

  /** The actions for what the check found. A frame still loading isn't a problem with the page: "not this time", keeping the unknown streak. */
  private async act(c: Cycle, status: Outcome, trace: EvaluationTrace | undefined): Promise<CycleResult> {
    if (status === "matched") return this.onMatched(c);
    const framesLoading = status === "unknown" && !!trace && onlyFramesNotReady(trace);
    const result = status === "unknown" && !framesLoading ? await this.onUnknown(c, trace) : null;
    return result ?? this.onNotMatched(c, framesLoading ? "not_matched" : status, framesLoading);
  }

  private async onMatched(c: Cycle): Promise<CycleResult> {
    c.rt = await this.runActions(c, { ...c.rt, unknownStreak: 0 }, c.rule.actions.onMatched, "matched", { allowRefresh: true });
    if (c.rt.status === "evaluating") c.rt = transition(c.rt, "scheduled", { nextDueAt: this.nextDue(c.rule, c.now) });
    return this.save(c.rt);
  }

  /** The page couldn't be checked: the rule's onUnknown actions, then its policy. null = treat as not matched. */
  private async onUnknown(c: Cycle, trace: EvaluationTrace | undefined): Promise<CycleResult | null> {
    const { rule, tab, now } = c;
    const policy = rule.safety.onUnknown;
    const reason = trace ? explainTrace(trace) : "unknown";
    if (rule.actions.onUnknown?.length) {
      c.rt = await this.runActions(c, c.rt, rule.actions.onUnknown, "unknown", { allowRefresh: policy === "refresh" });
      if (c.rt.status !== "evaluating") return this.save(c.rt);
    }
    const entry = { ruleId: rule.id, tabId: c.tabId, url: tab.url, trigger: c.event, condition: "unknown" as const };
    if (policy === "pause") {
      const streak = c.rt.unknownStreak + 1;
      const giveUp = streak > rule.safety.maxUnknownRetries;
      this.log({ ...entry, action: "pause", outcome: "skipped", reason });
      if (giveUp) await this.notifyStopped(c.config, rule, tab, `Gave up after ${streak} checks could not read the page: ${reason}. Open the popup to retry.`);
      return this.save(
        transition(c.rt, "paused_unknown", {
          unknownStreak: streak,
          reason: giveUp
            ? `Condition unknown after ${streak} attempts: ${reason}. Resume to retry.`
            : `Condition unknown (retry ${streak}/${rule.safety.maxUnknownRetries}): ${reason}`,
          nextDueAt: giveUp ? null : this.nextDue(rule, now),
        }),
      );
    }
    if (policy === "stop") {
      this.log({ ...entry, action: "stop", outcome: "ok", reason });
      await this.notifyStopped(c.config, rule, tab, `The page could not be checked: ${reason}`);
      return this.save(transition(c.rt, "stopped", { reason: `Stopped: condition unknown (${reason})`, nextDueAt: null }));
    }
    if (policy === "skip") {
      this.log({ ...entry, action: "skip", outcome: "skipped", reason });
      return this.save(transition(c.rt, "scheduled", { reason: `Skipped: condition unknown (${reason})`, nextDueAt: this.nextDue(rule, now) }));
    }
    return null; // "refresh": carry on as if not matched
  }

  private async onNotMatched(c: Cycle, status: Outcome, keepStreak = false): Promise<CycleResult> {
    const start = { ...c.rt, unknownStreak: keepStreak ? c.rt.unknownStreak : status === "unknown" ? c.rt.unknownStreak + 1 : 0 };
    c.rt = await this.runActions(c, start, c.rule.actions.onNotMatched, status, { allowRefresh: true });
    if (c.rt.status === "evaluating") {
      const nextDueAt = this.nextDue(c.rule, c.now);
      c.rt = transition(c.rt, "scheduled", { reason: nextDueAt === null ? waitingReason(c.rule) : undefined, nextDueAt });
    }
    return this.save(c.rt);
  }

  /* ---------------- actions ---------------- */

  /** Execute an action list. Returns the updated runtime (status may change). */
  protected async runActions(
    c: Pick<Cycle, "rule" | "tab" | "event">,
    start: TabRuntime,
    actions: ActionConfig[],
    condition: Outcome,
    opts: { allowRefresh: boolean },
  ): Promise<TabRuntime> {
    const run = { rt: start, ended: false };
    const config = await this.deps.stores.config.get();
    for (const action of actions) {
      const handler = this.registries.actions.get(action.type);
      // After a terminal action (stop/pause) later actions may still notify/log, but never reload.
      if (run.ended && handler?.disruptive) continue;
      const entry = { ruleId: c.rule.id, tabId: c.tab.id, url: c.tab.url, trigger: c.event, condition, action: action.type };
      if (!handler) {
        this.log({ ...entry, outcome: "error", reason: "Unknown action" });
        continue;
      }
      try {
        const result = await handler.execute(action, this.actionContext(c, run, config, condition, opts.allowRefresh));
        if (action.type !== "log") this.log({ ...entry, outcome: result.ok ? "ok" : "error", reason: result.message });
        if (result.terminal) run.ended = true;
      } catch (e) {
        run.rt = this.afterActionError(c.rule, run.rt, entry, e);
        break;
      }
    }
    return run.rt;
  }

  /** What an action may do: reload (through the safety gate), set the status, notify, log. */
  private actionContext(
    c: Pick<Cycle, "rule" | "tab" | "event">,
    run: { rt: TabRuntime },
    config: Config,
    condition: Outcome,
    allowRefresh: boolean,
  ): ActionContext {
    const { rule, tab } = c;
    return {
      tabId: tab.id,
      url: tab.url,
      ruleId: rule.id,
      ruleName: rule.name,
      condition,
      now: this.now(),
      reload: async ({ bypassCache, keepScroll }) => {
        if (!allowRefresh) throw new Error("Refresh is not allowed in this phase");
        // A click earlier in this list may have used the last of the limit: the next check ends the run.
        if (checkLimits(rule.limits, run.rt, this.now()).reached) return;
        run.rt = await this.performReload(rule, tab, run.rt, bypassCache, config, keepScroll === true);
      },
      // Like a refresh: not where it could loop, and not while you type or have unsaved changes.
      click: async (selector) => {
        if (!allowRefresh) throw new Error("Clicking is not allowed in this phase");
        const limit = checkLimits(rule.limits, run.rt, this.now());
        if (limit.reached) return { ok: false as const, error: `Not clicked: ${limit.reason}` };
        const { activity, reason } = await this.page.activity(tab.id);
        this.checkSafety(rule, tab, run.rt, activity, reason, this.now());
        const result = await this.page.click(tab.id, selector);
        if (result.ok) run.rt = { ...run.rt, clickCount: (run.rt.clickCount ?? 0) + 1, clickedAt: this.now() };
        // The rule's later actions (often "stop") still run: say so, rather than only in History.
        if (!result.ok && config.settings.notificationsEnabled) {
          await this.deps.browser.notify(`justrefresh:click:${tab.id}:${this.now()}`, `${rule.name}: couldn't click`, result.error);
        }
        return result;
      },
      // Only marks the page: allowed after a page load and after the rule stops.
      highlight: (target) => this.page.highlight(tab.id, target),
      webhook: (url, payload) => this.callWebhook(config, url, payload),
      setStatus: (status, reason, resumeAt) => {
        run.rt = transition(run.rt, status, {
          reason,
          resumeAt: resumeAt ?? null,
          nextDueAt: status === "scheduled" ? this.nextDue(rule, this.now()) : (resumeAt ?? null),
        });
      },
      notify: async (title, message, opts) => {
        if (!config.settings.notificationsEnabled) return;
        await this.deps.browser.notify(`justrefresh:${rule.id}:${tab.id}:${this.now()}`, title, message, opts);
      },
      log: (level, message) => {
        this.log({ ruleId: rule.id, tabId: tab.id, url: tab.url, trigger: c.event, condition, action: "log", outcome: "ok", reason: `${level}: ${message}` });
      },
    };
  }

  /** POST to a local webhook. Off unless the user switched webhooks on; a failure is reported, not fatal. */
  private async callWebhook(config: Config, url: string, payload: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!config.settings.allowWebhooks) return { ok: false, error: "Webhooks are switched off. Turn them on in Dashboard → Settings → Webhooks." };
    if (!isLocalWebhookUrl(url)) return { ok: false, error: "Webhooks can only call this computer (localhost)" };
    try {
      await this.deps.browser.post(url, JSON.stringify(payload));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `Could not reach ${url}: ${(e as Error).message}` };
    }
  }

  /** A blocked refresh moves to the state it asks for; any other failure is an error. */
  private afterActionError(rule: Rule, rt: TabRuntime, entry: Omit<HistoryEntry, "at" | "actor" | "outcome" | "reason">, e: unknown): TabRuntime {
    if (e instanceof SafetyBlock) {
      if (!e.quiet) this.log({ ...entry, outcome: "skipped", reason: e.reason });
      return transition(rt, e.status, { reason: e.reason, nextDueAt: e.retryAt });
    }
    const message = (e as Error).message;
    this.log({ ...entry, outcome: "error", reason: message });
    return transition(rt, "error", { lastError: message, reason: message, nextDueAt: this.nextDue(rule, this.now()) });
  }

  /* ---------------- the refresh ---------------- */

  /** Safety gate + throttled reload. Persists state BEFORE reloading. */
  protected async performReload(rule: Rule, tab: TabInfo, rt: TabRuntime, bypassCache: boolean, config: Config, keepScroll = false): Promise<TabRuntime> {
    const now = this.now();
    const { activity, reason } = await this.page.activity(tab.id);
    if (activity?.formResult) throw await this.formResultBlock(rule, tab, rt, config, now);
    this.checkSafety(rule, tab, rt, activity, reason, now);
    this.takeFastSlot(rule, tab, now);
    if (this.deps.throttle) await this.deps.throttle();
    if (keepScroll) await this.page.saveScroll(tab.id);
    return this.reloadNow(rule, tab, rt, bypassCache);
  }

  /**
   * Never reload a form result: Chrome would ask to resend it (and an
   * unattended tab gets stuck on that prompt). Applies whatever the protection
   * settings, and is announced once. No retry timer: nothing changes while
   * the tab stays on this page. It resumes when the tab loads another page or
   * is opened fresh; a time limit still ends the run on time.
   */
  private async formResultBlock(rule: Rule, tab: TabInfo, rt: TabRuntime, config: Config, now: number): Promise<SafetyBlock> {
    // The status has moved on to "evaluating" by now; the reason is kept.
    const already = rt.reason === FORM_RESULT_REASON;
    if (!already && config.settings.notificationsEnabled) {
      await this.deps.browser.notify(
        `justrefresh:form:${tab.id}:${now}`,
        `Refreshing paused: ${siteKey(tab.url) ?? "this page"}`,
        "This page came from submitting a form, so refreshing it could send the form again. It carries on by itself when you leave this page, or open the JustRefresh popup to open it fresh.",
      );
    }
    const deadline = limitDeadline(rule.limits, rt);
    return new SafetyBlock("paused_resubmit", FORM_RESULT_REASON, deadline === null ? null : Math.max(deadline, now + MIN_ALARM_DELAY_MS), already);
  }

  /** Typing, unsaved changes, or a page that can't be checked: postpone (throws). */
  private checkSafety(rule: Rule, tab: TabInfo, rt: TabRuntime, activity: ActivitySnapshot | null, reason: string | undefined, now: number) {
    const decision = decideSafety({
      safety: rule.safety,
      activity,
      unavailableReason: reason,
      ignoreUnsaved: rt.ignoreUnsavedOnce === true,
      fallbackRetryMs: this.intervalMs(rule),
    });
    if (decision.allowed) return;
    this.fast.leave(tab.id); // paused for you: others on the site needn't wait for it
    throw new SafetyBlock(decision.status, decision.reason, now + Math.max(decision.retryInMs, MIN_ALARM_DELAY_MS));
  }

  /** Fast intervals take turns per site (throws when it isn't this tab's turn). */
  private takeFastSlot(rule: Rule, tab: TabInfo, now: number) {
    const intervalMs = this.nextDue(rule, 0);
    const host = siteKey(tab.url);
    if (intervalMs === null || intervalMs >= MIN_INTERVAL_SECONDS * 1000 || host === null) return;
    const retryAt = this.fast.take(host, tab.id, now);
    if (retryAt !== null) throw new SafetyBlock("scheduled", FAST_WAIT_REASON, retryAt, true);
  }

  private async reloadNow(rule: Rule, tab: TabInfo, rt: TabRuntime, bypassCache: boolean): Promise<TabRuntime> {
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
        console.warn(`JustRefresh: ${e.message} (tab ${tab.id}); tracking it as pending`);
        return next;
      }
      await this.deps.stores.runtime.put({ ...next, pendingReload: null, refreshCount: rt.refreshCount });
      throw e;
    }
    return next;
  }
}
