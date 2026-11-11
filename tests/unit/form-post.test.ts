// @vitest-environment jsdom
import { detectFormResult, RESULT_KEY, SUBMIT_KEY, watchFormPosts } from "@/content/form-post";

class MemStore {
  m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}

describe("noticing POST form submissions", () => {
  let store: MemStore;
  let n: number;
  beforeAll(() => {
    // One watcher for the whole file; jsdom has no real navigation, so stop
    // the default action after our listener ran.
    watchFormPosts(
      window,
      () => store,
      () => n,
    );
    window.addEventListener("submit", (e) => e.preventDefault());
  });
  beforeEach(() => {
    store = new MemStore();
    n = 1000;
    document.body.innerHTML = `
      <form id="post" method="POST" action="/order"><button id="b1">Order</button><button id="b2" formmethod="get">Search</button><button id="b5" formaction="/other">Elsewhere</button></form>
      <form id="get" action="/search"><button id="b3">Go</button></form>
      <form id="js" method="post"><button id="b4">Save</button></form>
      <form id="blank" method="post" action="/export" target="_blank"><button id="b6">Export</button></form>
      <form id="framed" method="post" action="/upload"><button id="b7" formtarget="hidden-frame">Upload</button></form>`;
    document.getElementById("js")!.addEventListener("submit", (e) => e.preventDefault()); // handled with fetch
  });
  const submit = (formId: string, buttonId: string) =>
    document
      .getElementById(formId)!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: document.getElementById(buttonId) as HTMLElement }));
  const recorded = () => JSON.parse(store.getItem(SUBMIT_KEY) ?? "null");

  it("records POST submissions that load into this tab, with the form's address", () => {
    submit("post", "b1");
    expect(recorded()).toEqual({ at: 1000, action: `${location.origin}/order` });
    submit("post", "b5");
    expect(recorded().action).toBe(`${location.origin}/other`);
  });

  it("ignores GET forms, formmethod=get, forms handled with script, and results that open elsewhere", () => {
    submit("get", "b3");
    submit("post", "b2");
    submit("js", "b4");
    submit("blank", "b6");
    submit("framed", "b7");
    expect(store.getItem(SUBMIT_KEY)).toBeNull();
  });
});

describe("recognising a form result page", () => {
  const now = 1_000_000;
  const submitted = (store: MemStore, action: string, msAgo = 3000) => store.setItem(SUBMIT_KEY, JSON.stringify({ at: now - msAgo, action }));
  const nav = (type: string, redirectCount = 0) => ({ type, redirectCount });

  it("the form's own address right after submitting it (no redirect) is a form result, and stays one on reload or back/forward", () => {
    const store = new MemStore();
    submitted(store, "https://shop.test/order");
    expect(detectFormResult("https://shop.test/order", nav("navigate"), () => store, now, 11)).toBe(true);
    expect(JSON.parse(store.getItem(RESULT_KEY)!)).toEqual({ href: "https://shop.test/order", timeOrigin: 11 });
    expect(detectFormResult("https://shop.test/order", nav("reload"), () => store, now, 12)).toBe(true);
    expect(detectFormResult("https://shop.test/order", nav("back_forward"), () => store, now, 13)).toBe(true);
  });

  it("ignores a #fragment when comparing with the form's address", () => {
    const store = new MemStore();
    submitted(store, "https://shop.test/order");
    expect(detectFormResult("https://shop.test/order#done", nav("navigate"), () => store, now)).toBe(true);
  });

  it("is not a form result after a redirect, an old submission, a different page, or a normal visit", () => {
    const store = new MemStore();
    submitted(store, "https://shop.test/order");
    expect(detectFormResult("https://shop.test/thanks", nav("navigate", 1), () => store, now)).toBe(false);
    submitted(store, "https://shop.test/order", 10 * 60_000);
    expect(detectFormResult("https://shop.test/order", nav("navigate"), () => store, now)).toBe(false);
    // A POST that didn't replace this page (e.g. a download), then an ordinary link click.
    submitted(store, "https://shop.test/export");
    expect(detectFormResult("https://shop.test/account", nav("navigate"), () => store, now)).toBe(false);
    expect(detectFormResult("https://shop.test/", nav("navigate"), () => store, now)).toBe(false);
  });

  it("opening the page fresh (a normal visit) clears it", () => {
    const store = new MemStore();
    submitted(store, "https://shop.test/order");
    detectFormResult("https://shop.test/order", nav("navigate"), () => store, now, 11);
    expect(detectFormResult("https://shop.test/order", nav("navigate"), () => store, now, 22)).toBe(false);
    expect(detectFormResult("https://shop.test/order", nav("reload"), () => store, now, 33)).toBe(false);
  });

  it("a content script injected again into the same page (extension update) still knows", () => {
    const store = new MemStore();
    submitted(store, "https://shop.test/order");
    detectFormResult("https://shop.test/order", nav("navigate"), () => store, now, 11);
    // Same document (same timeOrigin), no new submission.
    expect(detectFormResult("https://shop.test/order", nav("navigate"), () => store, now + 60_000, 11)).toBe(true);
  });

  it("a form result restored after Memory Saver discarded the tab is still one; other restored pages aren't", () => {
    const store = new MemStore();
    submitted(store, "https://shop.test/order");
    detectFormResult("https://shop.test/order", nav("navigate"), () => store, now, 11);
    // Restoring a discarded tab counts as "navigate" with a new document.
    expect(detectFormResult("https://shop.test/order", nav("navigate"), () => store, now + 3_600_000, 99, true)).toBe(true);
    expect(detectFormResult("https://shop.test/other", nav("navigate"), () => store, now, 100, true)).toBe(false);
  });

  it("copes with storage being unavailable or holding junk", () => {
    expect(
      detectFormResult(
        "https://x.test/",
        nav("navigate"),
        () => {
          throw new Error("denied");
        },
        now,
      ),
    ).toBe(false);
    const store = new MemStore();
    store.setItem(SUBMIT_KEY, "{not json");
    store.setItem(RESULT_KEY, "1234");
    expect(detectFormResult("https://x.test/", nav("navigate"), () => store, now)).toBe(false);
  });
});
