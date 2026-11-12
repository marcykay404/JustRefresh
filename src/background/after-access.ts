/**
 * What to do once site access is granted, kept by the service worker.
 *
 * The popup asks Chrome for access in the click, but on macOS Chrome closes
 * the popup as soon as its prompt opens, and the popup's code waiting for the
 * answer goes with it. So the popup first tells the service worker what the
 * click was for (start this tab's timer, resume it, or set up "Refresh until")
 * and the service worker does it when access is granted, whether or not the
 * popup is still open. Each request runs at most once, and expires after a
 * couple of minutes (a "Deny" leaves it to expire).
 */
import { setUpUntil, type ApiCall, type UntilPlan } from "../shared/until";

export const AFTER_ACCESS_KEY = "afterAccess";
/** How long a request waits for Chrome's answer. */
export const AFTER_ACCESS_MS = 2 * 60_000;

/** What may run after access: only these, only for the user's own clicks. */
export type AfterAccessRequest =
  | { method: "startTab"; params: { tabId: number; intervalSeconds?: number } }
  | { method: "resumeTab"; params: { tabId: number } }
  | { method: "refreshUntil"; params: UntilPlan };

interface Pending {
  origins: string[];
  request: AfterAccessRequest;
  until: number;
}

export interface AfterAccessResult {
  method: string;
  ok: boolean;
  /** Something the user should know (nothing set up, or another rule in the way). */
  message?: string;
}

export interface AfterAccessDeps {
  storage: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
  /** Whether JustRefresh may read pages matching this origin pattern now. */
  granted(origin: string): Promise<boolean>;
  /** The Rule Management API, as the user. */
  call: ApiCall;
  /** Tell the user (the popup may be gone). */
  notify(title: string, message: string): Promise<void>;
  now(): number;
}

const METHODS = new Set(["startTab", "resumeTab", "refreshUntil"]);

/** A request from an extension page, checked: known method, a tab id, origin patterns. null = refused. */
export function parseAfterAccess(raw: unknown): { origins: string[]; request: AfterAccessRequest } | null {
  const r = raw as { origins?: unknown; method?: unknown; params?: { tabId?: unknown } } | null;
  if (!r || !Array.isArray(r.origins) || !r.origins.every((o) => typeof o === "string" && o.length < 300) || r.origins.length > 10) return null;
  if (typeof r.method !== "string" || !METHODS.has(r.method) || typeof r.params?.tabId !== "number") return null;
  return { origins: r.origins as string[], request: { method: r.method, params: r.params } as AfterAccessRequest };
}

export function createAfterAccess(deps: AfterAccessDeps) {
  // One at a time: a request is always stored before a later "run" reads the list.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const load = async (): Promise<Pending[]> => ((await deps.storage.get(AFTER_ACCESS_KEY))[AFTER_ACCESS_KEY] as Pending[] | undefined) ?? [];
  const save = (list: Pending[]) => deps.storage.set({ [AFTER_ACCESS_KEY]: list });
  const tabOf = (r: AfterAccessRequest) => r.params.tabId;

  async function execute(r: AfterAccessRequest): Promise<AfterAccessResult> {
    if (r.method === "refreshUntil") {
      const out = await setUpUntil(r.params, deps.call);
      return { method: r.method, ok: out.done, message: out.warning };
    }
    await deps.call(r.method, r.params);
    return { method: r.method, ok: true };
  }

  return {
    /** Keep a request until access is granted (a newer one for the same tab replaces it). */
    queue(origins: string[], request: AfterAccessRequest) {
      return serial(async () => {
        const now = deps.now();
        const list = (await load()).filter((p) => p.until > now && tabOf(p.request) !== tabOf(request));
        await save([...list, { origins, request, until: now + AFTER_ACCESS_MS }]);
      });
    },
    /**
     * Take back a tab's request that is still waiting for access: the popup,
     * opened again after a "Deny", shows it (prefilled) instead, so it can't
     * start later by surprise. A request whose access is granted is left to run.
     */
    take(tabId: number) {
      return serial(async () => {
        const now = deps.now();
        const list = (await load()).filter((p) => p.until > now);
        const mine = list.find((p) => tabOf(p.request) === tabId);
        if (!mine || (await Promise.all(mine.origins.map((o) => deps.granted(o)))).every(Boolean)) return null;
        await save(list.filter((p) => p !== mine));
        return mine.request;
      });
    },
    /**
     * Run every request whose access is now granted. `quiet`: the popup asking
     * is still open and shows the results itself; otherwise problems are notified.
     */
    run(opts: { quiet?: boolean } = {}) {
      return serial(async () => {
        const now = deps.now();
        const list = (await load()).filter((p) => p.until > now);
        const ready: Pending[] = [];
        const waiting: Pending[] = [];
        for (const p of list) ((await Promise.all(p.origins.map((o) => deps.granted(o)))).every(Boolean) ? ready : waiting).push(p);
        // Taken off the list before running: each runs at most once.
        await save(waiting);
        const results: AfterAccessResult[] = [];
        for (const p of ready) {
          const result = await execute(p.request).catch((e: Error) => ({ method: p.request.method, ok: false, message: e.message }));
          results.push(result);
          if (!opts.quiet && result.message) await deps.notify(result.ok ? "JustRefresh" : "JustRefresh couldn't start", result.message);
        }
        return results;
      });
    },
  };
}
