/**
 * The "highlight" action, in the page: marks the first element matching a
 * selector, or the first place a text appears, and scrolls to it, so the
 * thing a rule found is easy to spot when you come back to the tab.
 *
 * It uses the CSS Custom Highlight API, so the page's own elements and text
 * are not changed. It doesn't scroll while you are using the page.
 */

export const HIGHLIGHT_NAME = "justrefresh";
const STYLE_ID = "justrefresh-highlight-style";
/** Pointer, scroll or keys within this time: you are using the page, so it isn't scrolled. */
export const QUIET_MS = 10_000;

export type HighlightOutcome = { ok: true; scrolled: boolean } | { ok: false; error: string };

interface Quiet {
  /** Focus is in a text field, or the page was used within QUIET_MS. */
  busy: boolean;
}

/**
 * The first place `text` appears in `root`, case-insensitive and with runs of
 * whitespace treated as one space, as the text conditions compare. It may
 * span elements ("S$ <b>3</b>").
 */
export function findText(root: Element, text: string): Range | null {
  const needle = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!needle) return null;
  const { flat, from } = flatten(root);
  const at = flat.indexOf(needle);
  if (at < 0) return null;
  const first = from[at]!;
  const last = from[at + needle.length - 1]!;
  const range = root.ownerDocument.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

/** The text under `root`, lower case with whitespace runs as one space, and where each of its characters came from. */
function flatten(root: Element): { flat: string; from: { node: Text; offset: number }[] } {
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode: (n) => (n.parentElement?.closest("script,style,noscript,template,[hidden]") ? 2 /* FILTER_REJECT */ : 1),
  });
  let flat = "";
  const from: { node: Text; offset: number }[] = [];
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const value = n.nodeValue ?? "";
    for (let i = 0; i < value.length; i++) {
      const ch = flatChar(value[i]!);
      if (ch === " " && (flat === "" || flat.endsWith(" "))) continue;
      flat += ch;
      from.push({ node: n, offset: i });
    }
  }
  return { flat, from };
}

/** One character for one character: whitespace as a space, lower case where that stays one character. */
function flatChar(ch: string): string {
  if (/\s/.test(ch)) return " ";
  const lower = ch.toLowerCase();
  return lower.length === 1 ? lower : ch;
}

function ensureStyle(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `::highlight(${HIGHLIGHT_NAME}){background-color:#fde047;color:#111827}`;
  (doc.head ?? doc.documentElement).append(style);
}

type HighlightRegistry = { set(name: string, h: unknown): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;

/** Mark the ranges (CSS Custom Highlight API). False where the browser lacks it. */
function mark(win: Window, ranges: Range[]): boolean {
  const css = (win as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (win as unknown as { Highlight?: HighlightCtor }).Highlight;
  if (!css?.highlights || !Highlight) return false;
  ensureStyle(win.document);
  css.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
  return true;
}

/**
 * Highlight `text` inside the first element matching `selector` (the page when
 * left out), or the whole element when there is no text, and scroll to it
 * unless you are using the page.
 */
export function highlight(win: Window, opts: { selector?: string; text?: string }, quiet: Quiet): HighlightOutcome {
  const doc = win.document;
  let root: Element | null;
  try {
    root = opts.selector ? doc.querySelector(opts.selector) : doc.body;
  } catch {
    return { ok: false, error: `Invalid CSS selector "${opts.selector}"` };
  }
  if (!root) return { ok: false, error: opts.selector ? `Nothing matches ${opts.selector}` : "The page has no content" };
  let range: Range;
  if (opts.text) {
    const found = findText(root, opts.text);
    if (!found) return { ok: false, error: `“${opts.text}” isn't on the page` };
    range = found;
  } else {
    range = doc.createRange();
    range.selectNodeContents(root);
  }
  mark(win, [range]);
  if (quiet.busy) return { ok: true, scrolled: false };
  const target = opts.text ? range.startContainer.parentElement : root;
  target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  return { ok: true, scrolled: true };
}

/** Whether you are using the page now (from the activity monitor's snapshot). */
export function isBusy(s: { editing: boolean; composing: boolean; sinceKeyMs: number | null; sincePointerMs: number | null; sinceScrollMs: number | null }) {
  const recent = (ms: number | null) => ms !== null && ms < QUIET_MS;
  return s.editing || s.composing || recent(s.sinceKeyMs) || recent(s.sincePointerMs) || recent(s.sinceScrollMs);
}
