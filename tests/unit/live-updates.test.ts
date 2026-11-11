// @vitest-environment jsdom
/**
 * Push instead of poll: pages re-fetch when Chrome reports a change (storage,
 * tabs, site access), not on a timer, and not while hidden.
 */
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { topicsForStorage } from "@/ui/shared/live";
import { useApi } from "@/ui/shared/hooks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fn = (...a: unknown[]) => void;
const listeners: Record<string, Fn[]> = {};
const event = (name: string) => ({ addListener: (f: Fn) => (listeners[name] ??= []).push(f), removeListener: () => undefined });
const fire = (name: string, ...args: unknown[]) => (listeners[name] ?? []).forEach((f) => f(...args));
const calls: string[] = [];
/** Delay (ms) for the answer to each call, by call number (1-based); default 0. */
let delays: Record<number, number> = {};
(globalThis as { chrome?: unknown }).chrome = {
  runtime: {
    sendMessage: async (m: { method: string }) => {
      calls.push(m.method);
      const n = calls.length;
      await new Promise((r) => setTimeout(r, delays[n] ?? 0));
      return { ok: true, result: { n } };
    },
  },
  storage: { onChanged: event("storage") },
  tabs: { onUpdated: event("tabs.updated"), onCreated: event("tabs.created"), onRemoved: event("tabs.removed"), onReplaced: event("tabs.replaced") },
  permissions: { onAdded: event("perm.added"), onRemoved: event("perm.removed") },
};

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

describe("which changes concern which data", () => {
  it("maps storage keys to topics", () => {
    expect(topicsForStorage(["config", "config.backup"], "local")).toEqual(["config"]);
    expect(topicsForStorage(["rt:7", "rt:9", "bridge.status"], "session")).toEqual(["runtime", "bridge"]);
    expect(topicsForStorage(["history", "audit"], "local")).toEqual(["history", "audit"]);
    expect(topicsForStorage(["config"], "session")).toEqual([]);
  });
});

describe("useApi with live topics", () => {
  function Probe({ live }: { live: ("runtime" | "tabs" | "access" | "config")[] }) {
    const { data } = useApi<{ n: number }>("getOverview", undefined, { live });
    return createElement("span", null, String(data?.n ?? ""));
  }
  let el: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(async () => {
    calls.length = 0;
    delays = {};
    el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root.render(createElement(Probe, { live: ["runtime", "tabs", "access"] })));
    await wait(0);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    el.remove();
  });

  it("fetches once, then never on a timer", async () => {
    expect(calls).toEqual(["getOverview"]);
    await wait(300);
    expect(calls).toHaveLength(1);
  });

  it("re-fetches once for a burst of changes it cares about", async () => {
    fire("storage", { "rt:1": {}, "rt:2": {} }, "session");
    fire("storage", { "rt:1": {} }, "session");
    fire("tabs.updated", 1, { title: "New" });
    await wait(700);
    expect(calls).toEqual(["getOverview", "getOverview"]);
  });

  it("ignores changes it doesn't care about, and tab loading progress", async () => {
    fire("storage", { history: {} }, "local");
    fire("tabs.updated", 1, { status: "loading" });
    await wait(200);
    expect(calls).toHaveLength(1);
    fire("perm.added", { origins: ["https://x.test/*"] });
    await wait(700);
    expect(calls).toHaveLength(2);
  });

  it("while the page is hidden it waits, then catches up when shown", async () => {
    const vis = (v: "hidden" | "visible") =>
      act(async () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    await vis("hidden");
    fire("storage", { "rt:1": {} }, "session");
    await wait(200);
    expect(calls).toHaveLength(1);
    await vis("visible");
    await wait(0);
    expect(calls).toHaveLength(2);
  });

  it("a constant stream of changes costs at most one fetch per half second", async () => {
    for (let i = 0; i < 30; i++) {
      fire("storage", { [`rt:${i}`]: {} }, "session");
      await wait(50);
    }
    await wait(700);
    // 1.5 s of changes + the trailing fetch: about 4, never 30.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it("an older answer arriving last doesn't overwrite a newer one", async () => {
    // Call 2 (a change) is slow; call 3 (a later change) is fast and lands first.
    delays = { 2: 900 };
    fire("storage", { "rt:1": {} }, "session");
    await wait(700); // call 2 starts and is in flight
    fire("storage", { "rt:1": {} }, "session"); // queued behind it
    await wait(1600);
    expect(calls).toHaveLength(3);
    expect(el.textContent).toBe("3");
  });
});
