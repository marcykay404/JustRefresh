/**
 * Persistence layer.
 *
 *  - Config (rules, settings, exclusions, overrides, agents) → storage.local
 *    under ONE key, so every write is atomic. The previous version is kept as
 *    a backup and used if the primary copy fails validation on load.
 *  - Runtime execution state → storage.session (survives service-worker
 *    termination, cleared on browser restart because tab ids are not stable).
 *  - History & audit → storage.local, bounded ring buffers.
 */
import { defaultConfig } from "../core/defaults";
import { validateRule } from "../core/rule-schema";
import type { AuditEntry, Config, HistoryEntry, Rule, TabRuntime } from "../core/types";
import type { KeyValueStore } from "./kv";
import { migrateConfig } from "./migrations";

export const CONFIG_KEY = "config";
export const CONFIG_BACKUP_KEY = "config.backup";
export const HISTORY_KEY = "history";
export const AUDIT_KEY = "audit";
export const RUNTIME_PREFIX = "rt:";

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export type ConfigListener = (config: Config) => void;

/** Drop rules that no longer validate rather than failing the whole load. */
function sanitize(config: Config): { config: Config; dropped: string[] } {
  const dropped: string[] = [];
  const rules: Record<string, Rule> = {};
  for (const [id, rule] of Object.entries(config.rules ?? {})) {
    const v = validateRule(rule);
    if (v.valid && rule && typeof rule === "object" && (rule as Rule).meta) rules[id] = rule as Rule;
    else dropped.push(id);
  }
  return { config: { ...config, rules }, dropped };
}

export class ConfigRepository {
  private cache: Config | null = null;
  private mutex = new Mutex();
  private listeners = new Set<ConfigListener>();
  public loadWarnings: string[] = [];

  constructor(private readonly kv: KeyValueStore) {}

  onChange(fn: ConfigListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  invalidate() {
    this.cache = null;
  }

  async get(): Promise<Config> {
    if (this.cache) return this.cache;
    return this.mutex.run(async () => {
      if (this.cache) return this.cache;
      this.cache = await this.load();
      return this.cache;
    });
  }

  private async load(): Promise<Config> {
    const stored = await this.kv.get([CONFIG_KEY, CONFIG_BACKUP_KEY]);
    for (const key of [CONFIG_KEY, CONFIG_BACKUP_KEY]) {
      const raw = stored[key];
      if (raw === undefined) continue;
      try {
        const { config, migrated } = migrateConfig(raw);
        const { config: clean, dropped } = sanitize(config);
        if (dropped.length) this.loadWarnings.push(`Dropped invalid rules: ${dropped.join(", ")}`);
        if (key === CONFIG_BACKUP_KEY) this.loadWarnings.push("Primary configuration was unreadable; restored from backup");
        if (migrated || dropped.length || key === CONFIG_BACKUP_KEY) await this.kv.set({ [CONFIG_KEY]: clean });
        return clean;
      } catch (e) {
        this.loadWarnings.push(`Failed to load ${key}: ${(e as Error).message}`);
      }
    }
    const fresh = defaultConfig();
    await this.kv.set({ [CONFIG_KEY]: fresh });
    return fresh;
  }

  /** Serialized read-modify-write. `fn` may mutate the draft or return a new config. */
  async update(fn: (draft: Config) => Config | void | Promise<Config | void>): Promise<Config> {
    const result = await this.mutex.run(async () => {
      const current = this.cache ?? (await this.load());
      const draft = structuredClone(current);
      const next = ((await fn(draft)) ?? draft) as Config;
      await this.kv.set({ [CONFIG_KEY]: next, [CONFIG_BACKUP_KEY]: current });
      this.cache = next;
      return next;
    });
    for (const l of this.listeners) l(result);
    return result;
  }

  async replace(config: Config): Promise<Config> {
    return this.update(() => config);
  }
}

export class RuntimeRepository {
  constructor(private readonly kv: KeyValueStore) {}

  async get(tabId: number): Promise<TabRuntime | null> {
    const key = RUNTIME_PREFIX + tabId;
    const v = await this.kv.get(key);
    return (v[key] as TabRuntime) ?? null;
  }

  async getAll(): Promise<TabRuntime[]> {
    const all = await this.kv.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith(RUNTIME_PREFIX))
      .map(([, v]) => v as TabRuntime);
  }

  async put(rt: TabRuntime): Promise<void> {
    await this.kv.set({ [RUNTIME_PREFIX + rt.tabId]: rt });
  }

  async delete(tabId: number): Promise<void> {
    await this.kv.remove(RUNTIME_PREFIX + tabId);
  }
}

class BoundedLog<T extends { at: number }> {
  private mutex = new Mutex();
  private pending: T[] = [];
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly kv: KeyValueStore,
    private readonly key: string,
    private readonly limit: () => Promise<{ max: number; retentionMs: number }>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Appends are batched to reduce storage writes. */
  append(entry: T): Promise<void> {
    this.pending.push(entry);
    this.flushing ??= this.mutex.run(async () => {
      await Promise.resolve();
      const batch = this.pending.splice(0);
      this.flushing = null;
      const { max, retentionMs } = await this.limit();
      const cur = ((await this.kv.get(this.key))[this.key] as T[]) ?? [];
      const cutoff = this.now() - retentionMs;
      const next = [...cur, ...batch].filter((e) => e.at >= cutoff).slice(-max);
      await this.kv.set({ [this.key]: next });
    });
    return this.flushing;
  }

  /** Reads go through the mutex so they observe every queued append. */
  async list(): Promise<T[]> {
    await this.flushing;
    return this.mutex.run(async () => ((await this.kv.get(this.key))[this.key] as T[]) ?? []);
  }

  async clear(): Promise<void> {
    await this.mutex.run(() => this.kv.set({ [this.key]: [] }));
  }
}

export class HistoryRepository extends BoundedLog<HistoryEntry> {
  constructor(kv: KeyValueStore, config: ConfigRepository, now: () => number = Date.now) {
    super(
      kv,
      HISTORY_KEY,
      async () => {
        const s = (await config.get()).settings;
        return { max: s.historyLimit, retentionMs: s.historyRetentionDays * 24 * 3600_000 };
      },
      now,
    );
  }
}

export class AuditRepository extends BoundedLog<AuditEntry> {
  constructor(kv: KeyValueStore, now: () => number = Date.now) {
    super(kv, AUDIT_KEY, async () => ({ max: 1000, retentionMs: 90 * 24 * 3600_000 }), now);
  }
}
