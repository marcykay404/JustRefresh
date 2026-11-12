/**
 * What to do once site access is granted, kept by the service worker.
 *
 * The popup asks Chrome for access in the click, but on macOS Chrome closes
 * the popup as soon as its prompt opens, and the popup's code waiting for the
 * answer goes with it. So the popup first tells the service worker what the
 * click was for (start this tab's timer, resume it, or set up "Refresh until")
 * and the service worker does it when access is granted, whether or not the
 * popup is still open.
 *
 * Each request runs at most once, only while its tab still shows the site it
 * was for, and expires after a couple of minutes. A "Deny" cancels it (or it
 * expires, if the popup closed). Its result is kept for a minute under the
 * request's id, so a popup that is still open learns what happened whichever
 * side ran it; a notification tells the user only when no popup is open.
 */
import { setUpUntil, type ApiCall, type UntilPlan } from "../shared/until";

export const AFTER_ACCESS_KEY = "afterAccess";
export const AFTER_ACCESS_RESULTS_KEY = "afterAccessResults";
/** How long a request waits for Chrome's answer. */
export const AFTER_ACCESS_MS = 2 * 60_000;
/** How long a result waits for the popup that asked. */
const RESULT_MS = 60_000;

/** What may run after access: only these, only for the user's own clicks. */
export type AfterAccessRequest =
  | { method: "startTab"; params: { tabId: number; intervalSeconds?: number } }
  | { method: "resumeTab"; params: { tabId: number } }
  | { method: "refreshUntil"; params: UntilPlan };

interface Pending {
  id: string;
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
  /** Whether the tab is still open on a page matching one of these origin patterns. */
  tabOn(tabId: number, origins: string[]): Promise<boolean>;
  /** The Rule Management API, as the user. */
  call: ApiCall;
  /** Whether a JustRefresh popup is open in this tab's window (it shows the result itself). */
  popupOpen(tabId: number): Promise<boolean>;
  /** Tell the user (the popup is gone). */
  notify(tabId: number, title: string, message: string): Promise<void>;
  now(): number;
}

const METHODS = new Set(["startTab", "resumeTab", "refreshUntil"]);

/** A request from an extension page, checked: an id, origin patterns, a known method for a tab. null = refused. */
export function parseAfterAccess(raw: unknown): { id: string; origins: string[]; request: AfterAccessRequest } | null {
  const r = raw as { id?: unknown; origins?: unknown; method?: unknown; params?: { tabId?: unknown } } | null;
  if (!r || typeof r.id !== "string" || !/^[\w-]{1,64}$/.test(r.id)) return null;
  if (!Array.isArray(r.origins) || r.origins.length === 0 || r.origins.length > 10) return null;
  if (!r.origins.every((o) => typeof o === "string" && o.length < 300)) return null;
  if (typeof r.method !== "string" || !METHODS.has(r.method) || typeof r.params?.tabId !== "number") return null;
  return { id: r.id, origins: r.origins as string[], request: { method: r.method, params: r.params } as AfterAccessRequest };
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
  type Kept = Record<string, { result: AfterAccessResult; at: number }>;
  const loadResults = async (): Promise<Kept> => ((await deps.storage.get(AFTER_ACCESS_RESULTS_KEY))[AFTER_ACCESS_RESULTS_KEY] as Kept | undefined) ?? {};
  const tabOf = (r: AfterAccessRequest) => r.params.tabId;
  const allGranted = async (p: Pending) => (await Promise.all(p.origins.map((o) => deps.granted(o)))).every(Boolean);

  async function execute(r: AfterAccessRequest): Promise<AfterAccessResult> {
    if (r.method === "refreshUntil") {
      const out = await setUpUntil(r.params, deps.call);
      return { method: r.method, ok: out.done, message: out.warning };
    }
    await deps.call(r.method, r.params);
    return { method: r.method, ok: true };
  }

  /** Run the requests `pick` chooses whose access is now granted; keep each result under its id. */
  async function runReady(pick: (p: Pending) => boolean): Promise<{ id: string; tabId: number; result: AfterAccessResult }[]> {
    const now = deps.now();
    const list = (await load()).filter((p) => p.until > now);
    const ready: Pending[] = [];
    const waiting: Pending[] = [];
    for (const p of list) (pick(p) && (await allGranted(p)) ? ready : waiting).push(p);
    // Taken off the list before running: each runs at most once.
    await save(waiting);
    const done: { id: string; tabId: number; result: AfterAccessResult }[] = [];
    for (const p of ready) {
      // The tab closed, or shows another site now: not what the click was for.
      if (!(await deps.tabOn(tabOf(p.request), p.origins))) continue;
      const result = await execute(p.request).catch((e: Error) => ({ method: p.request.method, ok: false, message: e.message }));
      done.push({ id: p.id, tabId: tabOf(p.request), result });
    }
    if (done.length) {
      const kept = Object.fromEntries(Object.entries(await loadResults()).filter(([, k]) => now - k.at < RESULT_MS));
      for (const d of done) kept[d.id] = { result: d.result, at: deps.now() };
      await deps.storage.set({ [AFTER_ACCESS_RESULTS_KEY]: kept });
    }
    return done;
  }

  return {
    /**
     * Keep a request until access is granted. A newer click replaces any request
     * for the same tab or the same sites: Chrome asks one thing at a time, and
     * an older one (declined after its popup closed) mustn't start with it.
     */
    queue(id: string, origins: string[], request: AfterAccessRequest) {
      return serial(async () => {
        const now = deps.now();
        const list = (await load()).filter((p) => p.until > now && tabOf(p.request) !== tabOf(request) && !p.origins.some((o) => origins.includes(o)));
        await save([...list, { id, origins, request, until: now + AFTER_ACCESS_MS }]);
      });
    },
    /**
     * Take back a tab's request that is still waiting for access: after a
     * "Deny", or when the popup, opened again, shows it (prefilled) instead,
     * so it can't start later by surprise. A granted one is left to run.
     */
    take(tabId: number, id?: string) {
      return serial(async () => {
        const now = deps.now();
        const list = (await load()).filter((p) => p.until > now);
        const mine = list.find((p) => tabOf(p.request) === tabId && (id === undefined || p.id === id));
        if (!mine || (await allGranted(mine))) return null;
        await save(list.filter((p) => p !== mine));
        return mine.request;
      });
    },
    /**
     * Chrome granted access to `origins`: run the requests for those sites
     * (only those: access granted for something else doesn't start a request
     * the user declined), telling the user about a problem when no popup in
     * that tab's window is open to show it.
     */
    runGranted(origins: string[]) {
      return serial(async () => {
        const done = await runReady((p) => p.origins.some((o) => origins.includes(o)));
        for (const d of done) {
          if (!d.result.message || (await deps.popupOpen(d.tabId).catch(() => false))) continue;
          await deps.notify(d.tabId, d.result.ok ? "JustRefresh" : "JustRefresh couldn't start", d.result.message);
        }
        return done;
      });
    },
    /** The popup that asked, still open after "Allow": run its request if Chrome's event hasn't, and say what happened. */
    resultFor(id: string) {
      return serial(async () => {
        await runReady((p) => p.id === id);
        return (await loadResults())[id]?.result ?? null;
      });
    },
    /** Another page is about to ask Chrome for these sites itself: drop requests waiting for them. */
    cancelFor(origins: string[]) {
      return serial(async () => {
        const list = await load();
        const kept = list.filter((p) => !p.origins.some((o) => origins.includes(o)));
        if (kept.length !== list.length) await save(kept);
      });
    },
  };
}
