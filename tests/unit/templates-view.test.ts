// @vitest-environment jsdom
/** Dashboard → Templates: fill in the blanks, see the rule in words, create it. */
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TemplatesView } from "@/ui/dashboard/TemplatesView";
import { takeBuilderDraft } from "@/ui/dashboard/templates";
import { DEFAULT_SETTINGS } from "@/core/defaults";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { method: string; params: unknown }[] = [];
let tabOverride: { mode: string } | null = null;
let createdId: string | null = null;
let existingRules: unknown[] = [];
let stopAfterDefault: number | null = null;
let otherRuleWins = false;
const permissionsRequest = vi.fn(async (_p: unknown) => true);
const TABS = [
  { id: 7, windowId: 1, index: 0, title: "Item 42", url: "https://shop.example.com/item/42", active: true, discarded: false },
  { id: 8, windowId: 1, index: 1, title: "Settings", url: "chrome://settings", active: false, discarded: false },
];
(globalThis as { chrome?: unknown }).chrome = {
  runtime: {
    sendMessage: async (m: { method: string; params: { rule?: { name: string } } }) => {
      calls.push({ method: m.method, params: m.params });
      const result =
        m.method === "listTabs"
          ? TABS
          : m.method === "listRules"
            ? existingRules
            : m.method === "getOverview"
              ? { settings: { ...DEFAULT_SETTINGS, defaultStopAfterMinutes: stopAfterDefault } }
              : m.method === "createRule"
                ? ((createdId = "r9"), { id: "r9", ...m.params.rule })
                : m.method === "getTabState"
                  ? { override: tabOverride, resolution: otherRuleWins ? { controllerId: "old", controllerName: "Stay signed in: shop.example.com" } : { controllerId: createdId, controllerName: createdId ? "new" : null } }
                  : { ok: true };
      return { ok: true, result };
    },
  },
  permissions: { request: permissionsRequest },
};

let root: Root;
let el: HTMLDivElement;
const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
beforeEach(async () => {
  calls.length = 0;
  tabOverride = null;
  createdId = null;
  existingRules = [];
  stopAfterDefault = null;
  otherRuleWins = false;
  permissionsRequest.mockClear();
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(createElement(TemplatesView)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
});
const text = () => el.textContent ?? "";
const button = (label: string | RegExp) =>
  [...el.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? "")));
const click = async (b: HTMLButtonElement | undefined) => {
  if (!b) throw new Error(`button missing in: ${text()}`);
  await act(async () => b.click());
  await tick();
};
const useTemplate = async (title: string) => {
  const card = [...el.querySelectorAll("article")].find((a) => a.textContent?.includes(title))!;
  await click(card.querySelector("button")!);
  await tick();
};
const called = (method: string) => calls.filter((c) => c.method === method).map((c) => c.params);

