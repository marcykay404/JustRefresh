// @vitest-environment jsdom
/**
 * The simpler popup: one-tap interval chips + Start, Stop while refreshing,
 * rule tabs described in words without interval chips, rarely used actions
 * under More, "Refresh until something appears", and the protection line.
 */
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Popup, protectedWhile } from "@/ui/popup/Popup";
import { DialogProvider } from "@/ui/shared/dialog";
import { DEFAULT_SAFETY, DEFAULT_SETTINGS } from "@/core/defaults";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("protectedWhile", () => {
  const off = { pauseWhileTyping: false, protectUnsavedChanges: false, pauseOnMouse: false, pauseOnScroll: false };
  it("names the protections that are on", () => {
    expect(protectedWhile({ ...off, pauseWhileTyping: true })).toBe("while you're typing");
    expect(protectedWhile({ ...off, pauseWhileTyping: true, protectUnsavedChanges: true })).toBe("while you're typing or you have unsaved form changes");
    expect(protectedWhile({ ...off, pauseWhileTyping: true, protectUnsavedChanges: true, pauseOnScroll: true })).toBe(
      "while you're typing, you have unsaved form changes or you're scrolling",
    );
    expect(protectedWhile(off)).toBe("");
  });
});

type Case = {
  hostAccess?: boolean;
  status?: string | null;
  protection?: boolean;
  source?: "tab" | "rule" | null;
  excluded?: boolean;
};
let current: Case;
const calls: { method: string; params: unknown }[] = [];
const URL_ = "https://www.youtube.com/watch?v=x";

const tabState = () => {
  const c = { hostAccess: true, status: null as string | null, protection: true, source: null as Case["source"], ...current };
  return {
    tab: { id: 1, windowId: 1, index: 0, title: "Video", url: URL_, active: true, discarded: false },
    runtime: c.status ? { tabId: 1, status: c.status, refreshCount: 3, nextDueAt: Date.now() + 60_000, lastAttemptAt: Date.now() - 1000 } : null,
    statusLabel: "",
    resolution: {
      kind: c.excluded ? "tab_excluded" : c.source ? "controller" : "none",
      controllerId: c.source === "rule" ? "r1" : c.source ? "tab:1" : null,
      controllerName: c.source === "rule" ? "Cheap flight watch" : null,
      source: c.source,
      candidates: [],
    },
    override: c.excluded ? { mode: "excluded" } : c.source === "tab" ? { mode: "custom", intervalSeconds: 300 } : null,
    interval: 300,
    safety: { ...DEFAULT_SAFETY, pauseWhileTyping: c.protection, protectUnsavedChanges: c.protection },
    hostAccess: c.hostAccess,
  };
};
const RULE = {
  id: "r1",
  name: "Cheap flight watch",
  trigger: { type: "interval", seconds: 600 },
  stopWhen: { type: "dom.text", operator: "contains", value: "S$ 3" },
  actions: { onMatched: [{ type: "stopRefresh" }, { type: "notify" }], onNotMatched: [{ type: "refresh" }] },
};
const permissionsRequest = vi.fn(async (_p: unknown) => true);
(globalThis as { chrome?: unknown }).chrome = {
  tabs: { query: async () => [{ id: 1 }], create: vi.fn() },
  runtime: {
    getURL: (p: string) => p,
    sendMessage: async (m: { method: string; params: unknown }) => {
      calls.push({ method: m.method, params: m.params });
      const result =
        m.method === "getTabState"
          ? tabState()
          : m.method === "getRule"
            ? RULE
            : m.method === "getOverview"
              ? { settings: DEFAULT_SETTINGS, counts: { running: 2, paused: 1, stopped: 0, excluded: 0 }, pendingApprovals: 0, pendingAgents: 0 }
              : m.method === "createRule"
                ? { id: "new" }
                : { ok: true };
      return { ok: true, result };
    },
  },
  permissions: { request: permissionsRequest },
};

let root: Root | undefined;
let el: HTMLDivElement;
const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
async function render(c: Case) {
  current = c;
  calls.length = 0;
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(DialogProvider, null, createElement(Popup))));
  await tick();
  await tick();
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  el?.remove();
  permissionsRequest.mockClear();
});
const text = () => el.textContent ?? "";
const button = (label: string | RegExp) =>
  [...el.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? "")));
