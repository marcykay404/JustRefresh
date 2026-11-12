/** What a popup click asked for, done by the service worker once access is granted (the popup may have closed). */
import { AFTER_ACCESS_MS, createAfterAccess, parseAfterAccess } from "@/background/after-access";

function setup() {
  const store: Record<string, unknown> = {};
  const granted = new Set<string>();
  const calls: { method: string; params: unknown }[] = [];
  const notes: string[] = [];
  let now = 1_000_000;
  const aa = createAfterAccess({
    storage: { get: async (k) => ({ [k]: store[k] }), set: async (items) => void Object.assign(store, items) },
    granted: async (o) => granted.has(o),
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "createRule") return { id: "r1" };
      if (method === "getTabState") return { override: null, resolution: { controllerId: "r1", controllerName: "x" } };
      if (method === "testRule") return { result: { status: "not_matched" } };
      return null;
    },
    notify: async (title, message) => void notes.push(`${title}: ${message}`),
    now: () => now,
  });
  return { aa, granted, calls, notes, advance: (ms: number) => (now += ms) };
}

const O = "https://example.com/*";

describe("after access", () => {
  it("starts the tab once access is granted, and only once", async () => {
    const { aa, granted, calls } = setup();
    await aa.queue([O], { method: "startTab", params: { tabId: 1, intervalSeconds: 60 } });
    expect(await aa.run()).toEqual([]); // not granted yet
    granted.add(O);
    expect(await aa.run()).toEqual([{ method: "startTab", ok: true }]);
    expect(await aa.run({ quiet: true })).toEqual([]); // the popup asking too finds nothing left
    expect(calls).toEqual([{ method: "startTab", params: { tabId: 1, intervalSeconds: 60 } }]);
  });

  it("a request left by a 'Deny' expires", async () => {
    const { aa, granted, calls, advance } = setup();
    await aa.queue([O], { method: "resumeTab", params: { tabId: 1 } });
    advance(AFTER_ACCESS_MS + 1);
    granted.add(O);
    expect(await aa.run()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a newer click for the same tab replaces the older one", async () => {
    const { aa, granted, calls } = setup();
    await aa.queue([O], { method: "startTab", params: { tabId: 1, intervalSeconds: 60 } });
    await aa.queue([O], { method: "startTab", params: { tabId: 1, intervalSeconds: 300 } });
    granted.add(O);
    await aa.run();
    expect(calls).toEqual([{ method: "startTab", params: { tabId: 1, intervalSeconds: 300 } }]);
  });

  it("sets up 'Refresh until', and tells the user when it can't (the popup may be gone)", async () => {
    const { aa, granted, calls, notes } = setup();
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
    await aa.queue([O], { method: "refreshUntil", params: plan });
    granted.add(O);
    const [r] = await aa.run();
    expect(r).toMatchObject({ method: "refreshUntil", ok: false, message: expect.stringMatching(/isn't on this page now/) });
    expect(calls.map((c) => c.method)).toEqual(["testRule"]); // nothing created
    expect(notes).toEqual([expect.stringMatching(/couldn't start: “Sold out” isn't on this page now/)]);

    await aa.queue([O], { method: "refreshUntil", params: { ...plan, mode: "appears" } });
    const [ok] = await aa.run({ quiet: true });
    expect(ok).toEqual({ method: "refreshUntil", ok: true });
    expect(calls.map((c) => c.method)).toEqual(["testRule", "createRule", "getTabState", "getTabState", "runNow"]);
    expect(notes).toHaveLength(1); // quiet: the open popup shows it
  });

  it("hands a declined request back to the popup (and cancels it), but leaves a granted one to run", async () => {
    const { aa, granted, calls } = setup();
    await aa.queue([O], { method: "startTab", params: { tabId: 1, intervalSeconds: 60 } });
    expect(await aa.take(1)).toEqual({ method: "startTab", params: { tabId: 1, intervalSeconds: 60 } });
    expect(await aa.take(1)).toBeNull();
    granted.add(O);
    expect(await aa.run()).toEqual([]); // taken back: never starts by surprise
    await aa.queue([O], { method: "startTab", params: { tabId: 2 } });
    expect(await aa.take(2)).toBeNull(); // access granted: it runs instead
    expect(await aa.run()).toEqual([{ method: "startTab", ok: true }]);
    expect(calls).toHaveLength(1);
  });

  it("accepts only the popup's three actions, for a tab", () => {
    expect(parseAfterAccess({ origins: [O], method: "startTab", params: { tabId: 1 } })).not.toBeNull();
    expect(parseAfterAccess({ origins: [O], method: "deleteRule", params: { tabId: 1, id: "x" } })).toBeNull();
    expect(parseAfterAccess({ origins: [O], method: "startTab", params: {} })).toBeNull();
    expect(parseAfterAccess({ origins: "x", method: "startTab", params: { tabId: 1 } })).toBeNull();
  });
});
