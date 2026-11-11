/**
 * Push instead of poll: extension pages learn about changes from Chrome's own
 * events and re-fetch only then, instead of asking the service worker every
 * few seconds (each poll wakes it).
 *
 *  - config (rules, settings, exclusions, tab overrides, agents, approvals)
 *    → storage.local "config"
 *  - runtime (each tab's run state) → storage.session "rt:*"
 *  - history / audit → storage.local "history" / "audit"
 *  - bridge (desktop app connection) → storage.session "bridge.status"
 *  - tabs → chrome.tabs events
 *  - access (site permissions) → chrome.permissions events
 */
import { AUDIT_KEY, BRIDGE_STATUS_KEY, CONFIG_KEY, HISTORY_KEY, RUNTIME_PREFIX } from "../../storage/keys";

export type Topic = "config" | "runtime" | "history" | "audit" | "bridge" | "tabs" | "access";

type Listener = (topics: ReadonlySet<Topic>) => void;
const listeners = new Set<Listener>();
let pending = new Set<Topic>();
let timer: ReturnType<typeof setTimeout> | null = null;
let wired = false;

/** Changes arriving together (one engine cycle writes several keys) are sent as one. */
const COALESCE_MS = 100;

function emit(topic: Topic) {
  pending.add(topic);
  timer ??= setTimeout(() => {
    const batch = pending;
    pending = new Set();
    timer = null;
    for (const l of [...listeners]) l(batch);
  }, COALESCE_MS);
}

/** Which topics a storage change touches. */
export function topicsForStorage(keys: readonly string[], area: string): Topic[] {
  const out = new Set<Topic>();
  for (const k of keys) {
    if (area === "local" && k === CONFIG_KEY) out.add("config");
    else if (area === "local" && k === HISTORY_KEY) out.add("history");
    else if (area === "local" && k === AUDIT_KEY) out.add("audit");
    else if (area === "session" && k.startsWith(RUNTIME_PREFIX)) out.add("runtime");
    else if (area === "session" && k === BRIDGE_STATUS_KEY) out.add("bridge");
  }
  return [...out];
}

/** Title and address changes matter (lists show them); loading progress alone doesn't. */
function shownTabChange(info: { url?: string; title?: string; status?: string; discarded?: boolean }): boolean {
  return info.url !== undefined || info.title !== undefined || info.status === "complete" || info.discarded !== undefined;
}

/** Add a listener when the API exists (tests and non-extension pages have no chrome.*). */
function listen<F extends (...args: never[]) => void>(event: { addListener(fn: F): void } | undefined, fn: F) {
  event?.addListener(fn);
}

function wire() {
  if (wired) return;
  wired = true;
  const c = (globalThis as { chrome?: typeof chrome }).chrome;
  if (!c) return;
  listen(c.storage?.onChanged, (changes: Record<string, unknown>, area: string) => {
    for (const t of topicsForStorage(Object.keys(changes), area)) emit(t);
  });
  const tabs = () => emit("tabs");
  listen(c.tabs?.onUpdated, (_id: number, info: chrome.tabs.OnUpdatedInfo) => {
    if (shownTabChange(info)) tabs();
  });
  listen(c.tabs?.onCreated, tabs);
  listen(c.tabs?.onRemoved, tabs);
  listen(c.tabs?.onReplaced, tabs);
  const access = () => emit("access");
  listen(c.permissions?.onAdded, access);
  listen(c.permissions?.onRemoved, access);
}

/** Call `fn` when any of `topics` changes. Returns an unsubscribe function. */
export function subscribe(topics: readonly Topic[], fn: () => void): () => void {
  wire();
  const l: Listener = (batch) => {
    if (topics.some((t) => batch.has(t))) fn();
  };
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Test hook: deliver a change as if Chrome had reported it. */
export function _emitForTest(topic: Topic) {
  emit(topic);
}
