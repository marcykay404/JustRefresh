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
  /** Resolution kind override: "paused", "disabled" or "url_excluded". */
  kind?: string;
  /** Rules already matching the page (resolution.candidates). */
  candidates?: { id: string; name: string; priority: number }[];
  /** Another rule keeps control after a new rule is created. */
  otherRuleWins?: boolean;
  /** Effective interval when it differs from the tab's own (fast intervals turned off). */
  effective?: number;
  hostAccess?: boolean;
  status?: string | null;
  protection?: boolean;
  source?: "tab" | "rule" | null;
  excluded?: boolean;
};
let current: Case;
/** Set once createRule ran: the new rule then controls the tab. */
let createdRuleId: string | null = null;
let defaultStopAfter: number | null = null;
let refreshNowResult: unknown = { refreshed: true };
const calls: { method: string; params: unknown }[] = [];
const URL_ = "https://www.youtube.com/watch?v=x";

const tabState = () => {
  const c = { hostAccess: true, status: null as string | null, protection: true, source: null as Case["source"], ...current };
  return {
    tab: { id: 1, windowId: 1, index: 0, title: "Video", url: URL_, active: true, discarded: false },
    runtime: c.status ? { tabId: 1, status: c.status, refreshCount: 3, nextDueAt: Date.now() + 60_000, lastAttemptAt: Date.now() - 1000 } : null,
    statusLabel: "",
    resolution: {
      kind: c.kind ?? (c.excluded ? "tab_excluded" : c.source ? "controller" : "none"),
      reason: c.kind === "url_excluded" ? "Excluded by https://www.youtube.com/*" : undefined,
      controllerId: (c.otherRuleWins ? null : createdRuleId) ?? (c.otherRuleWins ? "old" : c.source === "rule" ? "r1" : c.source ? "tab:1" : null),
      controllerName: c.otherRuleWins ? "Older rule" : c.source === "rule" ? "Cheap flight watch" : null,
      source: c.source,
      candidates: c.candidates ?? [],
    },
    override: c.excluded ? { mode: "excluded" } : c.source === "tab" ? { mode: "custom", intervalSeconds: 300 } : null,
    interval: c.effective ?? (c.source === "rule" ? 600 : 300),
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
              ? { settings: { ...DEFAULT_SETTINGS, defaultStopAfterMinutes: defaultStopAfter }, counts: { running: 2, paused: 1, stopped: 0, excluded: 0 }, pendingApprovals: 0, pendingAgents: 0 }
              : m.method === "refreshNow"
                ? refreshNowResult
                : m.method === "createRule"
                ? ((createdRuleId = "new"), { id: "new" })
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
  createdRuleId = null;
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

describe("states where Start can't help", () => {
  it.each([
    ["paused", "All refreshing is paused", "Resume all refreshing", "resumeAll"],
    ["disabled", "JustRefresh is switched off", "Turn auto refresh on", "updateSettings"],
  ])("%s: says so, offers the fix, and no Start or Refresh until", async (kind, title, action, method) => {
    await render({ kind, source: null });
    expect(text()).toContain(title);
    expect(button(/^Start refreshing/)).toBeUndefined();
    await click(/^More/);
    expect(text()).not.toContain("Refresh until something appears");
    await click(action);
    expect(called(method)).toHaveLength(1);
  });

  it("excluded by an exclusion pattern: says which, links to Exclusions", async () => {
    await render({ kind: "url_excluded", source: null });
    expect(text()).toContain("This page is excluded");
    expect(text()).toContain("Excluded by https://www.youtube.com/*");
    expect(button(/^Start refreshing/)).toBeUndefined();
    expect(button("Manage exclusions")).toBeTruthy();
  });
});

describe("rules made from the popup take effect", () => {
  const startUntil = async () => {
    await click(/^More/);
    await click(/Refresh until something appears/);
    await type(el.querySelector<HTMLInputElement>('input[aria-label="Text to look for"]')!, "In stock");
    await click("Start watching");
    await tick();
  };

  it("are created above rules already matching the page", async () => {
    await render({ source: "tab", status: "scheduled", candidates: [{ id: "old", name: "Older rule", priority: 5 }] });
    await startUntil();
    const [created] = called("createRule") as { rule: { priority: number } }[];
    expect(created!.rule.priority).toBe(6);
    expect(called("runNow")).toHaveLength(1);
  });

  it("say so if another rule still controls the tab", async () => {
    await render({ source: "tab", status: "scheduled", otherRuleWins: true });
    await startUntil();
    expect(text()).toContain("“Older rule” still controls this tab");
    expect(called("runNow")).toEqual([]);
  });

  it("use the Settings default for Stop watching after", async () => {
    defaultStopAfter = 20;
    await render({});
    await startUntil();
    const [created] = called("createRule") as { rule: { limits?: { maxDurationSeconds: number } } }[];
    expect(created!.rule.limits).toEqual({ maxDurationSeconds: 1200 });
    defaultStopAfter = null;
  });
});

describe("pages reached by submitting a form", () => {
  it("paused on one: explains and offers Open this page fresh", async () => {
    await render({ source: "tab", status: "paused_resubmit" });
    expect(text()).toContain("Paused on a submitted form");
    expect(text()).toContain("Refreshing every 5 min starts again when this tab goes to another page");
    expect(el.querySelector(".progress")).toBeNull(); // no countdown: nothing is due
    expect(text()).toContain("This page came from submitting a form");
    await click("Open this page fresh");
    expect(called("openFresh")).toEqual([{ tabId: 1 }]);
  });

  it("Refresh now on one asks to open it fresh instead, never offers to resend", async () => {
    refreshNowResult = { refreshed: false, reason: "form", formResult: true };
    await render({ source: "tab", status: "scheduled" });
    await click("Refresh now");
    expect(document.body.textContent).toContain("Open this page fresh instead?");
    expect(button("Refresh anyway")).toBeUndefined();
    const dialogButton = [...document.querySelectorAll(".dialog button")].find((b) => b.textContent === "Open this page fresh") as HTMLButtonElement;
    await act(async () => dialogButton.click());
    await tick();
    expect(called("openFresh")).toEqual([{ tabId: 1 }]);
    expect(called("refreshNow")).toEqual([{ tabId: 1 }]); // no forced retry
    refreshNowResult = { refreshed: true };
  });
});

describe("rule tab paused on a form page", () => {
  it("says so without a countdown, and doesn't promise more than the rule covers", async () => {
    await render({ source: "rule", status: "paused_resubmit" });
    expect(text()).toContain("Paused on a submitted form. The rule carries on if this tab goes to another page it covers.");
    expect(el.querySelector(".progress")).toBeNull();
  });
});

describe("declining site access, then allowing it", () => {
  it("asks Chrome once per click and starts after Allow access", async () => {
    permissionsRequest.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await render({ hostAccess: false });
    await click("Start refreshing every 5 min");
    expect(called("startTab")).toEqual([]);
    expect(text()).toContain("won't refresh this page until you allow access");
    await click("Allow access");
    await tick();
    expect(permissionsRequest).toHaveBeenCalledTimes(2); // Start, then Allow access: no third request outside a click
    expect(called("startTab")).toEqual([{ tabId: 1, intervalSeconds: 300 }]);
  });
});

describe("the interval shown is the one in effect", () => {
  it("a 5 s tab while fast intervals are off shows 30 sec", async () => {
    await render({ source: "tab", status: "scheduled", effective: 30 });
    expect(text()).toContain("Refreshing every 30 sec");
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
