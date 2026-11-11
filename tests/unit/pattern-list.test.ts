// @vitest-environment jsdom
/** Rule Builder → Pages matching: an exact address with a ?… part can be widened in one click. */
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { PatternList } from "@/ui/rule-builder/RuleBuilder";
import type { UrlPatternInput } from "@/core/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("offers 'whatever comes after ?' only on exact addresses with a ?… part, and replaces that row with both patterns", async () => {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const onChange = vi.fn();
  const items: UrlPatternInput[] = ["https://a.test/x", "https://shop.test/track?id=9", "https://b.test/*", "exact:https://c.test/y?z=1"];
  await act(async () => root.render(createElement(PatternList, { label: "Pages matching", items, onChange })));
  const widen = [...el.querySelectorAll("button")].filter((b) => b.textContent?.startsWith("Match this page whatever comes after"));
  expect(widen).toHaveLength(2);
  await act(async () => widen[0]!.click());
  expect(onChange).toHaveBeenCalledWith([
    "https://a.test/x",
    { type: "exact", value: "https://shop.test/track" },
    { type: "glob", value: "https://shop.test/track?*" },
    "https://b.test/*",
    "exact:https://c.test/y?z=1",
  ]);
  await act(async () => root.unmount());
  el.remove();
});
