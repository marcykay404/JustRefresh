import { describeCondition } from "@/ui/rule-builder/ConditionEditor";
import type { ConditionNode } from "@/core/types";

it("describes conditions in words, nested ones included", () => {
  const tree = {
    type: "all",
    conditions: [
      { type: "dom.exists", selector: "#buy" },
      { type: "any", conditions: [{ type: "dom.text", operator: "not_contains", value: "Sold out" }, { type: "refreshCount", operator: ">=", value: 3 }] },
      { type: "not", condition: { type: "tab.status", value: "loading" } },
      { type: "dom.attribute", selector: "a", attribute: "href", operator: "exists" },
      { type: "url.match", pattern: { type: "glob", value: "*/cart" } },
    ],
  } as ConditionNode;
  expect(describeCondition(tree)).toBe(
    '#buy exists AND page text not contains "Sold out" OR refresh count >= 3 AND NOT (tab is loading) AND a[href] exists AND URL matches {"type":"glob","value":"*/cart"}',
  );
  expect(describeCondition({ type: "custom.thing" } as ConditionNode)).toBe("custom.thing");
  expect(describeCondition({ type: "__proto__" } as ConditionNode)).toBe("__proto__");
});