const click = async (label: string | RegExp) => {
  const b = button(label);
  if (!b) throw new Error(`No button ${label} in: ${text()}`);
  await act(async () => b.click());
  await tick();
};
const type = async (input: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const called = (method: string) => calls.filter((c) => c.method === method).map((c) => c.params);

describe("simpler popup", () => {
  it("off: pick an interval with one tap, then one Start button", async () => {
    await render({});
    expect(text()).toContain("youtube.com");
    expect(text()).toContain("Refresh this tab every");
    expect(button("Start refreshing every 5 min")).toBeTruthy();
    await click("15 min");
    await click("Start refreshing every 15 min");
    expect(called("startTab")).toEqual([{ tabId: 1, intervalSeconds: 900 }]);
  });

  it("custom interval: typed value and unit, with the 30-second floor explained", async () => {
    await render({});
    await click("Custom…");
    const input = el.querySelector<HTMLInputElement>("#custom-interval")!;
    await type(input, "0.25");
    expect(text()).toContain("The shortest interval is 30 seconds");
    expect(button(/^Start refreshing/)!.disabled).toBe(true);
    await type(input, "2");
    await click("Start refreshing every 2 min");
    expect(called("startTab")).toEqual([{ tabId: 1, intervalSeconds: 120 }]);
  });

  it("refreshing: countdown and a single Stop (no separate Pause)", async () => {
    await render({ source: "tab", status: "scheduled" });
    expect(text()).toContain("Refreshing every 5 min");
    expect(text()).toContain("Next refresh in");
    expect(text()).toContain("Refreshed 3 times");
    expect(button("Pause")).toBeUndefined();
    await click("Stop");
    expect(called("stopTab")).toEqual([{ tabId: 1 }]);
  });

  it("refreshing: Change interval reuses the chips", async () => {
    await render({ source: "tab", status: "scheduled" });
    await click("Change interval");
    await click("1 hour");
    await click("Refresh every 1 hour");
    expect(called("startTab")).toEqual([{ tabId: 1, intervalSeconds: 3600 }]);
  });

  it("rule tab: the rule in words, Check now, and no interval chips", async () => {
    await render({ source: "rule", status: "scheduled" });
    expect(text()).toContain("Cheap flight watch");
    expect(text()).toContain("Refreshing every 10 min until “S$ 3” appears, then notify me");
    expect(button("5 min")).toBeUndefined();
    expect(button("Change interval")).toBeUndefined();
    await click("Check now");
    expect(called("runNow")).toEqual([{ tabId: 1 }]);
    await click(/^More/);
    expect(text()).not.toContain("Refresh until something appears");
  });

  it("More holds the rarely used actions", async () => {
    await render({});
    expect(text()).not.toContain("Never auto-refresh this tab");
    await click(/^More/);
    expect(text()).toContain("Refresh until something appears…");
    expect(text()).toContain("Make a rule for youtube.com…");
    await click(/Never auto-refresh this tab/);
    expect(called("excludeTab")).toEqual([{ tabId: 1 }]);
  });

  it("excluded tab: says so and offers to allow it again", async () => {
    await render({ excluded: true });
    expect(text()).toContain("never auto-refresh");
    await click("Allow auto-refresh again");
    expect(called("includeTab")).toEqual([{ tabId: 1 }]);
  });

  it("Refresh until something appears: creates a rule for this page, hands the tab over and checks at once", async () => {
    await render({ source: "tab", status: "scheduled", hostAccess: false });
    await click(/^More/);
    await click(/Refresh until something appears/);
    await type(el.querySelector<HTMLInputElement>('input[aria-label="Text to look for"]')!, "In stock");
    await click("1 min");
    await click("Start watching");
    await tick();
    expect(permissionsRequest).toHaveBeenCalledWith({ origins: ["https://www.youtube.com/*"] });
    const [created] = called("createRule") as { rule: { trigger: unknown; stopWhen: unknown; target: unknown } }[];
    expect(created!.rule.trigger).toEqual({ type: "interval", seconds: 60 });
    expect(created!.rule.stopWhen).toMatchObject({ operator: "contains", value: "In stock" });
    expect(created!.rule.target).toMatchObject({ patterns: [{ type: "exact", value: URL_ }] });
    expect(called("clearTabOverride")).toEqual([{ tabId: 1 }]);
    expect(called("runNow")).toEqual([{ tabId: 1 }]);
  });

  it("Refresh until: declining site access sets nothing up", async () => {
    permissionsRequest.mockResolvedValueOnce(false);
    await render({ hostAccess: false });
    await click(/^More/);
    await click(/Refresh until something appears/);
    await type(el.querySelector<HTMLInputElement>('input[aria-label="Text to look for"]')!, "In stock");
    await click("Start watching");
    await tick();
    expect(called("createRule")).toEqual([]);
    expect(text()).toContain("needs access to youtube.com");
  });
});

describe("popup protection line", () => {
  it("refreshing with access: says protection works here", async () => {
    await render({ source: "tab", status: "scheduled" });
    expect(text()).toContain("Protected: waits while you're typing or you have unsaved form changes");
    expect(text()).not.toContain("Allow access");
  });

  it("not refreshing yet, with access: says what it will do", async () => {
    await render({});
    expect(text()).toContain("Will wait while you're typing");
  });

  it("without access: asks for access instead", async () => {
    await render({ source: "tab", status: "scheduled", hostAccess: false });
    expect(text()).toContain("can't see inside youtube.com yet");
    expect(button("Allow access")).toBeTruthy();
    expect(text()).not.toContain("Protected:");
  });

  it("protection off: says so and never asks for access", async () => {
    await render({ source: "tab", status: "scheduled", hostAccess: false, protection: false });
    expect(text()).toContain("Protection off");
    expect(button("Allow access")).toBeUndefined();
  });

  it("waiting for unsaved changes: plain sentence and Refresh anyway", async () => {
    await render({ source: "tab", status: "paused_unsaved" });
    expect(text()).toContain("form you've started filling in");
    expect(text()).toContain("Waiting for you");
    expect(button("Refresh anyway")).toBeTruthy();
  });
});