describe("Templates page", () => {
  it("lists the five templates in plain words", () => {
    expect(el.querySelectorAll("article")).toHaveLength(5);
    expect(text()).toContain("Tell me when it's back in stock");
    expect(text()).toContain("You fill in: the page, the text to look for");
  });

  it("back in stock: defaults to an open web tab, describes the rule, asks for access, creates it and hands the tab over", async () => {
    tabOverride = { mode: "custom" };
    await useTemplate("back in stock");
    const select = el.querySelector<HTMLSelectElement>(".dialog select")!;
    expect(select.value).toBe("7"); // chrome:// tabs are not offered
    expect([...select.options].map((o) => o.text)).toEqual(["Item 42 · shop.example.com/item/42 (open tab)", "Type an address…"]);
    expect(text()).toContain("Refresh shop.example.com/item/42 every 1 min until “In stock” appears, then stop and notify you with a sound.");
    await click(button("5 min"));
    await click(button("Create and start"));
    await tick();
    expect(permissionsRequest).toHaveBeenCalledWith({ origins: ["https://shop.example.com/*"] });
    const [created] = called("createRule") as { rule: { trigger: unknown; enabled: boolean } }[];
    expect(created!.rule).toMatchObject({ enabled: true, trigger: { type: "interval", seconds: 300 } });
    expect(called("clearTabOverride")).toEqual([{ tabId: 7 }]);
    expect(called("runNow")).toEqual([{ tabId: 7 }]);
    expect(el.querySelector(".dialog")).toBeNull();
    expect(text()).toContain("Created “Back in stock: shop.example.com/item/42”");
  });

  it("declining site access creates nothing", async () => {
    permissionsRequest.mockResolvedValueOnce(false);
    await useTemplate("back in stock");
    await click(button("Create and start"));
    await tick();
    expect(called("createRule")).toEqual([]);
    expect(text()).toContain("needs access to shop.example.com");
  });

  it("typed address and working hours (end must be after start)", async () => {
    await useTemplate("dashboard fresh");
    const select = el.querySelector<HTMLSelectElement>(".dialog select")!;
    await act(async () => {
      select.value = "__address__";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const type = async (input: HTMLInputElement, v: string) =>
      act(async () => {
        set.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await type(el.querySelector<HTMLInputElement>('input[aria-label="Address"]')!, "grafana.example.com/d/ops");
    expect(text()).toContain("Refresh grafana.example.com/d/ops every 5 to 6 min, Monday to Friday, 08:00 to 18:00.");
    await type(el.querySelector<HTMLInputElement>('input[aria-label="Until"]')!, "07:00");
    expect(text()).toContain("The end time must be after the start time.");
    expect(button("Create and start")!.disabled).toBe(true);
  });

  it("Customise in the Rule Builder hands over the filled-in rule, switched off for review", async () => {
    await useTemplate("Stay signed in");
    await click(button(/Customise in the Rule Builder/));
    expect(location.hash).toBe("#/builder?draft=template");
    const draft = takeBuilderDraft()!;
    expect(draft).toMatchObject({ name: "Stay signed in: shop.example.com", enabled: false, trigger: { seconds: 600 } });
    expect(takeBuilderDraft()).toBeNull(); // handed over once
  });

  it("Escape closes the form", async () => {
    await useTemplate("build fails");
    await act(async () => void el.querySelector(".dialog")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(el.querySelector(".dialog")).toBeNull();
  });

  it("Stop watching after: starts from the Settings default, can be changed, and becomes the rule's time limit", async () => {
    stopAfterDefault = 20;
    await useTemplate("back in stock");
    const select = [...el.querySelectorAll<HTMLSelectElement>(".dialog select")].find((x) => [...x.options].some((o) => o.text === "No limit"))!;
    expect(select.value).toBe("20");
    expect(text()).toContain("If it hasn't appeared after 20 min, it stops and tells you.");
    await act(async () => {
      select.value = "60";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(button("Create and start"));
    await tick();
    const [created] = called("createRule") as { rule: { limits?: { maxDurationSeconds: number } } }[];
    expect(created!.rule.limits).toEqual({ maxDurationSeconds: 3600 });
  });

  it("no limit by default, and templates that don't wait for anything have no Stop watching choice", async () => {
    await useTemplate("back in stock");
    await click(button("Create and start"));
    await tick();
    const [created] = called("createRule") as { rule: { limits?: unknown } }[];
    expect(created!.rule.limits).toBeUndefined();
  });

  it("outranks rules already matching the page", async () => {
    existingRules = [
      { id: "old", name: "Stay signed in", enabled: true, priority: 3, meta: { draft: false }, target: { patterns: [{ type: "domain", value: "shop.example.com" }] } },
      { id: "other", name: "Elsewhere", enabled: true, priority: 9, meta: { draft: false }, target: { patterns: ["https://other.example.com/*"] } },
    ];
    await useTemplate("back in stock");
    await click(button("Create and start"));
    await tick();
    const [created] = called("createRule") as { rule: { priority: number } }[];
    expect(created!.rule.priority).toBe(4); // above the matching rule, not the unrelated one
  });

  it("says so when another rule still controls the tab", async () => {
    otherRuleWins = true;
    await useTemplate("back in stock");
    await click(button("Create and start"));
    await tick();
    expect(text()).toContain("still controls that tab");
    expect(called("runNow")).toEqual([]);
  });

  it("each Use template button names its template for screen readers", () => {
    const labels = [...el.querySelectorAll("article button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toContain("Use template: Tell me when a build fails");
    expect(new Set(labels).size).toBe(5);
  });
});
