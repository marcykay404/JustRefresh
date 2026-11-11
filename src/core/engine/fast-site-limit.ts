/**
 * Fast intervals (< 30 s): at most one automatic refresh per site every
 * FAST_SITE_SPACING_MS across all tabs, so many tabs on one site cannot add
 * up to a flood of requests. Tabs on a site take turns: when the slot is
 * free, the one that has waited longest goes first. In memory only; it
 * resets with the service worker.
 */
import { FAST_SITE_SPACING_MS } from "../../triggers/interval";

/** Reason while a fast tab waits for its site's turn. */
export const FAST_WAIT_REASON = "Waiting: at most one fast refresh per site every 5 seconds";

/** A tab that yields to one ahead of it looks again this soon, in case that one no longer wants the slot. */
const YIELD_RETRY_MS = 1_000;

export class FastSiteLimit {
  /** Last fast automatic reload per host. */
  private readonly lastByHost = new Map<string, number>();
  /** Tabs waiting for a turn: host → tab → when it first had to wait, and when it last asked. */
  private readonly waitingByHost = new Map<string, Map<number, { since: number; seen: number }>>();

  /** Take the site's slot now (null), or when to ask again. */
  take(host: string, tabId: number, now: number): number | null {
    const last = this.lastByHost.get(host) ?? -Infinity;
    const waiting = this.queue(host, now);
    const mine = waiting.get(tabId)?.since ?? now;
    const wait = (retryAt: number) => {
      waiting.set(tabId, { since: mine, seen: now });
      return retryAt;
    };
    if (now - last < FAST_SITE_SPACING_MS) return wait(last + FAST_SITE_SPACING_MS);
    if ([...waiting].some(([id, w]) => id !== tabId && w.since < mine)) return wait(now + YIELD_RETRY_MS);
    waiting.delete(tabId);
    this.lastByHost.set(host, now);
    return null;
  }

  /** The tab no longer waits for a turn (stopped, paused, finished, closed…). */
  leave(tabId: number) {
    for (const waiting of this.waitingByHost.values()) waiting.delete(tabId);
  }

  /** The host's queue, without tabs that stopped asking (stopped, closed, left the site). */
  private queue(host: string, now: number) {
    const waiting = this.waitingByHost.get(host) ?? new Map<number, { since: number; seen: number }>();
    this.waitingByHost.set(host, waiting);
    for (const [id, w] of waiting) if (now - w.seen > 3 * FAST_SITE_SPACING_MS) waiting.delete(id);
    return waiting;
  }
}
