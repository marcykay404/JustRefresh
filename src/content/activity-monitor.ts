/**
 * Activity & unsaved-change monitor (content script, top frame only).
 *
 * Privacy: only timestamps and booleans are kept. Input values and
 * keystrokes are never read into variables that leave this module, never
 * stored, and never transmitted. Dirty detection compares each control's
 * current value with its default *inside the page* and returns a boolean.
 */
import type { ActivitySnapshot } from "../shared/messaging-types";

const MAX_CONTROLS = 2000;

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    const nonText = ["button", "submit", "reset", "image", "hidden", "checkbox", "radio", "range", "color", "file"];
    return !nonText.includes(el.type) && !el.readOnly && !el.disabled;
  }
  if (el instanceof HTMLSelectElement) return !el.disabled;
  return (el as HTMLElement).isContentEditable === true;
}

export class ActivityMonitor {
  private readonly startedAt = performance.now();
  private lastKey: number | null = null;
  private lastInput: number | null = null;
  private lastPointer: number | null = null;
  private lastScroll: number | null = null;
  private composing = false;
  private editableTouched = false;
  private readonly submittedForms = new WeakSet<HTMLFormElement>();

  constructor(private readonly doc: Document) {}

  start() {
    const now = () => performance.now();
    const opts = { capture: true, passive: true } as const;
    this.doc.addEventListener("keydown", (e) => {
      if (isEditable(e.target) || (e.target as HTMLElement)?.isContentEditable) this.lastKey = now();
    }, opts);
    this.doc.addEventListener("input", (e) => {
      this.lastInput = now();
      if ((e.target as HTMLElement)?.isContentEditable) this.editableTouched = true;
    }, opts);
    this.doc.addEventListener("change", () => (this.lastInput = now()), opts);
    this.doc.addEventListener("compositionstart", () => (this.composing = true), opts);
    this.doc.addEventListener("compositionend", () => {
      this.composing = false;
      this.lastInput = now();
    }, opts);
    this.doc.addEventListener("pointerdown", () => (this.lastPointer = now()), opts);
    this.doc.addEventListener("pointermove", () => (this.lastPointer = now()), opts);
    this.doc.addEventListener("wheel", () => (this.lastScroll = now()), opts);
    this.doc.addEventListener("scroll", () => (this.lastScroll = now()), opts);
    this.doc.addEventListener("submit", (e) => {
      if (e.target instanceof HTMLFormElement) this.submittedForms.add(e.target);
    }, opts);
  }

  /** Conservative dirty check: never reports "clean" when unsure. */
  dirtyState(): ActivitySnapshot["dirty"] {
    const controls = this.doc.querySelectorAll("input, textarea, select");
    let checked = 0;
    for (const el of Array.from(controls)) {
      if (++checked > MAX_CONTROLS) return "unknown";
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        if (el.form && this.submittedForms.has(el.form)) continue;
      }
      if (el instanceof HTMLInputElement) {
        if (el.type === "hidden" || el.disabled || el.readOnly) continue;
        if (el.type === "checkbox" || el.type === "radio") {
          if (el.checked !== el.defaultChecked) return "dirty";
        } else if (el.type !== "file" && el.value !== el.defaultValue) {
          return "dirty";
        } else if (el.type === "file" && el.files && el.files.length > 0) {
          return "dirty";
        }
      } else if (el instanceof HTMLTextAreaElement) {
        if (!el.disabled && !el.readOnly && el.value !== el.defaultValue) return "dirty";
      } else if (el instanceof HTMLSelectElement) {
        for (const opt of Array.from(el.options)) if (opt.selected !== opt.defaultSelected) return "dirty";
      }
    }
    // contenteditable edits cannot be compared to a saved state.
    return this.editableTouched ? "unknown" : "clean";
  }

  snapshot(): ActivitySnapshot {
    const now = performance.now();
    const since = (t: number | null) => (t === null ? null : Math.max(0, Math.round(now - t)));
    return {
      monitoringForMs: Math.round(now - this.startedAt),
      sinceKeyMs: since(this.lastKey),
      sinceInputMs: since(this.lastInput),
      sincePointerMs: since(this.lastPointer),
      sinceScrollMs: since(this.lastScroll),
      composing: this.composing,
      editing: isEditable(this.doc.activeElement),
      dirty: this.dirtyState(),
      readyState: this.doc.readyState,
    };
  }
}
