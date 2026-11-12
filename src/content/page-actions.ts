/**
 * Page actions a rule can take besides refreshing: click an element, and keep
 * the scroll position across a refresh.
 *
 * A click never submits (or resets) a form: sending a form again can repeat an
 * order or a payment, the same reason a page reached by submitting a form is
 * never refreshed (see form-post.ts). Known submit controls are refused, and
 * any form submission a click still sets off is cancelled. Buttons that send
 * an order with script (fetch/XHR) can't be told apart from any other button.
 */

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type Control = HTMLButtonElement | HTMLInputElement;
const CONTROL_TAGS = ["BUTTON", "INPUT"];

/**
 * The button or input a click on `el` would activate: the element itself or
 * the button it sits in, else the control of the label it sits in. (Checked
 * by tag name rather than instanceof, which fails for another window's elements.)
 */
function activatedControl(el: Element): Control | null {
  const own = el.closest("button, input");
  if (own) return own as Control;
  const target = (el.closest("label") as HTMLLabelElement | null)?.control;
  return target && CONTROL_TAGS.includes(target.tagName) ? (target as Control) : null;
}

/** "submit" / "reset" when activating the control would submit or reset its form. */
function formEffect(control: Control): "submit" | "reset" | null {
  if (control.form === null) return null;
  const effects: Record<string, "submit" | "reset"> =
    control.tagName === "BUTTON" ? { submit: "submit", reset: "reset" } : { submit: "submit", image: "submit", reset: "reset" };
  return Object.hasOwn(effects, control.type) ? effects[control.type]! : null;
}

/** Form-associated custom elements (e.g. `<sl-button type="submit">`) mark themselves with a type attribute. */
function customFormButton(el: Element): "submit" | "reset" | null {
  const marked = el.closest('[type="submit" i], [type="reset" i]');
  if (!marked || CONTROL_TAGS.includes(marked.tagName) || !marked.closest("form")) return null;
  return marked.getAttribute("type")!.toLowerCase() === "reset" ? "reset" : "submit";
}

const EFFECT_REASON = {
  submit: "it would submit a form, and sending a form again can repeat an order or a payment",
  reset: "it would reset a form and lose what was typed",
};

function isDisabled(control: Control): boolean {
  try {
    return control.matches(":disabled"); // includes a disabled <fieldset> around it
  } catch {
    return control.disabled;
  }
}

/** Why `el` must not be clicked, or null. */
export function clickBlocker(el: Element): string | null {
  const control = activatedControl(el);
  const effect = (control && formEffect(control)) ?? customFormButton(el);
  if (effect) return EFFECT_REASON[effect];
  if (control && isDisabled(control)) return "it is disabled";
  return null;
}

export type ClickResult = { ok: true } | { ok: false; error: string };

const MAX_SHADOW_ROOTS = 200;

/** Open shadow roots inside `el` (a component's own forms live there). Closed ones can't be reached. */
function shadowRootsIn(el: Element): ShadowRoot[] {
  const found: ShadowRoot[] = [];
  const visit = (node: Element | ShadowRoot) => {
    for (const child of node.querySelectorAll("*")) {
      if (found.length >= MAX_SHADOW_ROOTS) return;
      if (child.shadowRoot) {
        found.push(child.shadowRoot);
        visit(child.shadowRoot);
      }
    }
  };
  if (el.shadowRoot) found.push(el.shadowRoot);
  visit(el.shadowRoot ?? el);
  if (el.shadowRoot) visit(el);
  return found;
}

/**
 * While clicking, cancel any form submission or reset the click sets off (a
 * script-driven button, a custom element). `submit` doesn't leave a shadow
 * root, so the open shadow roots inside the element are watched too.
 * Returns what was stopped.
 */
function guardForms(doc: Document, el: Element): () => "submit" | "reset" | null {
  let stopped: "submit" | "reset" | null = null;
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    stopped = e.type as "submit" | "reset";
  };
  const targets: EventTarget[] = [doc, ...shadowRootsIn(el)];
  for (const t of targets) for (const type of ["submit", "reset"]) t.addEventListener(type, stop, true);
  return () => {
    for (const t of targets) for (const type of ["submit", "reset"]) t.removeEventListener(type, stop, true);
    return stopped;
  };
}

/** Click the first element matching `selector`, unless that would submit or reset a form. */
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
  const release = guardForms(doc, el);
  const html = el as HTMLElement;
  if (typeof html.click === "function") html.click();
  else el.dispatchEvent(new (doc.defaultView ?? window).MouseEvent("click", { bubbles: true, cancelable: true }));
  const stopped = release();
  return stopped ? { ok: false, error: `Clicked, but it tried to ${stopped} a form; JustRefresh stopped that` } : { ok: true };
}

/* ---------------- scroll position across a refresh ---------------- */

export const SCROLL_KEY = "justrefresh:scroll";
/** A saved position older than this belongs to some earlier visit (or a refresh that never happened). */
export const SCROLL_FRESH_MS = 30_000;
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
 * at it while the page is still loading content. It stops as soon as anything
 * else moves the page (the user dragging the scrollbar, find-in-page, the
 * page's own script) or the user scrolls, clicks or types. Returns a function
 * that stops trying.
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
  let left: { x: number; y: number } | null = null; // where our last scroll left the page
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;
  const step = () => {
    const now = { x: win.scrollX, y: win.scrollY };
    if (left && !near(now, left)) return stop(); // moved by someone else
    win.scrollTo(saved.x, saved.y);
    left = { x: win.scrollX, y: win.scrollY };
    if ((near(left, saved) && win.document.readyState === "complete") || Date.now() - started > SCROLL_RESTORE_MS) stop();
  };
  const timer = win.setInterval(step, SCROLL_STEP_MS);
  for (const t of userEvents) win.addEventListener(t, stop, { capture: true, passive: true });
  return stop;
}
