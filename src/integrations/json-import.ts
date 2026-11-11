/**
 * JSON import/export (Agent integration Level 1).
 *
 * Accepted import shapes:
 *  - an export bundle: { format: "justrefresh", version, rules, exclusions?, settings? }
 *  - a single rule object
 *  - an array of rule objects
 */
import { z } from "../core/zod";
import type { Registries } from "../registries";
import { validateRule } from "../core/rule-schema";
import { urlPatternSchema } from "../core/pattern-schema";
import { validatePattern } from "../core/url-pattern";
import type { Config, Diagnostic, Exclusion, Rule, SafetyConfig, Settings } from "../core/types";
import { CONFIG_SCHEMA_VERSION } from "../core/types";

export const BUNDLE_FORMAT = "justrefresh";
/** Exports made before the rename to JustRefresh carry this tag; they still import. */
const LEGACY_BUNDLE_FORMAT = "smart-auto-refresh";
const BUNDLE_FORMATS = [BUNDLE_FORMAT, LEGACY_BUNDLE_FORMAT] as const;

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
  format: z.literal(BUNDLE_FORMATS),
  version: z.int(),
  rules: z.array(z.unknown()).check(z.maxLength(1000)),
  exclusions: z.optional(
    z.array(z.strictObject({ pattern: urlPatternSchema, reason: z.optional(z.string().check(z.maxLength(200))) })).check(z.maxLength(1000)),
  ),
  settings: z.optional(z.record(z.string(), z.unknown())),
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

type ExclusionInput = Omit<Exclusion, "id" | "createdAt">;
type ParsedImport = {
  fatal: boolean;
  rules: Rule[];
  exclusions: ExclusionInput[];
  settings?: Partial<Settings>;
  errors: ImportReport["errors"];
  warnings: string[];
};
type ImportOptions = { registries: Registries; defaultSafety: SafetyConfig; now: number; allowFastIntervals?: boolean };
/** What an import holds before its rules are validated. */
interface ImportSource {
  rawRules: unknown[];
  exclusions: ExclusionInput[];
  settings?: Partial<Settings>;
}

const fatalImport = (diagnostics: Diagnostic[], warnings: string[]): ParsedImport => ({
  fatal: true,
  rules: [],
  exclusions: [],
  errors: [{ index: -1, diagnostics }],
  warnings,
});
const importError = (path: string, code: string, message: string): Diagnostic => ({ path, code, message, severity: "error" });

/** Only the importable settings (never integration access). */
function pickSettings(raw: Record<string, unknown> | undefined): Partial<Settings> | undefined {
  if (!raw) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of SETTINGS_KEYS) if (k in raw) out[k] = raw[k];
  return out as Partial<Settings>;
}

function readBundle(data: unknown, warnings: string[]): ImportSource | Diagnostic[] {
  const b = bundleSchema.safeParse(data);
  if (!b.success) return b.error.issues.map((i) => importError(i.path.join("."), i.code, i.message));
  if (b.data.version > CONFIG_SCHEMA_VERSION) warnings.push(`Bundle version ${b.data.version} is newer than supported; importing compatible parts`);
  const exclusions = (b.data.exclusions ?? []).filter((e) => {
    const p = validatePattern(e.pattern);
    if (p) warnings.push(`Skipped exclusion: ${p}`);
    return !p;
  });
  return { rawRules: b.data.rules, exclusions, settings: pickSettings(b.data.settings) };
}

/** A bundle, an array of rules, or one rule; diagnostics when it is none of these. */
function readSource(data: unknown, warnings: string[]): ImportSource | Diagnostic[] {
  if (Array.isArray(data)) return { rawRules: data, exclusions: [] };
  if (!data || typeof data !== "object") return [importError("$", "shape_invalid", "Expected a rule, an array of rules, or an export bundle")];
  if ((BUNDLE_FORMATS as readonly unknown[]).includes((data as { format?: unknown }).format)) return readBundle(data, warnings);
  return { rawRules: [data], exclusions: [] };
}

/** Validate each rule; a repeated id is cleared so the rule gets a new one. */
function validateRules(rawRules: unknown[], opts: ImportOptions, errors: ImportReport["errors"], warnings: string[]): Rule[] {
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
  return rules;
}

export function parseImport(json: string, opts: ImportOptions): ParsedImport {
  const errors: ImportReport["errors"] = [];
  const warnings: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return fatalImport([importError("$", "json_invalid", `Not valid JSON: ${(e as Error).message}`)], warnings);
  }
  const source = readSource(data, warnings);
  if (Array.isArray(source)) return fatalImport(source, warnings);
  const rules = validateRules(source.rawRules, opts, errors, warnings);
  return { fatal: false, rules, exclusions: source.exclusions, settings: source.settings, errors, warnings };
}
