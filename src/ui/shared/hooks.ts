import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Fetch an API method and optionally poll it. */
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

  useEffect(() => {
    alive.current = true;
    void reload();
    const t = opts.pollMs ? setInterval(reload, opts.pollMs) : undefined;
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
  }, [reload, opts.pollMs]);

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
