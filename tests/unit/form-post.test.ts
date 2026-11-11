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
  beforeEach(() => {
    store = new MemStore();
    document.body.innerHTML = `
      <form id="post" method="POST" action="/order"><button id="b1">Order</button><button id="b2" formmethod="get">Search</button></form>
      <form id="get" action="/search"><button id="b3">Go</button></form>
      <form id="js" method="post"><button id="b4">Save</button></form>`;
    document.getElementById("js")!.addEventListener("submit", (e) => e.preventDefault()); // handled with fetch
  });
  const submit = (formId: string, buttonId: string) => {
    const form = document.getElementById(formId) as HTMLFormElement;
    const ev = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: document.getElementById(buttonId) as HTMLElement });
    form.dispatchEvent(ev);
  };
  it("records POST submissions only, not GET forms, formmethod=get buttons or forms the page handles with script", () => {
    let n = 1000;
    watchFormPosts(window, () => store, () => n++);
    // jsdom has no real navigation: stop the default action, after our listener ran.
    window.addEventListener("submit", (e) => e.preventDefault());
    submit("get", "b3");
    submit("post", "b2");
    submit("js", "b4");
    expect(store.getItem(SUBMIT_KEY)).toBeNull();
    submit("post", "b1");
    expect(store.getItem(SUBMIT_KEY)).toBe("1000");
  });
});

describe("recognising a form result page", () => {
  const now = 1_000_000;
  const at = (store: MemStore, msAgo: number) => store.setItem(SUBMIT_KEY, String(now - msAgo));

  it("the page right after a POST submission (no redirect) is a form result, and stays one on reload or back/forward", () => {
    const store = new MemStore();
    at(store, 3000);
    expect(detectFormResult("https://shop.test/order", { type: "navigate", redirectCount: 0 }, () => store, now)).toBe(true);
    expect(store.getItem(RESULT_KEY)).toBe("https://shop.test/order");
    expect(detectFormResult("https://shop.test/order", { type: "reload", redirectCount: 0 }, () => store, now)).toBe(true);
    expect(detectFormResult("https://shop.test/order", { type: "back_forward", redirectCount: 0 }, () => store, now)).toBe(true);
  });

  it("is not a form result after a redirect (the page was fetched with GET), an old submission, or a normal visit", () => {
    const store = new MemStore();
    at(store, 3000);
    expect(detectFormResult("https://shop.test/thanks", { type: "navigate", redirectCount: 1 }, () => store, now)).toBe(false);
    at(store, 10 * 60_000);
    expect(detectFormResult("https://shop.test/order", { type: "navigate", redirectCount: 0 }, () => store, now)).toBe(false);
    expect(detectFormResult("https://shop.test/", { type: "navigate", redirectCount: 0 }, () => store, now)).toBe(false);
  });

  it("opening the page fresh (a normal visit) clears it", () => {
    const store = new MemStore();
    at(store, 1000);
    detectFormResult("https://shop.test/order", { type: "navigate", redirectCount: 0 }, () => store, now);
    expect(detectFormResult("https://shop.test/order", { type: "navigate", redirectCount: 0 }, () => store, now)).toBe(false);
    expect(detectFormResult("https://shop.test/order", { type: "reload", redirectCount: 0 }, () => store, now)).toBe(false);
  });

  it("copes with storage being unavailable", () => {
    expect(detectFormResult("https://x.test/", { type: "navigate", redirectCount: 0 }, () => { throw new Error("denied"); }, now)).toBe(false);
  });
});
