import { validateRule } from "@/core/rule-schema";
import { matchesAny } from "@/core/url-pattern";
import { describeRule, intervalChips, intervalLabel, untilRule } from "@/ui/popup/describe";

describe("popup wording helpers", () => {
  it("labels intervals in words", () => {
    expect([5, 30, 60, 90, 300, 3600, 5400, 7200].map(intervalLabel)).toEqual([
      "5 sec", "30 sec", "1 min", "1 min 30 sec", "5 min", "1 hour", "1 hr 30 min", "2 hours",
    ]);
  });

  it("offers fast chips only when fast intervals are allowed", () => {
    expect(intervalChips(false)).toEqual([30, 60, 300, 900, 3600]);
    expect(intervalChips(true)[0]).toBe(10);
  });

  it("summarises a rule in one line", () => {
    const base = { trigger: { type: "interval", seconds: 600 } as never, actions: { onMatched: [{ type: "notify" }], onNotMatched: [] } as never };
    expect(describeRule({ ...base, stopWhen: { type: "dom.text", operator: "contains", value: "S$ 3", selector: ".price" } as never })).toBe(
      "Refreshing every 10 min until “S$ 3” appears in .price, then notify me",
    );
    expect(describeRule({ ...base, stopWhen: undefined })).toBe("Refreshing every 10 min");
    expect(
      describeRule({ ...base, stopWhen: { type: "any", conditions: [{ type: "dom.exists", selector: "#a" }, { type: "dom.exists", selector: "#b" }] } as never }),
    ).toBe("Refreshing every 10 min until any of 2 conditions match, then notify me");
  });
});

describe("Refresh until something appears", () => {
  const url = "https://shop.example.com/item/42?colour=red";
  it("creates a valid rule for exactly this page that stops and notifies with a sound", () => {
    const input = untilRule({ url, site: "shop.example.com", seconds: 60, text: "  In stock ", mode: "appears" });
    const v = validateRule(input);
    expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(v.valid).toBe(true);
    const r = v.normalized!;
    expect(r.enabled).toBe(true);
    expect(r.stopWhen).toMatchObject({ type: "dom.text", operator: "contains", value: "In stock", caseSensitive: false });
    expect(r.actions.onMatched.map((a) => a.type)).toEqual(["stopRefresh", "notify"]);
    expect(r.actions.onMatched[1]).toMatchObject({ sound: true, title: "Found “In stock”" });
    expect(r.actions.onNotMatched.map((a) => a.type)).toEqual(["refresh"]);
    expect(describeRule(r)).toBe("Refreshing every 1 min until “In stock” appears, then notify me");
  });

  it("matches this exact page only", () => {
    const pattern = untilRule({ url, site: "shop.example.com", seconds: 60, text: "x", mode: "appears" }).target.patterns[0]!;
    expect(matchesAny([pattern], url)).not.toBeNull();
    expect(matchesAny([pattern], "https://shop.example.com/item/43?colour=red")).toBeNull();
  });

  it("supports 'disappears'", () => {
    const r = untilRule({ url, site: "shop.example.com", seconds: 300, text: "Sold out", mode: "disappears" });
    expect(r.stopWhen).toMatchObject({ operator: "not_contains", value: "Sold out" });
    expect(validateRule(r).valid).toBe(true);
  });
});
