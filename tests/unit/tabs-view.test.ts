// @vitest-environment jsdom
/** Tabs dashboard rows: the action buttons each status offers, and what they call. */
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TabsView } from "@/ui/dashboard/TabsView";
import { DialogProvider } from "@/ui/shared/dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (id: number, status: string | null, extra: Record<string, unknown> = {}) => ({
  tab: { id, title: `Tab ${id}`, url: `https://t${id}.com/`, restricted: false },
  runtime: status ? { tabId: id, status, refreshCount: 2, nextDueAt: null } : null,
  status: status ?? "idle",
  controllerId: null,
  controllerName: null,
  ...extra,
});
const overview = {
  settings: { paused: false, enabled: true, defaultSafety: { pauseWhileTyping: true, protectUnsavedChanges: true, onActivityUnavailable: "pause" } },
  counts: {},
  conflicts: [],
  tabs: [
    row(1, "scheduled", { controllerId: "r1", controllerName: "Watch" }),
    row(2, "paused_user"),
    row(3, "stopped"),
    row(4, null),
    row(5, "idle", { controllerId: "tab:5" }),
    row(7, "scheduled", { controllerId: "tab:7", needsAccess: true }),
    { ...row(6, null), tab: { id: 6, title: "Tab 6", url: "chrome://settings", restricted: true } },
  ],
};
const calls: { method: string; params: unknown }[] = [];
/** Sites JustRefresh may read (what Chrome's prompt granted). */
const granted = new Set<string>();
const permissionsRequest = vi.fn(async (p: { origins: string[] }) => {
  for (const o of p.origins) if (o !== "https://t4.com/*") granted.add(o); // t4.com is declined
  return false;
});
(globalThis as { chrome?: unknown }).chrome = {
  permissions: { request: permissionsRequest, contains: async (p: { origins: string[] }) => p.origins.every((o) => granted.has(o)) },
  runtime: {
    sendMessage: vi.fn(async (m: { method: string; params: unknown }) => {
      if (m.method !== "getOverview") calls.push({ method: m.method, params: m.params });
      return { ok: true, result: m.method === "getOverview" ? overview : null };
    }),
  },
};

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const rowOf = (id: number) => [...el.querySelectorAll("tbody tr")].find((tr) => tr.textContent?.includes(`Tab ${id}`))!;
const buttons = (id: number) => [...rowOf(id).querySelectorAll("button")].map((b) => b.textContent);
const click = async (id: number, label: string) => {
  await act(async () => [...rowOf(id).querySelectorAll("button")].find((b) => b.textContent === label)!.click());
  await flush();
};

beforeEach(async () => {
  calls.length = 0;
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(createElement(DialogProvider, null, createElement(TabsView))));
  await flush();
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
});

it("offers the buttons that fit each tab's state", () => {
  expect(buttons(1)).toEqual(["Pause", "Stop", "Refresh"]);
  expect(buttons(2)).toEqual(["Resume", "Refresh"]);
  expect(buttons(3)).toEqual(["Start", "Refresh"]);
  expect(buttons(4)).toEqual(["Start", "Refresh"]);
  expect(buttons(5)).toEqual(["Start", "Refresh", "Reset"]);
  expect(buttons(6)).toEqual([]);
  expect(rowOf(1).querySelector("a")?.getAttribute("href")).toBe("#/builder/r1");
  expect(rowOf(5).textContent).toContain("Tab-specific");
});

it("resumes paused or stopped tabs and starts the others", async () => {
  await click(2, "Resume");
  await click(3, "Start");
  await click(4, "Start");
  await click(1, "Pause");
  await click(5, "Reset");
  expect(calls).toEqual([
    { method: "resumeTab", params: { tabId: 2 } },
    { method: "resumeTab", params: { tabId: 3 } },
    { method: "startTab", params: { tabId: 4 } },
    { method: "pauseTab", params: { tabId: 1 } },
    { method: "clearTabOverride", params: { tabId: 5 } },
  ]);
});

it("says when a running tab can't refresh for lack of site access, and offers to allow it", async () => {
  expect(rowOf(7).textContent).toContain("No site access: won't refresh until you allow it");
  await act(async () => [...rowOf(7).querySelectorAll("button")].find((b) => b.textContent === "Allow access")!.click());
  expect(permissionsRequest).toHaveBeenCalledWith({ origins: ["https://t7.com/*"] });
  expect(rowOf(1).textContent).not.toContain("No site access");
});

it("a bulk start leaves a declined site alone, and offers to start it without protection", async () => {
  granted.clear();
  const tick = async (id: number) => act(async () => rowOf(id).querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await tick(3);
  await tick(4);
  await act(async () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Start refreshing")!.click());
  await flush();
  await flush();
  expect(calls.filter((c) => c.method === "startTab").map((c) => (c.params as { tabId: number }).tabId)).toEqual([3]);
  expect(el.textContent).toContain("Not started: JustRefresh wasn't allowed to read t4.com");
  await act(async () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Start without protection")!.click());
  await flush();
  const started = calls.filter((c) => c.method === "startTab").map((c) => c.params);
  expect(started.at(-1)).toMatchObject({ tabId: 4, safety: { onActivityUnavailable: "refresh" } });
  expect(el.textContent).not.toContain("Not started");
});

it("a tab whose timer wouldn't need to see the page isn't asked about: it just starts", async () => {
  const r4 = overview.tabs.find((t) => t.tab.id === 4)!;
  (r4 as Record<string, unknown>).timerNeedsAccess = false;
  try {
    await act(async () => root.render(createElement(DialogProvider, null, createElement(TabsView))));
    await flush();
    permissionsRequest.mockClear();
    await act(async () => rowOf(4).querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Start refreshing")!.click());
    await flush();
    await flush();
    expect(permissionsRequest).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method === "startTab").map((c) => (c.params as { tabId: number }).tabId)).toEqual([4]);
  } finally {
    delete (r4 as Record<string, unknown>).timerNeedsAccess;
  }
});
