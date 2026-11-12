// @vitest-environment jsdom
/** The highlight action in the page: finding the text, marking it, and not scrolling while the page is in use. */
import { findText, highlight, isBusy, HIGHLIGHT_NAME } from "@/content/highlight";
import { fingerprint } from "@/conditions/dom-eval";

const page = (html: string) => {
  document.body.innerHTML = html;
  return document.body;
};

describe("findText", () => {
  it("finds text across elements, ignoring case and extra whitespace", () => {
    const r = findText(page(`<p>Price: S$\n   <b>3</b>0 today</p>`), "s$ 30");
    expect(r?.toString()).toBe("S$\n   <b>3</b>0".replace(/<\/?b>/g, ""));
  });

  it("skips scripts, styles and hidden elements", () => {
    const root = page(`<script>var x = "In stock"</script><div hidden>In stock</div><p id="p">In stock</p>`);
    expect(findText(root, "in stock")?.startContainer.parentElement?.id).toBe("p");
  });

  it("counts text in separate blocks as separated, as the text conditions do", () => {
    expect(findText(page(`<div>Sold</div><div>out</div>`), "sold out")?.toString()).toBe("Soldout");
    expect(findText(page(`<div>Sold</div><div>out</div>`), "soldout")).toBeNull();
  });

  it("finds text with characters whose lower case is longer", () => {
    expect(findText(page(`<p>Welcome to İstanbul</p>`), "İstanbul")?.toString()).toBe("İstanbul");
  });

  it("stays fast on a very long page", () => {
    const root = page(`<pre>${"word ".repeat(200_000)}</pre><p>needle</p>`);
    const t = performance.now();
    expect(findText(root, "zzz")).toBeNull();
    expect(performance.now() - t).toBeLessThan(1500);
  });

  it("returns null when the text isn't there or is blank", () => {
    expect(findText(page(`<p>Sold out</p>`), "In stock")).toBeNull();
    expect(findText(page(`<p>x</p>`), "   ")).toBeNull();
  });

  it("keeps positions right after characters whose lower case is longer", () => {
    expect(findText(page(`<p>İstanbul in stock</p>`), "in stock")?.toString()).toBe("in stock");
  });
});

describe("highlight", () => {
  const scrolled: Element[] = [];
  beforeEach(() => {
    scrolled.length = 0;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
  });

  it("marks the text with the Custom Highlight API and scrolls to it", () => {
    const set = vi.fn();
    Object.assign(window, {
      CSS: { highlights: { set } },
      Highlight: class {
        constructor(...r: Range[]) {
          Object.assign(this, { r });
        }
      },
    });
    page(`<p id="a">Hello</p><p id="b">Now in stock</p>`);
    expect(highlight(window, { text: "in stock" }, { busy: false })).toEqual({ ok: true, scrolled: true });
    expect(set).toHaveBeenCalledWith(HIGHLIGHT_NAME, expect.anything());
    expect(scrolled.map((e) => e.id)).toEqual(["b"]);
    expect(document.getElementById("justrefresh-highlight-style")).not.toBeNull();
    expect(document.getElementById("b")!.outerHTML).toBe(`<p id="b">Now in stock</p>`); // the page's own content is unchanged
  });

  it("highlights a whole element when there's no text", () => {
    page(`<div id="box">Status</div>`);
    expect(highlight(window, { selector: "#box" }, { busy: false })).toEqual({ ok: true, scrolled: true });
    expect(scrolled.map((e) => e.id)).toEqual(["box"]);
  });

  it("doesn't scroll while you're using the page", () => {
    page(`<p>In stock</p>`);
    expect(highlight(window, { text: "in stock" }, { busy: true })).toEqual({ ok: true, scrolled: false });
    expect(scrolled).toEqual([]);
  });

  it("says why it couldn't", () => {
    page(`<p>Sold out</p>`);
    expect(highlight(window, { text: "In stock" }, { busy: false })).toMatchObject({ ok: false, error: expect.stringMatching(/isn't on the page/) });
    expect(highlight(window, { selector: "#nope" }, { busy: false })).toMatchObject({ ok: false, error: expect.stringMatching(/Nothing matches/) });
    expect(highlight(window, { selector: "[" }, { busy: false })).toMatchObject({ ok: false, error: expect.stringMatching(/Invalid CSS selector/) });
  });

  it("counts typing, recent pointer, scroll or key use as using the page", () => {
    const quiet = { editing: false, composing: false, sinceKeyMs: null, sincePointerMs: null, sinceScrollMs: null };
    expect(isBusy(quiet)).toBe(false);
    expect(isBusy({ ...quiet, sincePointerMs: 60_000 })).toBe(false);
    expect(isBusy({ ...quiet, editing: true })).toBe(true);
    expect(isBusy({ ...quiet, sinceScrollMs: 2_000 })).toBe(true);
  });
});

describe("fingerprint", () => {
  it("is stable, short, and differs for different text", () => {
    expect(fingerprint("S$ 30")).toBe(fingerprint("S$ 30"));
    expect(fingerprint("S$ 30")).not.toBe(fingerprint("S$ 25"));
    expect(fingerprint("x".repeat(100_000))).toMatch(/^[0-9a-f]{1,14}$/);
  });
});
