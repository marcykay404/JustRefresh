import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

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
 * Fetch an API method and optionally poll it. Polling pauses while the page
 * is hidden — every poll wakes the service worker — and catches up with an
 * immediate fetch when the page becomes visible again.
 */
export function useApi<T>(method: string, params?: unknown, opts: { pollMs?: number; skip?: boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!opts.skip);
  const key = JSON.stringify(params ?? null);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    if (opts.skip) return;
    try {
      const r = await api<T>(method, params);
      if (alive.current) {
        setData(r);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(e as Error);
    } finally {
      if (alive.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, key, opts.skip]);

  const visible = usePageVisible();
  // One-off fetches ignore visibility; polled ones only run while visible.
  const active = !opts.pollMs || visible;

  useEffect(() => {
    alive.current = true;
    if (!active) {
      return () => {
        alive.current = false;
      };
    }
    void reload();
    const t = opts.pollMs ? setInterval(reload, opts.pollMs) : undefined;
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
  }, [reload, opts.pollMs, active]);

  return { data, error, loading, reload, setData };
}

export function useHashRoute(): [string, (r: string) => void] {
  const [hash, setHash] = useState(location.hash.slice(1) || "/tabs");
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || "/tabs");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [hash, (r) => (location.hash = r)];
}
