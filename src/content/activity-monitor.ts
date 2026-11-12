/**
 * Activity & unsaved-change monitor (content script, in the page and in its
 * frames from granted sites; the extension merges them, see core/frames.ts).
 *
 * Privacy: only timestamps, booleans and, per edited field, a short hash of
 * its state are kept, in memory, inside this module. Input values and
 * keystrokes are never read into variables that leave this module, never
 * stored, and never transmitted. Dirty detection compares each control's
 * current value with its default *inside the page* and returns a boolean.
 *
 * Only controls the user actually edited (trusted input/change events) count
 * as unsaved: pages routinely set field values from script, which is not the
 * user's work. When the monitor started after the page loaded (injected into
 * an already-open tab) earlier edits cannot be told apart from script-set
 * values, so such changes are reported as "unknown", never "clean".
 *
 * Some frameworks (React) keep a field's default in step with what is typed,
 * so "differs from its default" misses those edits. A field the user is about
 * to edit (focus, beforeinput, pointer or key down) also has a fingerprint of
 * its state noted, again at each of these until the first edit (a page may
 * fill a field it focused itself); an edited field whose state differs from
 * it counts as changed. Only the fingerprint (a 32-bit hash) is kept, never
 * the value; password fields get none.
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

/** Whether a select's current selection differs from what it shows by default. */
function selectChanged(el: HTMLSelectElement): boolean {
  const options = Array.from(el.options);
  if (el.multiple || el.size > 1 || options.some((o) => o.defaultSelected)) {
    return options.some((o) => o.selected !== o.defaultSelected);
  }
  // No explicit default: a drop-down shows its first enabled option.
  const first = options.find((o) => !o.disabled);
  return options.some((o) => o.selected !== (o === first));
}

/** A short, non-reversible fingerprint of a control's state (null = not a tracked control). */
function stateFingerprint(el: Element): string | null {
  let state: string;
  if (el instanceof HTMLInputElement) {
    if (el.type === "hidden" || el.type === "password") return null;
    state = el.type === "checkbox" || el.type === "radio" ? String(el.checked) : el.type === "file" ? String(el.files?.length ?? 0) : el.value;
  } else if (el instanceof HTMLTextAreaElement) state = el.value;
  else if (el instanceof HTMLSelectElement) state = Array.from(el.options, (o) => (o.selected ? "1" : "0")).join("");
  else return null;
  // FNV-1a, 32 bits: enough to tell "changed" from "the same". Not a secure hash; it never leaves this module.
  let h = 0x811c9dc5;
  for (let i = 0; i < state.length; i++) h = Math.imul(h ^ state.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** Whether a form control's state differs from its default (null = not a tracked control). */
function controlChanged(el: Element): boolean | null {
  if (el instanceof HTMLInputElement) {
    if (el.type === "hidden" || el.disabled || el.readOnly) return null;
    if (el.type === "checkbox" || el.type === "radio") return el.checked !== el.defaultChecked;
    if (el.type === "file") return !!el.files && el.files.length > 0;
    return el.value !== el.defaultValue;
  }
  if (el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) return null;
    return el.value !== el.defaultValue;
  }
  if (el instanceof HTMLSelectElement) return el.disabled ? null : selectChanged(el);
  return null;
}

export interface ActivityMonitorOptions {
  /** Whether an event came from the user (default: `event.isTrusted`). */
  isUserEvent?: (e: Event) => boolean;
  /** Whether monitoring began after the page loaded (default: from document.readyState at start). */
  lateStart?: boolean;
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
  /** Controls the user edited. Elements only — never their values. */
  private readonly edited = new WeakSet<Element>();
  /** Each control's state just before the user first went to edit it, as a fingerprint (stateFingerprint). */
  private readonly before = new WeakMap<Element, string>();
  private readonly isUserEvent: (e: Event) => boolean;
  private lateStart = false;

  constructor(
    private readonly doc: Document,
    private readonly opts: ActivityMonitorOptions = {},
  ) {
    this.isUserEvent = opts.isUserEvent ?? ((e) => e.isTrusted);
  }

  start() {
    this.lateStart = this.opts.lateStart ?? this.doc.readyState !== "loading";
    const now = () => performance.now();
    const listen = { capture: true, passive: true } as const;
    const userEdit = (e: Event) => {
      if (!this.isUserEvent(e)) return; // page scripts dispatching events are not user edits
      this.lastInput = now();
      const target = e.target;
      if (!(target instanceof Element)) return;
      if ((target as HTMLElement).isContentEditable) this.editableTouched = true;
      else this.edited.add(target);
    };
    this.doc.addEventListener(
      "keydown",
      (e) => {
        if (!this.isUserEvent(e)) return;
        if (isEditable(e.target) || (e.target as HTMLElement)?.isContentEditable) this.lastKey = now();
      },
      listen,
    );
    // Before the first edit of a field: note its state, to compare with later.
    const aboutToEdit = (e: Event) => {
      // Until the first edit: a page may still fill a field after focusing it itself.
      if (!this.isUserEvent(e) || !(e.target instanceof Element) || this.edited.has(e.target)) return;
      const print = stateFingerprint(e.target);
      if (print !== null) this.before.set(e.target, print);
    };
    for (const type of ["focusin", "beforeinput", "pointerdown", "keydown"]) this.doc.addEventListener(type, aboutToEdit, listen);
    this.doc.addEventListener("input", userEdit, listen);
    this.doc.addEventListener("change", userEdit, listen);
    this.doc.addEventListener("compositionstart", () => (this.composing = true), listen);
    this.doc.addEventListener(
      "compositionend",
      () => {
        this.composing = false;
        this.lastInput = now();
      },
      listen,
    );
    this.doc.addEventListener("pointerdown", () => (this.lastPointer = now()), listen);
    this.doc.addEventListener("pointermove", () => (this.lastPointer = now()), listen);
    this.doc.addEventListener("wheel", () => (this.lastScroll = now()), listen);
    this.doc.addEventListener("scroll", () => (this.lastScroll = now()), listen);
    this.doc.addEventListener(
      "submit",
      (e) => {
        if (e.target instanceof HTMLFormElement) this.submittedForms.add(e.target);
      },
      listen,
    );
  }

  /**
   * Conservative dirty check: never reports "clean" when unsure.
   * - a changed control the user edited → "dirty"
   * - a changed control nobody edited → set by the page's own scripts; ignored,
   *   unless monitoring started late (earlier edits unknowable) → "unknown"
   */
  dirtyState(): ActivitySnapshot["dirty"] {
    const controls = this.doc.querySelectorAll("input, textarea, select");
    let checked = 0;
    let ambiguous = false;
    for (const el of Array.from(controls)) {
      if (++checked > MAX_CONTROLS) return "unknown";
      const form = (el as HTMLInputElement).form;
      if (form && this.submittedForms.has(form)) continue;
      const changed = controlChanged(el);
      if (changed === null || (!changed && !this.changedSinceFocus(el))) continue;
      if (this.edited.has(el)) return "dirty";
      if (this.lateStart) ambiguous = true;
    }
    // contenteditable edits cannot be compared to a saved state.
    return ambiguous || this.editableTouched ? "unknown" : "clean";
  }

  /** An edited control that no longer matches its state from before the edit (its default may have followed the typing). */
  private changedSinceFocus(el: Element): boolean {
    const before = this.before.get(el);
    return before !== undefined && this.edited.has(el) && stateFingerprint(el) !== before;
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
