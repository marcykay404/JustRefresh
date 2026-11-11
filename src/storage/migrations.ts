/**
 * Versioned configuration migrations. Each step upgrades exactly one version.
 * Migrations must be pure and idempotent with respect to their input version.
 */
import { DEFAULT_SETTINGS, defaultConfig } from "../core/defaults";
import type { Config } from "../core/types";
import { CONFIG_SCHEMA_VERSION } from "../core/types";

type Migration = (input: Record<string, any>) => Record<string, any>;

/** migrations[n] upgrades version n → n+1. */
export const migrations: Record<number, Migration> = {
  // v0: pre-release format { settings, rules: Rule[] } without versioning.
  0: (old) => {
    const base = defaultConfig();
    const rules: Record<string, unknown> = {};
    for (const r of Array.isArray(old.rules) ? old.rules : Object.values(old.rules ?? {})) {
      if (r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string") rules[(r as { id: string }).id] = r;
    }
    return {
      ...base,
      settings: { ...base.settings, ...(old.settings ?? {}) },
      rules,
      exclusions: Array.isArray(old.exclusions) ? old.exclusions : [],
      schemaVersion: 1,
    };
  },
};

export class MigrationError extends Error {}

export function migrateConfig(input: unknown): { config: Config; migrated: boolean } {
  if (!input || typeof input !== "object") return { config: defaultConfig(), migrated: true };
  let cur = input as Record<string, any>;
  let version = typeof cur.schemaVersion === "number" ? cur.schemaVersion : 0;
  if (version > CONFIG_SCHEMA_VERSION) {
    throw new MigrationError(`Configuration version ${version} is newer than supported (${CONFIG_SCHEMA_VERSION})`);
  }
  const migrated = version !== CONFIG_SCHEMA_VERSION;
  while (version < CONFIG_SCHEMA_VERSION) {
    const step = migrations[version];
    if (!step) throw new MigrationError(`No migration from version ${version}`);
    cur = step(cur);
    version = cur.schemaVersion;
  }
  // Fill fields added within the current version.
  const base = defaultConfig();
  const config: Config = {
    ...base,
    ...cur,
    settings: { ...DEFAULT_SETTINGS, ...(cur.settings ?? {}), defaultSafety: { ...DEFAULT_SETTINGS.defaultSafety, ...(cur.settings?.defaultSafety ?? {}) } },
  } as Config;
  return { config, migrated };
}
