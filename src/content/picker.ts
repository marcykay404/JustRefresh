/**
 * In-page element picker for the Rule Builder: highlights the element under
 * the pointer with the selector it would get and how many elements that
 * selector matches. Click picks it, ↑ widens to the parent (↓ back), Esc
 * cancels. While picking, clicks and presses go to the picker only, so
 * picking a "Buy" button never presses it.
 */
import { selectorFor } from "./selector";

export interface PickResult {
  selector: string;
  count: number;
  /** The selector counts siblings (:nth-of-type): it may point at another item if the list changes. */
  positional: boolean;
}

/** How a picker ended: picked, cancelled by the user, or replaced by a newer picker. */
export type PickOutcome = { picked: PickResult } | { cancelled: true } | { replaced: true };

const BLOCKED = ["click", "dblclick", "auxclick", "contextmenu", "mousedown", "mouseup", "pointerdown", "pointerup", "submit"];

let active: ((how: "cancelled" | "replaced") => void) | null = null;

/** Stop a picker that is running (as if cancelled). */
export function cancelPicker() {
  active?.("cancelled");
}

export const isPositional = (selector: string) => selector.includes(":nth-of-type(");

function countOf(doc: Document, selector: string): number {
  try {
    return doc.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

function overlay(doc: Document) {
  const host = doc.createElement("div");
  // The overlay takes the pointer itself: nothing on the page, or inside its
  // iframes (a payment form, say), can be pressed while picking.
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    .box{position:fixed;border:2px solid #2563eb;background:rgba(37,99,235,.12);border-radius:3px;pointer-events:none;display:none}
    .tip{position:fixed;left:12px;max-width:calc(100vw - 24px);padding:6px 10px;border-radius:6px;background:#111827;color:#fff;
      font:12px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:none;overflow-wrap:anywhere}
    .tip b{font-family:ui-monospace,monospace;font-weight:600}
  </style><div class="box"></div><div class="tip"></div>`;
  doc.documentElement.append(host);
  return { host, box: root.querySelector(".box") as HTMLElement, tip: root.querySelector(".tip") as HTMLElement };
}

/** Start picking; `onDone` says how it ended. Starting again replaces a running picker. */
export function startPicker(win: Window, onDone: (r: PickOutcome) => void) {
  active?.("replaced");
  const doc = win.document;
  const { host, box, tip } = overlay(doc);
  let target: Element | null = null;
  const narrower: Element[] = [];

  const render = () => {
    const where = target ? target.getBoundingClientRect() : null;
    box.style.display = where ? "block" : "none";
    if (where) Object.assign(box.style, { left: `${where.left}px`, top: `${where.top}px`, width: `${where.width}px`, height: `${where.height}px` });
    // Keep the tip away from the element.
    tip.style.top = where && where.top < 80 ? "" : "12px";
    tip.style.bottom = where && where.top < 80 ? "12px" : "";
    tip.textContent = "";
    const help = "Click to use it · ↑ parent · Esc to cancel";
    if (!target) return void (tip.textContent = `JustRefresh: point at an element. ${help}`);
    const selector = selectorFor(target);
    const n = countOf(doc, selector);
    const b = doc.createElement("b");
    b.textContent = selector;
    const position = isPositional(selector) ? " · by position: may pick another item if the list changes" : "";
    tip.append(b, ` — ${n} ${n === 1 ? "match" : "matches"}${position} · ${help}`);
  };

  const finish = (how: "picked" | "cancelled" | "replaced") => {
    for (const t of BLOCKED) win.removeEventListener(t, onBlocked, true);
    win.removeEventListener("mousemove", onMove, true);
    win.removeEventListener("keydown", onKey, true);
    win.removeEventListener("scroll", render, true);
    host.remove();
    active = null;
    if (how === "picked" && target) {
      const selector = selectorFor(target);
      return onDone({ picked: { selector, count: countOf(doc, selector), positional: isPositional(selector) } });
    }
    onDone(how === "replaced" ? { replaced: true } : { cancelled: true });
  };

  const onMove = (e: MouseEvent) => {
    // The overlay is on top: look underneath it.
    const el = doc.elementsFromPoint(e.clientX, e.clientY).find((x) => x !== host && x !== doc.documentElement);
    if (!el || el === target) return;
    target = el;
    narrower.length = 0;
    render();
  };
  const onBlocked = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === "click" && (e as MouseEvent).button === 0 && target) finish("picked");
  };
  const onKey = (e: KeyboardEvent) => {
    const moves: Record<string, () => void> = {
      Escape: () => finish("cancelled"),
      ArrowUp: () => {
        const parent = target?.parentElement;
        if (!target || !parent || parent === doc.documentElement) return;
        narrower.push(target);
        target = parent;
      },
      ArrowDown: () => {
        const child = narrower.pop();
        if (child) target = child;
      },
    };
    if (!Object.hasOwn(moves, e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    moves[e.key]!();
    if (active) render();
  };

  for (const t of BLOCKED) win.addEventListener(t, onBlocked, true);
  win.addEventListener("mousemove", onMove, true);
  win.addEventListener("keydown", onKey, true);
  win.addEventListener("scroll", render, { capture: true, passive: true });
  active = (how) => finish(how);
  render();
}
