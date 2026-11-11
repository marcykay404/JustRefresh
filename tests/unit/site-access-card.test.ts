// @vitest-environment jsdom
/**
 * The Settings site-access card stays short however many sites were granted:
 * summary, sites in use first, collapsed list, filter, and "Remove unused".
 */
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SiteAccess } from "@/ui/dashboard/SettingsView";
import { DialogProvider } from "@/ui/shared/dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let granted: string[] = [];
const remove = vi.fn(async ({ origins }: { origins: string[] }) => {
  granted = granted.filter((o) => !origins.includes(o));
  return true;
});
const overview = {
  tabs: [
    { tab: { url: "https://site-07.com/" }, status: "scheduled" },
    { tab: { url: "https://site-03.com/" }, status: "idle" },
  ],
};
const rules = [{ name: "Watch", target: { patterns: ["https://site-11.com/*"] } }];
(globalThis as { chrome?: unknown }).chrome = {
  runtime: {
    sendMessage: vi.fn(async (m: { method: string }) => ({ ok: true, result: m.method === "getOverview" ? overview : m.method === "listRules" ? rules : null })),
  },
  permissions: {
    getAll: async () => ({ origins: [...granted] }),
    remove,
    request: async () => true,
    onAdded: { addListener() {}, removeListener() {} },
    onRemoved: { addListener() {}, removeListener() {} },
  },
};

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const rows = () => [...el.querySelectorAll(".site-row code")].map((c) => c.textContent);
const button = (text: RegExp) => [...el.querySelectorAll("button")].find((b) => text.test(b.textContent ?? ""));

beforeEach(async () => {
  granted = Array.from({ length: 12 }, (_, i) => `https://site-${String(i + 1).padStart(2, "0")}.com/*`);
  remove.mockClear();
  el = document.createElement("div");
  root = createRoot(el);
  await act(async () => root.render(createElement(DialogProvider, null, createElement(SiteAccess))));
  await flush();
});
afterEach(async () => act(async () => root.unmount()));

describe("Settings site-access card with many sites", () => {
  it("summarises, puts sites in use first and shows only five rows until expanded", async () => {
    expect(el.textContent).toContain("Allowed on 12 sites · 2 in use");
    expect(rows()).toEqual(["site-07.com", "site-11.com", "site-01.com", "site-02.com", "site-03.com"]);
    expect(el.textContent).toContain("Used by 1 tab");
    expect(el.textContent).toContain("Used by rule “Watch”");
    await act(async () => button(/Show all 12 sites/)!.click());
    expect(rows()).toHaveLength(12);
  });

  it("filters by name, past eight sites", async () => {
    const input = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "site-1");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows()).toEqual(["site-11.com", "site-10.com", "site-12.com"]);
  });

  it("Remove unused revokes only sites no running tab or rule uses", async () => {
    await act(async () => button(/Remove unused \(10\)/)!.click());
    const dialog = el.querySelector("[aria-modal=true]")!;
    expect(dialog.textContent).toContain("Remove access to 10 unused sites?");
    expect(dialog.querySelectorAll("li")).toHaveLength(10);
    expect(remove).not.toHaveBeenCalled();
    await act(async () => button(/^Remove access$/)!.click());
    const removed = remove.mock.calls[0]![0].origins;
    expect(removed).toHaveLength(10);
    expect(removed).not.toContain("https://site-07.com/*");
    expect(removed).not.toContain("https://site-11.com/*");
  });
});
