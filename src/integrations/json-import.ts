/**
 * JSON import/export (Agent integration Level 1).
 *
 * Accepted import shapes:
 *  - an export bundle: { format: "smart-auto-refresh", version, rules, exclusions?, settings? }
 *  - a single rule object
 *  - an array of rule objects
 */
import { z } from "zod";
import type { Registries } from "../registries";
import { validateRule } from "../core/rule-schema";
import { urlPatternSchema } from "../core/pattern-schema";
import { validatePattern } from "../core/url-pattern";
import type { Config, Diagnostic, Exclusion, Rule, SafetyConfig, Settings } from "../core/types";
import { CONFIG_SCHEMA_VERSION } from "../core/types";

export const BUNDLE_FORMAT = "smart-auto-refresh";

export interface ExportBundle {
  format: typeof BUNDLE_FORMAT;
  version: number;
  exportedAt: string;
  rules: Omit<Rule, "meta">[];
  exclusions: Omit<Exclusion, "id" | "createdAt">[];
  settings?: Partial<Settings>;
}

export interface ImportReport {
  imported: string[];
  skipped: { id: string; reason: string }[];
  errors: { index: number; name?: string; diagnostics: Diagnostic[] }[];
  warnings: string[];
}

export function exportBundle(config: Config, opts: { includeSettings: boolean; ruleIds?: string[]; now: number }): ExportBundle {
  const rules = Object.values(config.rules)
    .filter((r) => !opts.ruleIds || opts.ruleIds.includes(r.id))
    .map(({ meta: _meta, ...rest }) => rest);
  // Integration access is never exported (nor importable: see SETTINGS_KEYS).
  const { nativeBridgeEnabled: _n, allowedExtensionIds: _a, ...settings } = config.settings;
  return {
    format: BUNDLE_FORMAT,
    version: CONFIG_SCHEMA_VERSION,
    exportedAt: new Date(opts.now).toISOString(),
    rules,
    exclusions: opts.ruleIds ? [] : config.exclusions.map(({ pattern, reason }) => ({ pattern, ...(reason ? { reason } : {}) })),
    ...(opts.includeSettings && !opts.ruleIds ? { settings } : {}),
  };
}

const bundleSchema = z.looseObject({
  format: z.literal(BUNDLE_FORMAT),
  version: z.number().int(),
  rules: z.array(z.unknown()).max(1000),
  exclusions: z.array(z.strictObject({ pattern: urlPatternSchema, reason: z.string().max(200).optional() })).max(1000).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

const SETTINGS_KEYS: (keyof Settings)[] = [
  "enabled",
  "paused",
  "defaultIntervalSeconds",
  "defaultSafety",
  "historyLimit",
  "historyRetentionDays",
  "notificationsEnabled",
  "skipDiscardedTabs",
  "redactUrlsForAgents",
];

export function parseImport(
  json: string,
  opts: { registries: Registries; defaultSafety: SafetyConfig; now: number; allowFastIntervals?: boolean },
): { fatal: boolean; rules: Rule[]; exclusions: Omit<Exclusion, "id" | "createdAt">[]; settings?: Partial<Settings>; errors: ImportReport["errors"]; warnings: string[] } {
  const errors: ImportReport["errors"] = [];
  const warnings: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return { fatal: true, rules: [], exclusions: [], errors: [{ index: -1, diagnostics: [{ path: "$", code: "json_invalid", message: `Not valid JSON: ${(e as Error).message}`, severity: "error" }] }], warnings };
  }

  let rawRules: unknown[];
  let exclusions: Omit<Exclusion, "id" | "createdAt">[] = [];
  let settings: Partial<Settings> | undefined;
  if (Array.isArray(data)) rawRules = data;
  else if (data && typeof data === "object" && (data as { format?: unknown }).format === BUNDLE_FORMAT) {
    const b = bundleSchema.safeParse(data);
    if (!b.success) {
      return { fatal: true, rules: [], exclusions: [], errors: [{ index: -1, diagnostics: b.error.issues.map((i) => ({ path: i.path.join("."), code: i.code, message: i.message, severity: "error" as const })) }], warnings };
    }
    if (b.data.version > CONFIG_SCHEMA_VERSION) warnings.push(`Bundle version ${b.data.version} is newer than supported; importing compatible parts`);
    rawRules = b.data.rules;
    exclusions = (b.data.exclusions ?? []).filter((e) => {
      const p = validatePattern(e.pattern);
      if (p) warnings.push(`Skipped exclusion: ${p}`);
      return !p;
    });
    if (b.data.settings) {
      settings = {};
      for (const k of SETTINGS_KEYS) if (k in b.data.settings) (settings as Record<string, unknown>)[k] = b.data.settings[k];
    }
  } else if (data && typeof data === "object") rawRules = [data];
  else return { fatal: true, rules: [], exclusions: [], errors: [{ index: -1, diagnostics: [{ path: "$", code: "shape_invalid", message: "Expected a rule, an array of rules, or an export bundle", severity: "error" }] }], warnings };

  const rules: Rule[] = [];
  const seen = new Set<string>();
  rawRules.forEach((raw, index) => {
    const v = validateRule(raw, { registries: opts.registries, defaultSafety: opts.defaultSafety, now: opts.now, allowFastIntervals: opts.allowFastIntervals });
    if (!v.valid) {
      errors.push({ index, name: (raw as { name?: string })?.name, diagnostics: v.diagnostics });
      return;
    }
    const rule = v.normalized!;
    if (rule.id && seen.has(rule.id)) {
      warnings.push(`Duplicate id "${rule.id}" within the import; a new id will be assigned`);
      rule.id = "";
    }
    if (rule.id) seen.add(rule.id);
    rules.push(rule);
  });
  return { fatal: false, rules, exclusions, settings, errors, warnings };
}
