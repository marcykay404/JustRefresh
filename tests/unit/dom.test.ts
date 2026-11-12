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
  // jsdom events are never trusted and jsdom documents are already loaded, so
  // tests state explicitly which events count as the user's and when monitoring began.
  const asUser = { isUserEvent: () => true, lateStart: false };
  const userInput = (el: Element, type = "input") => el.dispatchEvent(new Event(type, { bubbles: true }));

  it("tracks dirty state conservatively without exposing values", () => {
    const m = new ActivityMonitor(document, asUser);
    m.start();
    expect(m.snapshot().dirty).toBe("clean");
    const input = document.getElementById("name") as HTMLInputElement;
    input.value = "Bob";
    userInput(input);
    const snap = m.snapshot();
    expect(snap.dirty).toBe("dirty");
    expect(snap.sinceInputMs).not.toBeNull();
    expect(JSON.stringify(snap)).not.toContain("Bob");
    input.value = "Ann";
    expect(m.snapshot().dirty).toBe("clean");
    const box = document.getElementById("c") as HTMLInputElement;
    box.checked = true;
    userInput(box, "change");
    expect(m.snapshot().dirty).toBe("dirty");
  });

  it("ignores values set by the page's own scripts (e.g. GitHub) and untouched drop-downs", () => {
    document.body.innerHTML = `<form>
      <select id="plain"><option>a</option><option>b</option></select>
      <select id="disabledFirst"><option disabled>pick</option><option>a</option></select>
      <input id="byScript"><input type="checkbox" id="box"></form>`;
    const m = new ActivityMonitor(document, { lateStart: false }); // real isTrusted check
    m.start();
    (document.getElementById("byScript") as HTMLInputElement).value = "filled by page script";
    (document.getElementById("box") as HTMLInputElement).checked = true;
    // Frameworks often dispatch synthetic input events after setting a value: still not the user.
    userInput(document.getElementById("byScript")!);
    expect(m.snapshot().dirty).toBe("clean");
    expect(m.snapshot().sinceInputMs).toBeNull();
  });

  it("a field whose default follows what's typed (React) still counts as changed, and as clean once typed back", () => {
    document.body.innerHTML = `<input id="r">`;
    const m = new ActivityMonitor(document, asUser);
    m.start();
    const input = document.getElementById("r") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    // What React does for a controlled input: the value attribute (the default) follows the value.
    const type = (text: string) => {
      input.value = text;
      input.setAttribute("value", text);
      userInput(input);
    };
    type("half a message");
    expect(input.defaultValue).toBe("half a message");
    expect(m.snapshot().dirty).toBe("dirty");
    expect(JSON.stringify(m.snapshot())).not.toContain("half a message");
    type("");
    expect(m.snapshot().dirty).toBe("clean");
  });

  it("a field the page focuses and then fills itself isn't unsaved once typed back", () => {
    document.body.innerHTML = `<input id="p">`;
    const m = new ActivityMonitor(document, asUser);
    m.start();
    const input = document.getElementById("p") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); // autofocus counts as the user's
    // The page fills it from its server, keeping the default in step (as React does).
    input.value = "Marcy";
    input.setAttribute("value", "Marcy");
    // The user types a letter, then deletes it.
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    input.value = "Marcyx";
    input.setAttribute("value", "Marcyx");
    userInput(input);
    expect(m.snapshot().dirty).toBe("dirty");
    input.value = "Marcy";
    input.setAttribute("value", "Marcy");
    userInput(input);
    expect(m.snapshot().dirty).toBe("clean");
  });

  it("with real React: a half-filled controlled input and textarea are unsaved changes", async () => {
    const { act, createElement, useState } = await import("react");
    const { createRoot } = await import("react-dom/client");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    function Form() {
      const [name, setName] = useState("");
      const [msg, setMsg] = useState("");
      return createElement(
        "form",
        null,
        createElement("input", { id: "name", value: name, onChange: (e: { target: HTMLInputElement }) => setName(e.target.value) }),
        createElement("textarea", { id: "msg", value: msg, onChange: (e: { target: HTMLTextAreaElement }) => setMsg(e.target.value) }),
      );
    }
    document.body.innerHTML = `<div id="app"></div>`;
    await act(async () => createRoot(document.getElementById("app")!).render(createElement(Form)));
    const m = new ActivityMonitor(document, asUser);
    m.start();
    for (const [id, proto] of [
      ["name", HTMLInputElement.prototype],
      ["msg", HTMLTextAreaElement.prototype],
    ] as const) {
      const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
      el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      await act(async () => {
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, "Hello, two seats please");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(el.defaultValue, `${id}: React keeps the default in step`).toBe("Hello, two seats please");
      expect(m.snapshot().dirty, id).toBe("dirty");
      await act(async () => {
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
  });

  it("a drop-down the user changed is dirty", () => {
    document.body.innerHTML = `<select id="s"><option>a</option><option>b</option></select>`;
    const m = new ActivityMonitor(document, asUser);
    m.start();
    const sel = document.getElementById("s") as HTMLSelectElement;
    expect(m.snapshot().dirty).toBe("clean");
    sel.selectedIndex = 1;
    userInput(sel, "change");
    expect(m.snapshot().dirty).toBe("dirty");
    sel.selectedIndex = 0;
    expect(m.snapshot().dirty).toBe("clean");
  });

  it("monitoring that started after page load reports changed fields as unknown, never clean", () => {
    document.body.innerHTML = `<select id="plain"><option>a</option><option>b</option></select><input id="q">`;
    const m = new ActivityMonitor(document, { isUserEvent: () => true, lateStart: true });
    m.start();
    expect(m.snapshot().dirty).toBe("clean"); // untouched drop-down is not a change
    (document.getElementById("q") as HTMLInputElement).value = "typed before we were injected?";
    expect(m.snapshot().dirty).toBe("unknown");
  });

  it("submitted forms are not dirty; contenteditable edits are unknown", () => {
    const m = new ActivityMonitor(document, asUser);
    m.start();
    const input = document.getElementById("name") as HTMLInputElement;
    input.value = "Bob";
    userInput(input);
    document.getElementById("f")!.dispatchEvent(new Event("submit", { bubbles: true }));
    expect(m.snapshot().dirty).toBe("clean");
    const ed = document.createElement("div");
    ed.contentEditable = "true";
    Object.defineProperty(ed, "isContentEditable", { value: true });
    document.body.appendChild(ed);
    userInput(ed);
    expect(m.snapshot().dirty).toBe("unknown");
  });

  it("records key timing only for the user's keys on editable targets", () => {
    const m = new ActivityMonitor(document, asUser);
    m.start();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    expect(m.snapshot().sinceKeyMs).toBeNull();
    document.getElementById("name")!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(m.snapshot().sinceKeyMs).not.toBeNull();

    const strict = new ActivityMonitor(document, { lateStart: false });
    strict.start();
    document.getElementById("name")!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(strict.snapshot().sinceKeyMs).toBeNull(); // synthetic, not the user
  });
});
