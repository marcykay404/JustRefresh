/**
 * Detects pages that are the result of submitting a form with POST (an
 * order, a payment, a sign-up). Reloading such a page makes Chrome ask
 * "Confirm Form Resubmission": an unattended refresh gets stuck behind that
 * prompt, and pressing Continue sends the form again (a duplicate order).
 *
 * How: when a POST form is submitted into this tab (and the page didn't
 * handle it with script), its time and address go into sessionStorage. The
 * next page in this tab checks them together with the Navigation Timing entry:
 *  - the form's own address, reached with no redirect → a POST result (a
 *    server redirect usually means the final page was fetched with GET);
 *  - reloaded or revisited (back/forward) while it was a POST result → still one;
 *  - any other navigation clears it.
 *
 * sessionStorage is per site, so a form that posts to a different site is
 * not detected (see docs/limitations.md). Nothing about the form's contents
 * is read or stored.
 */
export const SUBMIT_KEY = "justrefresh:form-post-submitted";
export const RESULT_KEY = "justrefresh:form-post-result";
/** A submission older than this does not explain the current page. */
export const SUBMIT_FRESH_MS = 2 * 60_000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface NavigationInfo {
  type: string;
  redirectCount: number;
}

function safeStore(get: () => Store): Store | null {
  try {
    return get();
  } catch {
    return null; // storage disabled for this site
  }
}

const noHash = (url: string) => url.split("#")[0]!;

/** Where a submitted form's result loads: the same tab for these targets (or none). */
const SAME_TAB = ["", "_self", "_top", "_parent"];

/** The address a submit event posts to and loads in this tab, or null (GET, handled by script, other tab/frame). */
export function postedAction(e: Event, win: Window): string | null {
  const form = e.target as HTMLFormElement | null;
  if (e.defaultPrevented || form?.tagName !== "FORM") return null;
  const submitter = (e as SubmitEvent).submitter;
  // The button's own formmethod / formtarget / formaction win over the form's.
  const either = (own: string, ofForm: string) => submitter?.getAttribute(own) || form.getAttribute(ofForm) || "";
  if ((either("formmethod", "method") || "get").toLowerCase() !== "post") return null;
  // A result that opens in another tab or a (hidden) frame doesn't replace this page.
  if (!SAME_TAB.includes(either("formtarget", "target").toLowerCase())) return null;
  const formaction = submitter?.getAttribute("formaction");
  return noHash(formaction ? new URL(formaction, win.location.href).href : form.action || win.location.href);
}

/** Remember POST submissions that load their result in this tab (not ones handled by script). */
export function watchFormPosts(win: Window, getStore: () => Store = () => win.sessionStorage, now = () => Date.now()) {
  // Bubble phase on window: runs after the page's own submit handlers, so
  // defaultPrevented tells whether the page took over (fetch/XHR).
  win.addEventListener("submit", (e) => {
    const action = postedAction(e, win);
    if (action !== null) safeStore(getStore)?.setItem(SUBMIT_KEY, JSON.stringify({ at: now(), action }));
  });
}

function readJson<T extends object>(store: Store, key: string): Partial<T> {
  try {
    return JSON.parse(store.getItem(key) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

interface Submitted {
  at: number;
  action: string;
}
interface Result {
  href: string;
  timeOrigin: number;
}

/** This page is what the form loaded: a fresh submission to this address (ignoring #…), no redirect. */
function loadedByForm(href: string, nav: NavigationInfo, submitted: Partial<Submitted>, now: number): boolean {
  const fresh = !!submitted.at && now - submitted.at < SUBMIT_FRESH_MS;
  return nav.type === "navigate" && nav.redirectCount === 0 && fresh && submitted.action === noHash(href);
}

/**
 * Still the remembered POST result: reloaded, revisited via back/forward, the
 * same document with a newly injected content script, or restored after
 * Memory Saver discarded the tab (the restore counts as "navigate" but
 * reloads the form result).
 */
function stillResult(href: string, nav: NavigationInfo, result: Partial<Result>, timeOrigin: number, wasDiscarded: boolean): boolean {
  if (result.href !== href) return false;
  if (nav.type === "reload" || nav.type === "back_forward" || wasDiscarded) return true;
  return !!timeOrigin && result.timeOrigin === timeOrigin;
}

/**
 * Whether the current page is a POST result. Call once, when the content
 * script starts. `timeOrigin` identifies this document, so a content script
 * injected again into the same page (after an extension update) still knows.
 */
export function detectFormResult(
  href: string,
  nav: NavigationInfo | null,
  getStore: () => Store,
  now = Date.now(),
  timeOrigin = 0,
  /** document.wasDiscarded: Chrome (Memory Saver) unloaded the tab and is restoring it. */
  wasDiscarded = false,
): boolean {
  const store = safeStore(getStore);
  if (!store || !nav) return false;
  const submitted = readJson<Submitted>(store, SUBMIT_KEY);
  store.removeItem(SUBMIT_KEY);
  const result = readJson<Result>(store, RESULT_KEY);
  const remember = () => store.setItem(RESULT_KEY, JSON.stringify({ href, timeOrigin }));
  if (loadedByForm(href, nav, submitted, now)) {
    remember();
    return true;
  }
  if (stillResult(href, nav, result, timeOrigin, wasDiscarded)) {
    // A restored document has a new timeOrigin.
    if (wasDiscarded) remember();
    return true;
  }
  store.removeItem(RESULT_KEY);
  return false;
}

export function currentNavigation(win: Window): NavigationInfo | null {
  const entry = win.performance?.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  return entry ? { type: entry.type, redirectCount: entry.redirectCount } : null;
}
