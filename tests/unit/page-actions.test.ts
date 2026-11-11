// @vitest-environment jsdom
/** Page side of the new actions: the selector builder, the click guard, scroll restore and the element picker. */
import { cssEscape, selectorFor } from "@/content/selector";
import { clickBlocker, clickElement, restoreScroll, saveScroll, SCROLL_KEY } from "@/content/page-actions";
import { cancelPicker, startPicker } from "@/content/picker";

const html = (s: string) => (document.body.innerHTML = s);
const $ = (s: string) => document.querySelector(s)!;

describe("selectorFor", () => {
  it("prefers an id, then test or ARIA attributes, and always matches exactly that element", () => {
    html(`<div id="price">1</div><button data-testid="buy">Buy</button><a aria-label="Help" href="#">?</a>`);
    expect(selectorFor($("#price"))).toBe("#price");
    expect(selectorFor($("button"))).toBe('button[data-testid="buy"]');
    expect(selectorFor($("a"))).toBe('a[aria-label="Help"]');
  });

  it("skips ids and classes that look generated, and tells look-alike siblings apart", () => {
    html(`<main id="app"><ul class="list css-1x9fz2"><li class="item">a</li><li class="item">b</li></ul><p id="n-38291">x</p></main>`);
    const second = document.querySelectorAll("li")[1]!;
    const sel = selectorFor(second);
    expect(sel).toBe("li.item:nth-of-type(2)");
    expect(document.querySelectorAll(sel)).toHaveLength(1);
    // With a second list, the path grows until it is unique again.
    $("main").insertAdjacentHTML("afterbegin", `<ul class="list"><li class="item">c</li><li class="item">d</li></ul>`);
    expect(selectorFor(second)).toBe("ul.list:nth-of-type(2) > li.item:nth-of-type(2)");
    expect(selectorFor($("p"))).not.toContain("38291");
    expect(document.querySelector(selectorFor($("p")))).toBe($("p"));
  });

  it("escapes awkward ids", () => {
    expect(cssEscape("1st")).toBe("\\31 st");
    expect(cssEscape("a.b:c")).toBe("a\\.b\\:c");
    html(`<span id="a.b">x</span>`);
    expect(document.querySelector(selectorFor($("span")))).toBe($("span"));
  });
});

describe("click guard", () => {
  beforeEach(() =>
    html(`<form action="/order" method="post">
        <button id="submit">Pay</button><button id="plain" type="button">+1</button>
        <button id="wrapped"><span id="inner">Pay</span></button><input id="img" type="image" alt="Pay">
        <label id="lbl" for="submit">Pay</label>
      </form>
      <button id="outside">Outside a form</button><button id="off" type="button" disabled>Off</button>`),
  );

  it("refuses anything that would submit a form: the button, its text, an image input, a label for it", () => {
    for (const id of ["#submit", "#inner", "#img", "#lbl"]) expect(clickBlocker($(id)), id).toMatch(/submit a form/);
  });

  it("allows plain buttons, buttons outside forms and links; refuses disabled ones", () => {
    expect(clickBlocker($("#plain"))).toBeNull();
    expect(clickBlocker($("#outside"))).toBeNull();
    expect(clickBlocker($("#off"))).toMatch(/disabled/);
  });

  it("clicks the first match and reports what went wrong otherwise", () => {
    let n = 0;
    $("#plain").addEventListener("click", () => n++);
    expect(clickElement(document, "#plain")).toEqual({ ok: true });
    expect(n).toBe(1);
    expect(clickElement(document, "#missing")).toMatchObject({ ok: false, error: expect.stringMatching(/Nothing on the page matches/) });
    expect(clickElement(document, "[[")).toMatchObject({ ok: false, error: expect.stringMatching(/Not a valid CSS selector/) });
    expect(clickElement(document, "#submit")).toMatchObject({ ok: false });
  });
});

