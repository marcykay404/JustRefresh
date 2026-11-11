/**
 * Page actions a rule can take besides refreshing: click an element, and keep
 * the scroll position across a refresh.
 *
 * A click never submits a form: sending a form again can repeat an order or
 * a payment, the same reason a page reached by submitting a form is never
 * refreshed (see form-post.ts). Clicks that a page handles with script
 * (fetch/XHR) can't be told apart and are the rule author's responsibility.
 */

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type Control = HTMLButtonElement | HTMLInputElement;

/**
 * The button or input a click on `el` would activate: the element itself, the
 * button it sits in, or a label's control. (Checked by tag name rather than
 * instanceof, which fails for elements from another window.)
 */
function activatedControl(el: Element): Control | null {
  const label = el.closest("label") as HTMLLabelElement | null;
  const target = label?.control ?? el.closest("button, input");
  return target && ["BUTTON", "INPUT"].includes(target.tagName) ? (target as Control) : null;
}

function submitsForm(control: Control): boolean {
  const submitTypes = control.tagName === "BUTTON" ? ["submit"] : ["submit", "image"];
  return submitTypes.includes(control.type) && control.form !== null;
}

/** Why `el` must not be clicked, or null. */
export function clickBlocker(el: Element): string | null {
  const control = activatedControl(el);
  if (control && submitsForm(control)) return "it would submit a form, and sending a form again can repeat an order or a payment";
  if (control?.disabled) return "it is disabled";
  return null;
}

export type ClickResult = { ok: true } | { ok: false; error: string };

/** Click the first element matching `selector`, unless that would submit a form. */
export function clickElement(doc: Document, selector: string): ClickResult {
  let el: Element | null;
  try {
    el = doc.querySelector(selector);
  } catch {
    return { ok: false, error: `Not a valid CSS selector: ${selector}` };
  }
  if (!el) return { ok: false, error: `Nothing on the page matches ${selector}` };
  const blocked = clickBlocker(el);
  if (blocked) return { ok: false, error: `Not clicked: ${blocked}` };
  const html = el as HTMLElement;
  if (typeof html.click === "function") html.click();
  else el.dispatchEvent(new (doc.defaultView ?? window).MouseEvent("click", { bubbles: true, cancelable: true }));
  return { ok: true };
}

/* ---------------- scroll position across a refresh ---------------- */

export const SCROLL_KEY = "justrefresh:scroll";
/** A saved position older than this belongs to some earlier visit. */
export const SCROLL_FRESH_MS = 60_000;
/** Keep trying while the page grows (images, late content), at most this long. */
export const SCROLL_RESTORE_MS = 10_000;
const SCROLL_STEP_MS = 100;

interface SavedScroll {
  href: string;
  x: number;
  y: number;
  at: number;
}

/** Remember where this page is scrolled to, just before the extension refreshes it. */
export function saveScroll(win: Window, store: Store, now = Date.now()) {
  const saved: SavedScroll = { href: win.location.href, x: win.scrollX, y: win.scrollY, at: now };
  store.setItem(SCROLL_KEY, JSON.stringify(saved));
}

function takeSaved(win: Window, store: Store, now: number): SavedScroll | null {
  let saved: Partial<SavedScroll> = {};
  try {
    saved = JSON.parse(store.getItem(SCROLL_KEY) ?? "{}") ?? {};
  } catch {
    /* ignore */
  }
  store.removeItem(SCROLL_KEY);
  const fresh = typeof saved.at === "number" && now - saved.at < SCROLL_FRESH_MS;
  if (!fresh || saved.href !== win.location.href || !(saved.x || saved.y)) return null;
  return saved as SavedScroll;
}

/**
 * After a refresh that asked to keep the scroll position: scroll back, and keep
 * at it while the page is still loading content, until the user scrolls,
 * clicks or types themselves. Returns a function that stops trying.
 */
export function restoreScroll(win: Window, store: Store, now = Date.now()): () => void {
  const saved = takeSaved(win, store, now);
  if (!saved) return () => undefined;
  const started = Date.now();
  const userEvents = ["wheel", "touchstart", "keydown", "mousedown"];
  const stop = () => {
    win.clearInterval(timer);
    for (const t of userEvents) win.removeEventListener(t, stop, true);
  };
  const step = () => {
    win.scrollTo(saved.x, saved.y);
    const there = Math.abs(win.scrollX - saved.x) < 2 && Math.abs(win.scrollY - saved.y) < 2;
    if ((there && win.document.readyState === "complete") || Date.now() - started > SCROLL_RESTORE_MS) stop();
  };
  const timer = win.setInterval(step, SCROLL_STEP_MS);
  for (const t of userEvents) win.addEventListener(t, stop, { capture: true, passive: true });
  return stop;
}
