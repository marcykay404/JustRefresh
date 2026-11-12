/** What a popup click asked for, done by the service worker once access is granted (the popup may have closed). */
import { AFTER_ACCESS_MS, createAfterAccess, parseAfterAccess } from "@/background/after-access";

function setup() {
  const store: Record<string, unknown> = {};
  const granted = new Set<string>();
  const calls: { method: string; params: unknown }[] = [];
  const notes: string[] = [];
  const env = {
    now: 1_000_000,
    popupOpen: false,
    tabSite: new Map<number, string>([
      [1, O],
      [2, O],
    ]),
  };
  const aa = createAfterAccess({
    storage: { get: async (k) => ({ [k]: store[k] }), set: async (items) => void Object.assign(store, items) },
    granted: async (o) => granted.has(o),
    tabOn: async (tabId, origins) => origins.includes(env.tabSite.get(tabId) ?? ""),
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "createRule") return { id: "r1" };
      if (method === "getTabState") return { override: null, resolution: { controllerId: "r1", controllerName: "x" } };
      if (method === "testRule") return { result: { status: "not_matched" } };
      return null;
    },
    popupOpen: async () => env.popupOpen,
    notify: async (tabId, title, message) => void notes.push(`${tabId} ${title}: ${message}`),
    now: () => env.now,
  });
  return { aa, granted, calls, notes, env };
}

const O = "https://example.com/*";
const plan = {
  tabId: 1,
  url: "https://example.com/",
  site: "example.com",
  seconds: 60,
  text: "Sold out",
  mode: "disappears" as const,
  anyQuery: false,
  priority: 0,
  stopAfterMinutes: null,
};

describe("after access", () => {
  it("starts the tab once access is granted, and only once", async () => {
    const { aa, granted, calls } = setup();
    await aa.queue("a1", [O], { method: "startTab", params: { tabId: 1, intervalSeconds: 60 } });
    expect(await aa.runGranted()).toEqual([]); // not granted yet
    granted.add(O);
    expect((await aa.runGranted()).map((d) => d.result)).toEqual([{ method: "startTab", ok: true }]);
    expect(await aa.runGranted()).toEqual([]);
    expect(calls).toEqual([{ method: "startTab", params: { tabId: 1, intervalSeconds: 60 } }]);
  });

  it("the popup that asked learns what happened, whichever side ran it", async () => {
    const { aa, granted, notes, env } = setup();
    env.popupOpen = true;
    await aa.queue("a1", [O], { method: "refreshUntil", params: plan });
    granted.add(O);
    await aa.runGranted(); // Chrome's event first
    expect(await aa.resultFor("a1")).toMatchObject({ ok: false, message: expect.stringMatching(/isn't on this page now/) });
    expect(notes).toEqual([]); // the open popup shows it
  });

  it("notifies when no popup is open to show a problem", async () => {
    const { aa, granted, notes, calls } = setup();
    await aa.queue("a1", [O], { method: "refreshUntil", params: plan });
    granted.add(O);
    await aa.runGranted();
    expect(calls.map((c) => c.method)).toEqual(["testRule"]); // nothing created
    expect(notes).toEqual([expect.stringMatching(/^1 JustRefresh couldn't start: “Sold out” isn't on this page now/)]);
  });

  it("sets up 'Refresh until' when the text is there", async () => {
    const { aa, granted, calls } = setup();
    await aa.queue("a1", [O], { method: "refreshUntil", params: { ...plan, mode: "appears" } });
    granted.add(O);
    expect(await aa.resultFor("a1")).toEqual({ method: "refreshUntil", ok: true });
    expect(calls.map((c) => c.method)).toEqual(["createRule", "getTabState", "getTabState", "runNow"]);
  });

  it("drops a request whose tab closed or moved to another site", async () => {
    const { aa, granted, calls, env } = setup();
    await aa.queue("a1", [O], { method: "startTab", params: { tabId: 1 } });
    env.tabSite.set(1, "https://elsewhere.com/*");
    granted.add(O);
    expect(await aa.runGranted()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a request left by a 'Deny' expires, or is cancelled", async () => {
    const { aa, granted, calls, env } = setup();
    await aa.queue("a1", [O], { method: "resumeTab", params: { tabId: 1 } });
    env.now += AFTER_ACCESS_MS + 1;
    await aa.queue("a2", [O], { method: "startTab", params: { tabId: 2 } });
    expect(await aa.take(2)).toEqual({ method: "startTab", params: { tabId: 2 } }); // Deny cancels it
    granted.add(O);
    expect(await aa.runGranted()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a newer click for the same tab replaces the older one", async () => {
    const { aa, granted, calls } = setup();
    await aa.queue("a1", [O], { method: "startTab", params: { tabId: 1, intervalSeconds: 60 } });
    await aa.queue("a2", [O], { method: "startTab", params: { tabId: 1, intervalSeconds: 300 } });
    granted.add(O);
    await aa.runGranted();
    expect(calls).toEqual([{ method: "startTab", params: { tabId: 1, intervalSeconds: 300 } }]);
  });

  it("leaves a granted request to run instead of handing it back", async () => {
    const { aa, granted } = setup();
    await aa.queue("a1", [O], { method: "startTab", params: { tabId: 1 } });
    granted.add(O);
    expect(await aa.take(1)).toBeNull();
    expect((await aa.runGranted()).map((d) => d.result.ok)).toEqual([true]);
  });

  it("accepts only the popup's three actions, for a tab, with an id and at least one site", () => {
    expect(parseAfterAccess({ id: "a1", origins: [O], method: "startTab", params: { tabId: 1 } })).not.toBeNull();
    expect(parseAfterAccess({ id: "a1", origins: [O], method: "deleteRule", params: { tabId: 1, id: "x" } })).toBeNull();
    expect(parseAfterAccess({ id: "a1", origins: [O], method: "startTab", params: {} })).toBeNull();
    expect(parseAfterAccess({ id: "a1", origins: [], method: "startTab", params: { tabId: 1 } })).toBeNull();
    expect(parseAfterAccess({ origins: [O], method: "startTab", params: { tabId: 1 } })).toBeNull();
  });
});
