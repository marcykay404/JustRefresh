// @vitest-environment jsdom
/**
 * Dashboard polling must pause while the page is hidden: every poll is a
 * message that wakes the extension's service worker.
 */
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useApi } from "@/ui/shared/hooks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
const setVisibility = async (v: DocumentVisibilityState) => {
  visibility = v;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};

const sendMessage = vi.fn(async (msg: { method: string }) => ({ ok: true, result: msg.method }));
(globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } };
const calls = (method: string) => sendMessage.mock.calls.filter(([m]) => m.method === method).length;

function Probe({ method, pollMs }: { method: string; pollMs?: number }) {
  useApi(method, undefined, { pollMs });
  return null;
}

let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  sendMessage.mockClear();
  visibility = "visible";
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});
const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

describe("useApi polling and page visibility", () => {
  it("polls while visible, pauses while hidden, and catches up on return", async () => {
    await act(async () => root.render(createElement(Probe, { method: "listTabs", pollMs: 1000 })));
    expect(calls("listTabs")).toBe(1);
    await advance(3000);
    expect(calls("listTabs")).toBe(4);

    await setVisibility("hidden");
    await advance(10_000);
    expect(calls("listTabs")).toBe(4);

    await setVisibility("visible");
    expect(calls("listTabs")).toBe(5); // immediate refresh on return
    await advance(1000);
    expect(calls("listTabs")).toBe(6);
  });

  it("does not start polling when mounted in a hidden tab", async () => {
    visibility = "hidden";
    await act(async () => root.render(createElement(Probe, { method: "listTabs", pollMs: 1000 })));
    await advance(5000);
    expect(calls("listTabs")).toBe(0);
    await setVisibility("visible");
    expect(calls("listTabs")).toBe(1);
  });

  it("one-off fetches load even when hidden and are not repeated on visibility changes", async () => {
    visibility = "hidden";
    await act(async () => root.render(createElement(Probe, { method: "getOverview" })));
    expect(calls("getOverview")).toBe(1);
    await setVisibility("visible");
    await setVisibility("hidden");
    await advance(10_000);
    expect(calls("getOverview")).toBe(1);
  });
});
