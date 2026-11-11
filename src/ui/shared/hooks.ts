import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { subscribe, type Topic } from "./live";

/** Whether the page is visible (false while its tab is in the background or minimized). */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/** Current time, ticking while the page is visible (countdowns are derived from it). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  const visible = usePageVisible();
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, visible]);
  return now;
}

/**
 * Fetch an API method and keep it current.
 *
 * `live`: re-fetch when one of these kinds of data changes (Chrome tells the
 * page; see live.ts), instead of polling. `pollMs`: poll as well, for data
 * Chrome has no event for. Either way, nothing is fetched while the page is
 * hidden (each fetch wakes the service worker); it catches up as soon as the
 * page is visible again.
 */
export function useApi<T>(method: string, params?: unknown, opts: { pollMs?: number; skip?: boolean; live?: readonly Topic[] } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!opts.skip);
  const key = JSON.stringify(params ?? null);
  const live = (opts.live ?? []).join(",");
  const alive = useRef(true);
  /** Requests started; only the newest one's answer is used (answers can arrive out of order). */
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (opts.skip) return;
    const mine = ++seq.current;
    const current = () => alive.current && mine === seq.current;
    try {
      const r = await api<T>(method, params);
      if (current()) {
        setData(r);
        setError(null);
      }
    } catch (e) {
      if (current()) setError(e as Error);
    } finally {
      if (current()) setLoading(false);
    }
  }, [method, key, opts.skip]);

  const visible = usePageVisible();
  // One-off fetches ignore visibility; kept-current ones only run while visible.
  const active = (!opts.pollMs && !live) || visible;

  useEffect(() => {
    alive.current = true;
    if (!active) {
      return () => {
        alive.current = false;
      };
    }
    // Changes can arrive many times a second (many tabs, fast intervals): at
    // most one fetch in flight, one more queued, and LIVE_GAP_MS between starts.
    let inFlight = false;
    let dirty = false;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      inFlight = true;
      last = Date.now();
      void reload().finally(() => {
        inFlight = false;
        if (dirty && alive.current) {
          dirty = false;
          poke();
        }
      });
    };
    const poke = () => {
      if (inFlight) {
        dirty = true;
        return;
      }
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        start();
      }, Math.max(0, last + LIVE_GAP_MS - Date.now()));
    };
    start();
    // Polling is paced by its own interval.
    const t = opts.pollMs ? setInterval(() => (inFlight ? (dirty = true) : start()), opts.pollMs) : undefined;
    const off = live ? subscribe(live.split(",") as Topic[], poke) : undefined;
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
      if (timer !== undefined) clearTimeout(timer);
      off?.();
    };
  }, [reload, opts.pollMs, active, live]);

  return { data, error, loading, reload, setData };
}

/** Minimum time between two automatic re-fetches of one hook. */
export const LIVE_GAP_MS = 500;

export function useHashRoute(): [string, (r: string) => void] {
  const [hash, setHash] = useState(location.hash.slice(1) || "/tabs");
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || "/tabs");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [hash, (r) => (location.hash = r)];
}
