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
(globalThis as { chrome?: unknown }).chrome = {
  runtime: {
    sendMessage: async (m: { method: string }) => {
      calls.push(m.method);
      return { ok: true, result: { n: calls.length } };
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
    await wait(200);
    expect(calls).toEqual(["getOverview", "getOverview"]);
  });

  it("ignores changes it doesn't care about, and tab loading progress", async () => {
    fire("storage", { history: {} }, "local");
    fire("tabs.updated", 1, { status: "loading" });
    await wait(200);
    expect(calls).toHaveLength(1);
    fire("perm.added", { origins: ["https://x.test/*"] });
    await wait(200);
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
});
