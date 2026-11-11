/**
 * Detects pages that are the result of submitting a form with POST (an
 * order, a payment, a sign-up). Reloading such a page makes Chrome ask
 * "Confirm Form Resubmission": an unattended refresh gets stuck behind that
 * prompt, and pressing Continue sends the form again (a duplicate order).
 *
 * How: when a POST form is submitted (and the page didn't handle it with
 * script), a timestamp goes into sessionStorage. The next page in this tab
 * checks it together with the Navigation Timing entry:
 *  - reached by that submission with no redirect → a POST result (a server
 *    redirect means the final page was fetched with GET: safe to reload);
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

/** Remember POST submissions that leave the page (not ones handled by script). */
export function watchFormPosts(win: Window, getStore: () => Store = () => win.sessionStorage, now = () => Date.now()) {
  // Bubble phase on window: runs after the page's own submit handlers, so
  // defaultPrevented tells whether the page took over (fetch/XHR).
  win.addEventListener("submit", (e) => {
    const form = e.target as Element | null;
    if (e.defaultPrevented || form?.tagName !== "FORM") return;
    const submitter = (e as SubmitEvent).submitter;
    const method = (submitter?.getAttribute("formmethod") || form.getAttribute("method") || "get").toLowerCase();
    if (method !== "post") return;
    safeStore(getStore)?.setItem(SUBMIT_KEY, String(now()));
  });
}

/** Whether the current page is a POST result. Call once, when the page starts. */
export function detectFormResult(href: string, nav: NavigationInfo | null, getStore: () => Store, now = Date.now()): boolean {
  const store = safeStore(getStore);
  if (!store || !nav) return false;
  const submittedAt = Number(store.getItem(SUBMIT_KEY));
  store.removeItem(SUBMIT_KEY);
  if (nav.type === "navigate" && submittedAt && now - submittedAt < SUBMIT_FRESH_MS && nav.redirectCount === 0) {
    store.setItem(RESULT_KEY, href);
    return true;
  }
  if ((nav.type === "reload" || nav.type === "back_forward") && store.getItem(RESULT_KEY) === href) return true;
  store.removeItem(RESULT_KEY);
  return false;
}

export function currentNavigation(win: Window): NavigationInfo | null {
  const entry = win.performance?.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  return entry ? { type: entry.type, redirectCount: entry.redirectCount } : null;
}
