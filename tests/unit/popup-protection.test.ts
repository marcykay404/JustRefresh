// @vitest-environment jsdom
/**
 * Popup: the spot under "Smart activity protection" always says whether
 * protection works on this site (status line, Allow access box, or nothing).
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

type Case = { hostAccess: boolean; status: string | null; protection: boolean };
let current: Case;
const tabState = () => ({
  tab: { id: 1, windowId: 1, index: 0, title: "Video", url: "https://www.youtube.com/watch?v=x", active: true, discarded: false },
  runtime: current.status ? { tabId: 1, status: current.status, refreshCount: 0, nextDueAt: Date.now() + 60_000 } : null,
  statusLabel: "",
  resolution: { kind: current.status ? "controller" : "none", controllerId: current.status ? "tab:1" : null, controllerName: null, source: current.status ? "tab" : null, candidates: [] },
  override: null,
  interval: 300,
  safety: { ...DEFAULT_SAFETY, pauseWhileTyping: current.protection, protectUnsavedChanges: current.protection },
  hostAccess: current.hostAccess,
});
(globalThis as { chrome?: unknown }).chrome = {
  tabs: { query: async () => [{ id: 1 }] },
  runtime: {
    sendMessage: async (m: { method: string }) => ({
      ok: true,
      result: m.method === "getTabState" ? tabState() : { settings: DEFAULT_SETTINGS, counts: { running: 1, paused: 0, stopped: 0, excluded: 0 }, pendingApprovals: 0, pendingAgents: 0 },
    }),
  },
  permissions: { request: async () => true },
};

let root: Root | undefined;
let el: HTMLDivElement;
async function render(c: Case) {
  current = c;
  el = document.createElement("div");
  root = createRoot(el);
  await act(async () => root!.render(createElement(DialogProvider, null, createElement(Popup))));
  await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
});

describe("popup protection status", () => {
  it("refreshing with access: says protection works here", async () => {
    await render({ hostAccess: true, status: "scheduled", protection: true });
    expect(el.textContent).toContain("✓ Protected on youtube.com: refresh waits while you're typing or you have unsaved form changes");
    expect(el.textContent).not.toContain("Allow access");
  });

  it("refreshing without access: asks for access instead", async () => {
    await render({ hostAccess: false, status: "scheduled", protection: true });
    expect(el.textContent).toContain("can't see inside youtube.com yet");
    expect(el.textContent).not.toContain("Protected on");
  });

  it("protection off, or tab not refreshing: neither", async () => {
    await render({ hostAccess: true, status: "scheduled", protection: false });
    expect(el.textContent).not.toContain("Protected on");
    await act(async () => root!.unmount());
    await render({ hostAccess: false, status: "scheduled", protection: false });
    expect(el.textContent).not.toContain("Allow access");
    await act(async () => root!.unmount());
    await render({ hostAccess: true, status: null, protection: true });
    expect(el.textContent).not.toContain("Protected on");
  });
});
