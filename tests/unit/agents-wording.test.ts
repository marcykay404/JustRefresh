import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { operationLabel, RuleInWords } from "@/ui/dashboard/AgentsView";
import { makeRule } from "../helpers/fixtures";

describe("agent activity log wording", () => {
  it("turns API operation names into words", () => {
    expect(operationLabel("createRule")).toBe("Create rule");
    expect(operationLabel("requestActivation")).toBe("Request activation");
    expect(operationLabel("listTabs")).toBe("List tabs");
    expect(operationLabel("pair")).toBe("Ask to connect");
  });
});


describe("approval card: the rule in words", () => {
  const words = (input: Parameters<typeof makeRule>[0]) =>
    renderToStaticMarkup(createElement(RuleInWords, { rule: makeRule(input) })).replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

  it("says what it does and which pages it covers, with exceptions and limits", () => {
    const text = words({
      id: "a",
      target: { patterns: ["https://shop.test/item/*", "shop.test/sale"], exclusions: ["https://shop.test/item/checkout*"] },
      trigger: { type: "interval", seconds: 300 },
      stopWhen: { type: "dom.text", operator: "contains", value: "In stock" },
      actions: { onMatched: [{ type: "stopRefresh" }, { type: "notify" }], onNotMatched: [{ type: "refresh" }] },
      limits: { maxDurationSeconds: 1200 },
    } as never);
    expect(text).toContain("Refreshing every 5 min until “In stock” appears, then notify me (stops after 20 min).");
    expect(text).toContain("On pages matching any of https://shop.test/item/*, shop.test/sale, except https://shop.test/item/checkout*.");
    expect(text).not.toContain("every website");
  });

  it("warns when it can run on every website", () => {
    expect(words({ id: "b", target: { patterns: ["*://*/*"] } })).toContain("This rule can run on every website.");
    expect(words({ id: "c", target: { patterns: ["regex:.*"] } })).toContain("This rule can run on every website.");
  });

  it("names startup and manual triggers in words", () => {
    expect(words({ id: "d", trigger: { type: "startup" } } as never)).toContain("Refreshing once when the browser starts.");
    expect(words({ id: "e", trigger: { type: "manual" } } as never)).toContain("Refreshing only when you run it.");
  });
});
