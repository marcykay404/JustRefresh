// @vitest-environment jsdom
import { evaluateDomCondition, testSelector } from "@/conditions/dom-eval";
import { ActivityMonitor } from "@/content/activity-monitor";
import { checkSelector } from "@/conditions/helpers";

const html = `<div id="status" class="badge big">  In   Stock  </div><a class="buy" href="/cart" data-state="ready">Buy</a>
<form id="f"><input id="name" value="Ann"><textarea id="t">x</textarea><input type="checkbox" id="c"></form>`;

beforeEach(() => {
  document.body.innerHTML = html;
});

describe("DOM conditions", () => {
  const ev = (n: Record<string, unknown>, includeText = true) => evaluateDomCondition(n as never, document, { includeText });
  it("exists / missing / minCount", () => {
    expect(ev({ type: "dom.exists", selector: ".buy" }).status).toBe("matched");
    expect(ev({ type: "dom.exists", selector: ".buy", minCount: 2 }).status).toBe("not_matched");
    expect(ev({ type: "dom.missing", selector: ".sold-out" }).status).toBe("matched");
  });
  it("text comparison is whitespace-normalized and case-insensitive by default", () => {
    expect(ev({ type: "dom.text", selector: "#status", operator: "equals", value: "in stock" }).status).toBe("matched");
    expect(ev({ type: "dom.text", selector: "#status", operator: "contains", value: "Stock", caseSensitive: true }).status).toBe("matched");
    expect(ev({ type: "dom.text", selector: "#status", operator: "matches", value: "^in\\s+stock$" }).status).toBe("matched");
    expect(ev({ type: "dom.text", selector: "#nope", operator: "contains", value: "x" })).toMatchObject({ status: "not_matched" });
  });
  it("attributes", () => {
    expect(ev({ type: "dom.attribute", selector: ".buy", attribute: "data-state", operator: "equals", value: "ready" }).status).toBe("matched");
    expect(ev({ type: "dom.attribute", selector: ".buy", attribute: "disabled", operator: "missing" }).status).toBe("matched");
  });
  it("invalid selectors and unsafe regexes are unknown, not false", () => {
    expect(ev({ type: "dom.exists", selector: "##" })).toMatchObject({ status: "unknown", code: "invalid_selector" });
    expect(ev({ type: "dom.text", selector: "#status", operator: "matches", value: "(a+)+" })).toMatchObject({ status: "unknown" });
  });
  it("returns minimal element summaries; text only when allowed", () => {
    const r = ev({ type: "dom.exists", selector: "#status" }, false);
    expect(r.status === "matched" && r.details?.element).toEqual({ tag: "div", id: "status", classes: ["badge", "big"] });
    const s = testSelector(document, "a", true);
    expect(s).toMatchObject({ ok: true, count: 1, samples: [{ tag: "a", textPreview: "Buy" }] });
  });
  it("selector validation uses the DOM when available", () => {
    expect(checkSelector("div >", "p")[0]?.code).toBe("selector_invalid");
    expect(checkSelector("div > p", "p")).toEqual([]);
  });
});

describe("ActivityMonitor", () => {
  it("tracks dirty state conservatively without exposing values", () => {
    const m = new ActivityMonitor(document);
    m.start();
    expect(m.snapshot().dirty).toBe("clean");
    const input = document.getElementById("name") as HTMLInputElement;
    input.value = "Bob";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const snap = m.snapshot();
    expect(snap.dirty).toBe("dirty");
    expect(snap.sinceInputMs).not.toBeNull();
    expect(JSON.stringify(snap)).not.toContain("Bob");
    input.value = "Ann";
    expect(m.snapshot().dirty).toBe("clean");
    (document.getElementById("c") as HTMLInputElement).checked = true;
    expect(m.snapshot().dirty).toBe("dirty");
  });
  it("submitted forms are not dirty; contenteditable edits are unknown", () => {
    const m = new ActivityMonitor(document);
    m.start();
    const input = document.getElementById("name") as HTMLInputElement;
    input.value = "Bob";
    document.getElementById("f")!.dispatchEvent(new Event("submit", { bubbles: true }));
    expect(m.snapshot().dirty).toBe("clean");
    const ed = document.createElement("div");
    ed.contentEditable = "true";
    Object.defineProperty(ed, "isContentEditable", { value: true });
    document.body.appendChild(ed);
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    expect(m.snapshot().dirty).toBe("unknown");
  });
  it("records key timing only for editable targets", () => {
    const m = new ActivityMonitor(document);
    m.start();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    expect(m.snapshot().sinceKeyMs).toBeNull();
    document.getElementById("name")!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(m.snapshot().sinceKeyMs).not.toBeNull();
  });
});