describe("scroll restore", () => {
  const fakeWindow = (href: string) => {
    const listeners = new Map<string, () => void>();
    const w = {
      location: { href },
      scrollX: 0,
      scrollY: 0,
      maxY: 0, // how far the page can scroll right now
      document: { readyState: "loading" as DocumentReadyState },
      scrollTo(x: number, y: number) {
        w.scrollX = x;
        w.scrollY = Math.min(y, w.maxY);
      },
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (t: ReturnType<typeof setInterval>) => clearInterval(t),
      addEventListener: (t: string, fn: () => void) => listeners.set(t, fn),
      removeEventListener: (t: string) => listeners.delete(t),
      fire: (t: string) => listeners.get(t)?.(),
    };
    return w;
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("scrolls back once the page is long enough, and stops when it's there and loaded", () => {
    const store = window.sessionStorage;
    const before = fakeWindow("https://a.test/feed");
    before.scrollY = 1200;
    saveScroll(before as unknown as Window, store, 1000);
    const after = fakeWindow("https://a.test/feed");
    restoreScroll(after as unknown as Window, store, 2000);
    expect(store.getItem(SCROLL_KEY)).toBeNull();
    vi.advanceTimersByTime(300);
    expect(after.scrollY).toBe(0); // page still short
    after.maxY = 5000;
    after.document.readyState = "complete";
    vi.advanceTimersByTime(100);
    expect(after.scrollY).toBe(1200);
    after.scrollTo(0, 0); // done: no more scrolling back
    vi.advanceTimersByTime(1000);
    expect(after.scrollY).toBe(0);
  });

  it("gives way to the user, and ignores old or other pages' positions", () => {
    const store = window.sessionStorage;
    const w = fakeWindow("https://a.test/feed");
    w.scrollY = 800;
    saveScroll(w as unknown as Window, store, 1000);
    const next = fakeWindow("https://a.test/feed");
    restoreScroll(next as unknown as Window, store, 1500);
    next.fire("wheel");
    next.maxY = 5000;
    vi.advanceTimersByTime(500);
    expect(next.scrollY).toBe(0);

    saveScroll(w as unknown as Window, store, 1000);
    const other = fakeWindow("https://a.test/other");
    other.maxY = 5000;
    restoreScroll(other as unknown as Window, store, 1500);
    vi.advanceTimersByTime(500);
    expect(other.scrollY).toBe(0);

    saveScroll(w as unknown as Window, store, 1000);
    const late = fakeWindow("https://a.test/feed");
    late.maxY = 5000;
    restoreScroll(late as unknown as Window, store, 1000 + 120_000);
    vi.advanceTimersByTime(500);
    expect(late.scrollY).toBe(0);
  });
});

describe("element picker", () => {
  let under: Element | null = null;
  beforeEach(() => {
    html(`<div id="card"><button id="buy" type="button">Buy</button></div>`);
    document.elementFromPoint = () => under;
  });
  afterEach(() => cancelPicker());
  const move = (el: Element) => {
    under = el;
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 1, clientY: 1 }));
  };
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, cancelable: true }));

  it("picks the element clicked, without the page seeing the click", () => {
    const done = vi.fn();
    let pageSaw = 0;
    $("#buy").addEventListener("click", () => pageSaw++);
    startPicker(window, done);
    move($("#buy"));
    $("#buy").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(done).toHaveBeenCalledWith({ selector: "#buy", count: 1 });
    expect(pageSaw).toBe(0);
    expect(document.documentElement.lastElementChild?.shadowRoot ?? null).toBeNull(); // overlay gone
  });

  it("↑ widens to the parent, ↓ goes back, Esc cancels", () => {
    const done = vi.fn();
    startPicker(window, done);
    move($("#buy"));
    key("ArrowUp");
    $("#buy").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(done).toHaveBeenLastCalledWith({ selector: "#card", count: 1 });

    startPicker(window, done);
    move($("#buy"));
    key("ArrowUp");
    key("ArrowDown");
    key("Escape");
    expect(done).toHaveBeenLastCalledWith(null);
  });
});
