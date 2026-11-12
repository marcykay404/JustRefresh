/** Settings, exclusions, history, import/export and reset. */
import { defaultConfig } from "../../core/defaults";
import { urlPatternSchema } from "../../core/pattern-schema";
import type { Config, Exclusion, Rule, Settings } from "../../core/types";
import { patternToString, validatePattern } from "../../core/url-pattern";
import { z } from "../../core/zod";
import { exportBundle, parseImport, type ImportReport } from "../../integrations/json-import";
import { MAX_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS } from "../../triggers/interval";
import { ApiError, redactUrl } from "../permissions";
import { m, none, ruleId, type MethodDef } from "../method";
import type { ServiceInternals } from "../rule-api";

export function settingsMethods(svc: ServiceInternals): Record<string, MethodDef> {
  const d = svc.deps;
  return {
    getHistory: m({
      scope: "status:read",
      params: z.optional(z.strictObject({ limit: z.optional(z.int().check(z.gte(1), z.lte(500))), ruleId: z.optional(z.string()) })),
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

    updateSettings: m({
      scope: null,
      params: z.strictObject({
        enabled: z.optional(z.boolean()),
        paused: z.optional(z.boolean()),
        defaultIntervalSeconds: z.optional(z.int().check(z.gte(MIN_INTERVAL_SECONDS), z.lte(MAX_INTERVAL_SECONDS))),
        defaultSafety: z.optional(
          z.strictObject({
            pauseWhileTyping: z.optional(z.boolean()),
            protectUnsavedChanges: z.optional(z.boolean()),
            inactivityGraceSeconds: z.optional(z.int().check(z.gte(0), z.lte(86400))),
            pauseOnMouse: z.optional(z.boolean()),
            pauseOnScroll: z.optional(z.boolean()),
            onUnknown: z.optional(z.enum(["pause", "skip", "refresh", "stop"])),
            maxUnknownRetries: z.optional(z.int().check(z.gte(0), z.lte(100))),
            onActivityUnavailable: z.optional(z.enum(["pause", "refresh"])),
          }),
        ),
        historyLimit: z.optional(z.int().check(z.gte(10), z.lte(5000))),
        historyRetentionDays: z.optional(z.int().check(z.gte(1), z.lte(365))),
        notificationsEnabled: z.optional(z.boolean()),
        skipDiscardedTabs: z.optional(z.boolean()),
        redactUrlsForAgents: z.optional(z.boolean()),
        nativeBridgeEnabled: z.optional(z.boolean()),
        allowFastIntervals: z.optional(z.boolean()),
        allowWebhooks: z.optional(z.boolean()),
        agentEventsFile: z.optional(z.boolean()),
        defaultStopAfterMinutes: z.optional(z.nullable(z.int().check(z.gte(1), z.lte(10_080)))),
        allowedExtensionIds: z.optional(z.array(z.string().check(z.regex(/^[a-p]{32}$/, "Chrome extension IDs are 32 letters a–p"))).check(z.maxLength(50))),
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
    addExclusion: m({
      scope: null,
      params: z.strictObject({ pattern: urlPatternSchema, reason: z.optional(z.string().check(z.maxLength(200))) }),
      mutates: true,
      handler: async (_a, p) => {
        const problem = validatePattern(p.pattern);
        if (problem) throw new ApiError("validation_failed", problem, [{ path: "pattern", code: "pattern_invalid", message: problem, severity: "error" }]);
        const ex: Exclusion = { id: svc.newId("excl"), pattern: p.pattern, ...(p.reason ? { reason: p.reason } : {}), createdAt: d.clock.now() };
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
      params: z.optional(z.strictObject({ includeSettings: z.optional(z.boolean()), ruleIds: z.optional(z.array(z.string())) })),
      handler: async (_a, p) => exportBundle(await d.config.get(), { includeSettings: p?.includeSettings ?? true, ruleIds: p?.ruleIds, now: d.clock.now() }),
    }),
    importConfig: m({
      scope: null,
      params: z.strictObject({
        json: z.string().check(z.maxLength(5_000_000)),
        onDuplicate: z.optional(z.enum(["rename", "replace", "skip"])),
        activate: z.optional(z.boolean()),
        includeSettings: z.optional(z.boolean()),
      }),
      mutates: true,
      handler: async (_a, p) => {
        const config = await d.config.get();
        const parsed = parseImport(p.json, {
          registries: svc.registries,
          defaultSafety: config.settings.defaultSafety,
          now: d.clock.now(),
          allowFastIntervals: config.settings.allowFastIntervals,
        });
        const report: ImportReport = { imported: [], skipped: [], errors: parsed.errors, warnings: parsed.warnings };
        if (parsed.fatal) return report;
        await d.config.update((c) => {
          importRules(c, parsed.rules, { onDuplicate: p.onDuplicate ?? "rename", activate: p.activate === true, now: d.clock.now(), newId: svc.newId }, report);
          for (const ex of parsed.exclusions) {
            if (!c.exclusions.some((e) => patternToString(e.pattern) === patternToString(ex.pattern))) {
              c.exclusions.push({ ...ex, id: svc.newId("excl"), createdAt: d.clock.now() });
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
      // Everything: rules, settings, exclusions and agents (with no backup of them left behind),
      // every tab's run, the history, the agent activity log and agents' events. Cleared in that
      // order: forgetting the tabs waits for checks already running, which may still add history.
      // Exported files, and agents' events files on disk, are the user's own.
      handler: async () => {
        await d.config.replace(defaultConfig(), { discardBackup: true });
        await d.engine.forgetAllTabs();
        await Promise.all([d.history.clear(), d.audit.clear(), d.events?.clear()]);
        return { reset: true };
      },
    }),
    clearHistory: m({ scope: null, params: none, handler: async () => d.history.clear().then(() => ({ cleared: true })) }),
  };
}

/** Add imported rules to the config: switched off unless `activate`, with duplicate ids renamed, replaced or skipped. */
function importRules(
  c: Config,
  rules: Omit<Rule, "meta">[],
  o: { onDuplicate: "rename" | "replace" | "skip"; activate: boolean; now: number; newId: (prefix: string) => string },
  report: ImportReport,
) {
  for (const rule of rules) {
    let id = rule.id || o.newId("rule");
    if (c.rules[id] && o.onDuplicate === "skip") {
      report.skipped.push({ id, reason: "Duplicate id" });
      continue;
    }
    if (c.rules[id] && o.onDuplicate === "rename") id = o.newId(id.slice(0, 50));
    const existing = c.rules[id];
    c.rules[id] = {
      ...rule,
      id,
      enabled: o.activate ? rule.enabled : false,
      meta: {
        createdAt: existing?.meta.createdAt ?? o.now,
        updatedAt: o.now,
        revision: (existing?.meta.revision ?? 0) + 1,
        origin: { type: "import" },
        draft: !o.activate,
      },
    };
    report.imported.push(id);
  }
}
