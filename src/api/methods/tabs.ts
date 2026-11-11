/** Tabs: what runs where, per-tab timers and protection, refresh controls, pause/resume all. */
import { detectRuleConflicts, resolveTab, type Resolution } from "../../core/rule-resolver";
import type { TabInfo, TabRuntime } from "../../core/types";
import { z } from "../../core/zod";
import { FAST_MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS } from "../../triggers/interval";
import { ApiError } from "../permissions";
import { m, none, tabId, tabSafety, type MethodDef } from "../method";
import type { ServiceInternals } from "../rule-api";

export function tabsMethods(svc: ServiceInternals): Record<string, MethodDef> {
  const d = svc.deps;
  return {
    listTabs: m({
      scope: "tabs:read",
      params: none,
      handler: async (actor) => svc.tabsFor(actor),
    }),
    getOverview: m({
      scope: null,
      params: none,
      handler: async () => {
        const config = await d.config.get();
        const tabs = await d.browser.listTabs();
        const runtimes = new Map((await d.runtime.getAll()).map((r) => [r.tabId, r]));
        const rows = tabs.map((tab) => overviewRow(tab, resolveTab(tab, config), runtimes.get(tab.id) ?? null));
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
    getTabState: m({ scope: null, params: tabId, handler: async (_a, p) => svc.tabState(p.tabId) }),
    startTab: m({
      scope: null,
      params: z.strictObject({
        tabId: z.int().check(z.nonnegative()),
        intervalSeconds: z.optional(z.int().check(z.gte(FAST_MIN_INTERVAL_SECONDS), z.lte(MAX_INTERVAL_SECONDS))),
        safety: z.optional(tabSafety),
      }),
      handler: async (_a, p) => {
        const config = await d.config.get();
        if (p.intervalSeconds !== undefined && p.intervalSeconds < MIN_INTERVAL_SECONDS && !config.settings.allowFastIntervals) {
          throw new ApiError(
            "invalid_params",
            `Intervals under ${MIN_INTERVAL_SECONDS} seconds are disabled. Enable them in Settings → Advanced (minimum ${FAST_MIN_INTERVAL_SECONDS} s).`,
          );
        }
        await svc.updateOverride(p.tabId, (o, tab) => {
          const prev = o?.mode === "custom" ? o : undefined;
          const safety = p.safety || prev?.safety ? { ...(prev?.safety ?? {}), ...(p.safety ?? {}) } : undefined;
          return svc.newOverride(tab, {
            ...(prev ?? {}),
            mode: "custom",
            intervalSeconds: p.intervalSeconds ?? prev?.intervalSeconds ?? config.settings.defaultIntervalSeconds,
            ...(safety ? { safety } : {}),
            stopped: false,
            paused: false,
          });
        });
        await d.engine.setTabStatus(p.tabId, "scheduled", "Started by user");
        return svc.tabState(p.tabId);
      },
    }),
    setTabSafety: m({
      scope: null,
      params: z.strictObject({
        tabId: z.int().check(z.nonnegative()),
        safety: tabSafety,
      }),
      handler: async (_a, p) => {
        await svc.updateOverride(p.tabId, (o, tab) =>
          o?.mode === "custom"
            ? { ...o, safety: { ...(o.safety ?? {}), ...p.safety } }
            : svc.newOverride(tab, { mode: "custom", safety: p.safety, stopped: true }),
        );
        return svc.tabState(p.tabId);
      },
    }),
    stopTab: m({
      scope: null,
      params: tabId,
      handler: async (_a, p) => {
        const o = (await d.config.get()).tabOverrides[String(p.tabId)];
        if (o?.mode === "custom") await svc.updateOverride(p.tabId, (cur) => cur && { ...cur, stopped: true, paused: false });
        await d.engine.setTabStatus(p.tabId, "stopped", "Stopped by user");
        return svc.tabState(p.tabId);
      },
    }),
    clearTabOverride: m({
      scope: null,
      params: tabId,
      handler: async (_a, p) => {
        await svc.updateOverride(p.tabId, () => undefined);
        return svc.tabState(p.tabId);
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
        return svc.tabState(p.tabId);
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
        return svc.tabState(p.tabId);
      },
    }),
    excludeTab: m({
      scope: null,
      params: tabId,
      handler: async (_a, p) => {
        // Keep the tab's own settings so "include" can restore them.
        await svc.updateOverride(p.tabId, (o, tab) => {
          const previous = o?.mode === "custom" ? o : o?.previous;
          return svc.newOverride(tab, { mode: "excluded", ...(previous ? { previous } : {}) });
        });
        return svc.tabState(p.tabId);
      },
    }),
    includeTab: m({
      scope: null,
      params: tabId,
      handler: async (_a, p) => {
        await svc.updateOverride(p.tabId, (o) => (o?.mode === "excluded" ? o.previous : o));
        return svc.tabState(p.tabId);
      },
    }),
    allowUnsavedOnce: m({
      scope: null,
      params: tabId,
      handler: async (_a, p) => d.engine.allowUnsavedOnce(p.tabId),
    }),
    refreshNow: m({
      scope: null,
      params: z.strictObject({ tabId: z.int().check(z.nonnegative()), force: z.optional(z.boolean()) }),
      handler: async (actor, p) => d.engine.refreshNow(p.tabId, { force: p.force, actor }),
    }),
    openFresh: m({
      scope: null,
      params: tabId,
      handler: async (actor, p) => d.engine.openFresh(p.tabId, { actor }),
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
      params: z.optional(z.strictObject({ force: z.optional(z.boolean()) })),
      handler: async (_a, p) => d.engine.refreshAll({ force: p?.force }),
    }),
  };
}

/** One row of the Tabs overview: the tab, its run, and what controls it. */
function overviewRow(tab: TabInfo, res: Resolution, rt: TabRuntime | null) {
  const controller = res.kind === "controller" ? res.controller : null;
  const resting = res.kind === "restricted" || res.kind.endsWith("excluded") ? "excluded" : "idle";
  return {
    tab,
    runtime: rt,
    status: rt?.status ?? resting,
    reason: rt?.reason ?? ("reason" in res ? res.reason : undefined),
    controllerId: controller?.id ?? rt?.controllerId ?? null,
    controllerName: controller?.name ?? null,
  };
}
