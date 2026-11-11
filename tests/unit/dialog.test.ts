// @vitest-environment jsdom
/** In-page confirm/alert dialogs that replace window.confirm()/alert(). */
import { createElement, act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DialogProvider, useDialog, type Dialogs } from "@/ui/shared/dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let el: HTMLDivElement;
let dialogs!: Dialogs;
function Grab() {
  const d = useDialog();
  useEffect(() => void (dialogs = d), [d]);
  return createElement("button", { id: "opener" }, "open");
}

beforeEach(async () => {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(createElement(DialogProvider, null, createElement(Grab))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
});

const box = () => el.querySelector<HTMLElement>("[aria-modal=true]");
const btn = (label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === label)!;
const key = (k: string, shiftKey = false) => act(async () => void box()!.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true })));

describe("in-page dialogs", () => {
  it("confirm resolves true on the confirm button and false on Cancel, then closes", async () => {
    let p!: Promise<boolean>;
    await act(async () => void (p = dialogs.confirm({ title: "Delete rule?", message: "Gone for good.", confirmLabel: "Delete" })));
    expect(box()!.getAttribute("role")).toBe("alertdialog");
    expect(box()!.textContent).toContain("Gone for good.");
    await act(async () => btn("Delete").click());
    await expect(p).resolves.toBe(true);
    expect(box()).toBeNull();

    await act(async () => void (p = dialogs.confirm({ title: "Again?" })));
    await act(async () => btn("Cancel").click());
    await expect(p).resolves.toBe(false);
  });

  it("Escape and a click on the backdrop cancel", async () => {
    let p!: Promise<boolean>;
    await act(async () => void (p = dialogs.confirm({ title: "Sure?" })));
    await key("Escape");
    await expect(p).resolves.toBe(false);

    await act(async () => void (p = dialogs.confirm({ title: "Sure?" })));
    await act(async () => void el.querySelector(".dialog-backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await expect(p).resolves.toBe(false);
  });

  it("destructive confirms focus Cancel, others focus the action; focus stays inside and returns afterwards", async () => {
    const opener = el.querySelector<HTMLButtonElement>("#opener")!;
    opener.focus();
    let p!: Promise<boolean>;
    await act(async () => void (p = dialogs.confirm({ title: "Delete?", confirmLabel: "Delete", danger: true })));
    expect(document.activeElement).toBe(btn("Cancel"));
    await key("Tab", true); // shift+tab from the first button wraps to the last
    expect(document.activeElement).toBe(btn("Delete"));
    await key("Tab"); // tab from the last wraps to the first
    expect(document.activeElement).toBe(btn("Cancel"));
    await act(async () => btn("Cancel").click());
    await p;
    expect(document.activeElement).toBe(opener);

    await act(async () => void (p = dialogs.confirm({ title: "Trust?", confirmLabel: "Trust" })));
    expect(document.activeElement).toBe(btn("Trust"));
    await act(async () => btn("Trust").click());
  });

  it("queues requests made while a dialog is open", async () => {
    let a!: Promise<boolean>, b!: Promise<void>;
    await act(async () => {
      a = dialogs.confirm({ title: "First" });
      b = dialogs.alert({ title: "Second" });
    });
    expect(box()!.textContent).toContain("First");
    await act(async () => btn("OK").click());
    await expect(a).resolves.toBe(true);
    expect(box()!.textContent).toContain("Second");
    expect(box()!.getAttribute("role")).toBe("dialog");
    await act(async () => btn("OK").click());
    await expect(b).resolves.toBeUndefined();
    expect(box()).toBeNull();
  });
});

describe("no native dialogs in the UI", () => {
  it("src/ui does not call window confirm/alert/prompt", () => {
    const files: string[] = [];
    const walk = (d: string) =>
      readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.tsx?$/.test(f) && files.push(join(d, f))));
    walk(join(__dirname, "../../src/ui"));
    // dialog.tsx defines the replacement API (methods named confirm/alert).
    const offenders = files
      .filter((f) => !f.endsWith("shared/dialog.tsx"))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ f, i: i + 1, line }))
          .filter(({ line }) => /(^|[^.\w])(window\.)?(confirm|alert|prompt)\(/.test(line)),
      );
    expect(offenders.map((o) => `${o.f}:${o.i}`)).toEqual([]);
  });
});
