/**
 * The engine's view of the outside world: browser, alarms, page (content
 * script), clock and storage, as ports so it can run without Chrome in tests.
 */
import type { Registries } from "../../registries";
import type { NotifyOptions } from "../../registries/contracts";
import type { ActivitySnapshot } from "../../shared/messaging-types";
import type { Config, ConditionNode, EvaluationResult, EvaluationTrace, ExecutionStatus, HistoryEntry, TabInfo, TabRuntime } from "../types";

/* ------------------------------------------------------------------ */
/* Ports                                                               */
/* ------------------------------------------------------------------ */

export interface BrowserPort {
  getTab(tabId: number): Promise<TabInfo | null>;
  listTabs(): Promise<TabInfo[]>;
  reload(tabId: number, bypassCache: boolean): Promise<void>;
  /** Load `url` in the tab as a normal visit (GET): never resends a form. */
  navigate(tabId: number, url: string): Promise<void>;
  notify(id: string, title: string, message: string, opts?: NotifyOptions): Promise<void>;
}

export interface AlarmPort {
  set(name: string, when: number): Promise<void>;
  clear(name: string): Promise<void>;
  getAll(): Promise<{ name: string; scheduledTime: number }[]>;
}

export type PageAvailability =
  { available: true } | { available: false; reason: string; code: "missing_permission" | "content_script_unavailable" | "restricted_url" };

export interface PagePort {
  evaluate(tabId: number, leaves: ConditionNode[], includeText: boolean): Promise<EvaluationResult[]>;
  /** null = unavailable (reason in second tuple element). */
  activity(tabId: number): Promise<{ activity: ActivitySnapshot | null; reason?: string }>;
}

export interface ClockPort {
  now(): number;
  random(): number;
}

export interface Stores {
  config: { get(): Promise<Config>; update(fn: (c: Config) => Config | void | Promise<Config | void>): Promise<Config> };
  runtime: {
    get(tabId: number): Promise<TabRuntime | null>;
    getAll(): Promise<TabRuntime[]>;
    put(rt: TabRuntime): Promise<void>;
    delete(tabId: number): Promise<void>;
  };
  history: { append(e: HistoryEntry): Promise<void> };
}

export interface EngineDeps {
  browser: BrowserPort;
  alarms: AlarmPort;
  page: PagePort;
  clock: ClockPort;
  stores: Stores;
  registries?: Registries;
  /** Global spacing between reloads to avoid refresh storms. */
  throttle?: () => Promise<void>;
  /** Override the bounded-wait limits (tests use short values). */
  timeouts?: Partial<EngineTimeouts>;
}

export interface EngineTimeouts {
  /** Max wait for a content-script round trip (activity / DOM evaluation). */
  pageMs: number;
  /** Max wait for chrome.tabs.reload to return. */
  reloadMs: number;
  /** Backstop: max time one operation may hold a tab's lock. */
  lockMs: number;
  /** A tab left in "evaluating" longer than this is re-run by a watchdog alarm. */
  watchdogMs: number;
}

export const DEFAULT_TIMEOUTS: EngineTimeouts = {
  pageMs: 15_000,
  reloadMs: 10_000,
  lockMs: 45_000,
  // Must exceed lockMs so the watchdog cycle can acquire the lock, and be at
  // least Chrome's minimum alarm delay.
  watchdogMs: 60_000,
};

export const ALARM_PREFIX = "sar:tab:";
export const NAVIGATION_TIMEOUT_MS = 60_000;

export const alarmName = (tabId: number) => `${ALARM_PREFIX}${tabId}`;
export const tabIdFromAlarm = (name: string): number | null => (name.startsWith(ALARM_PREFIX) ? Number(name.slice(ALARM_PREFIX.length)) : null);

export interface CycleResult {
  status: ExecutionStatus;
  reason?: string;
  evaluation?: EvaluationTrace;
}
