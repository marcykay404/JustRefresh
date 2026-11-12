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
import type { AgentEvent, AuditEntry, Config, HistoryEntry, Rule, TabRuntime } from "../core/types";
import type { KeyValueStore } from "./kv";
import { migrateConfig } from "./migrations";

import { AGENT_EVENTS_KEY, AUDIT_KEY, CONFIG_BACKUP_KEY, CONFIG_KEY, HISTORY_KEY, RUNTIME_PREFIX } from "./keys";
export { AGENT_EVENTS_KEY, AUDIT_KEY, CONFIG_BACKUP_KEY, CONFIG_KEY, HISTORY_KEY, RUNTIME_PREFIX };

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

/** Every agent's events, with the next number to hand out and, per agent, the last one trimmed away. */
export interface AgentEventState {
  seq: number;
  events: AgentEvent[];
  dropped: Record<string, number>;
}

/** Kept for each agent: its latest events, for at most a week. */
export const AGENT_EVENTS_PER_AGENT = 100;
export const AGENT_EVENTS_RETENTION_MS = 7 * 24 * 3600_000;

/**
 * Events for agents, in storage.local under one key (they must outlive the
 * worker and the agent's session). Writes are serialized; each append numbers
 * its events and trims every agent to its limit.
 */
export class AgentEventRepository {
  private mutex = new Mutex();
  private cache: AgentEventState | null = null;

  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  read(): Promise<AgentEventState> {
    return this.mutex.run(() => this.load());
  }

  private async load(): Promise<AgentEventState> {
    if (this.cache) return this.cache;
    const raw = (await this.kv.get(AGENT_EVENTS_KEY))[AGENT_EVENTS_KEY] as AgentEventState | undefined;
    this.cache = raw && Array.isArray(raw.events) ? raw : { seq: 0, events: [], dropped: {} };
    return this.cache;
  }

  /** `pick` sees the stored events and returns the ones to add (it may drop repeats). Returns what was added. */
  append(pick: (state: AgentEventState) => Omit<AgentEvent, "seq">[] | Promise<Omit<AgentEvent, "seq">[]>): Promise<AgentEvent[]> {
    return this.mutex.run(async () => {
      const cur = await this.load();
      const fresh = await pick(cur);
      if (!fresh.length) return [];
      let seq = cur.seq;
      const added = fresh.map((e) => ({ ...e, seq: ++seq }) as AgentEvent);
      const next = trim({ seq, events: [...cur.events, ...added], dropped: { ...cur.dropped } }, this.now());
      await this.kv.set({ [AGENT_EVENTS_KEY]: next });
      this.cache = next;
      return added;
    });
  }

  /** An agent removed by the user: its events go too. */
  forget(agentId: string): Promise<void> {
    return this.mutex.run(async () => {
      const cur = await this.load();
      const { [agentId]: _gone, ...dropped } = cur.dropped;
      const next = { seq: cur.seq, events: cur.events.filter((e) => e.agentId !== agentId), dropped };
      await this.kv.set({ [AGENT_EVENTS_KEY]: next });
      this.cache = next;
    });
  }
}

function trim(state: AgentEventState, now: number): AgentEventState {
  const cutoff = now - AGENT_EVENTS_RETENTION_MS;
  const count = new Map<string, number>();
  const kept: AgentEvent[] = [];
  // Newest first, so each agent keeps its latest ones.
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i];
    const n = count.get(e.agentId) ?? 0;
    if (e.at >= cutoff && n < AGENT_EVENTS_PER_AGENT) {
      count.set(e.agentId, n + 1);
      kept.push(e);
    } else state.dropped[e.agentId] = Math.max(state.dropped[e.agentId] ?? 0, e.seq);
  }
  return { ...state, events: kept.reverse() };
}
