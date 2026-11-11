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

/** Remember POST submissions that load their result in this tab (not ones handled by script). */
export function watchFormPosts(win: Window, getStore: () => Store = () => win.sessionStorage, now = () => Date.now()) {
  // Bubble phase on window: runs after the page's own submit handlers, so
  // defaultPrevented tells whether the page took over (fetch/XHR).
  win.addEventListener("submit", (e) => {
    const form = e.target as HTMLFormElement | null;
    if (e.defaultPrevented || form?.tagName !== "FORM") return;
    const submitter = (e as SubmitEvent).submitter;
    const method = (submitter?.getAttribute("formmethod") || form.getAttribute("method") || "get").toLowerCase();
    if (method !== "post") return;
    // A result that opens in another tab or a (hidden) frame doesn't replace this page.
    const target = (submitter?.getAttribute("formtarget") || form.getAttribute("target") || "").toLowerCase();
    if (target && !["_self", "_top", "_parent"].includes(target)) return;
    const action = submitter?.getAttribute("formaction") ? new URL(submitter.getAttribute("formaction")!, win.location.href).href : form.action || win.location.href;
    safeStore(getStore)?.setItem(SUBMIT_KEY, JSON.stringify({ at: now(), action: noHash(action) }));
  });
}

/**
 * Whether the current page is a POST result. Call once, when the content
 * script starts. `timeOrigin` identifies this document, so a content script
 * injected again into the same page (after an extension update) still knows.
 */
export function detectFormResult(href: string, nav: NavigationInfo | null, getStore: () => Store, now = Date.now(), timeOrigin = 0): boolean {
  const store = safeStore(getStore);
  if (!store || !nav) return false;
  let submitted: { at?: number; action?: string } = {};
  try {
    submitted = JSON.parse(store.getItem(SUBMIT_KEY) ?? "{}") ?? {};
  } catch {
    /* ignore */
  }
  store.removeItem(SUBMIT_KEY);
  let result: { href?: string; timeOrigin?: number } = {};
  try {
    result = JSON.parse(store.getItem(RESULT_KEY) ?? "{}") ?? {};
  } catch {
    /* ignore */
  }
  const fresh = !!submitted.at && now - submitted.at < SUBMIT_FRESH_MS;
  // This page is what the form loaded: same address (ignoring #…), no redirect.
  if (nav.type === "navigate" && fresh && submitted.action === noHash(href) && nav.redirectCount === 0) {
    store.setItem(RESULT_KEY, JSON.stringify({ href, timeOrigin }));
    return true;
  }
  if (result.href === href) {
    // Reloaded, revisited via back/forward, or the same document with a newly injected content script.
    if (nav.type === "reload" || nav.type === "back_forward") return true;
    if (timeOrigin && result.timeOrigin === timeOrigin) return true;
  }
  store.removeItem(RESULT_KEY);
  return false;
}

export function currentNavigation(win: Window): NavigationInfo | null {
  const entry = win.performance?.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  return entry ? { type: entry.type, redirectCount: entry.redirectCount } : null;
}
