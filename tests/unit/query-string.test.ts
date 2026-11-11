/**
 * Exact-page rules and the "?…" part of an address: some sites change it on
 * every load (the tab would silently drop out of the rule), on others it
 * decides what the page is. The user chooses; a tab that dropped out says so.
 */
import { validateRule } from "@/core/rule-schema";
import { rulesForOtherQuery } from "@/core/rule-resolver";
import { matchesAny } from "@/core/url-pattern";
import { TEMPLATES, type TemplateValues } from "@/ui/dashboard/templates";
import { hasQuery, pagePatterns, untilRule, withoutQuery } from "@/ui/popup/describe";
import { makeRule } from "../helpers/fixtures";

const URL_Q = "https://shop.test/track?order=42&t=1731";

describe("page patterns", () => {
  it("only this exact address by default, or when the address has no ?… part", () => {
    expect(pagePatterns(URL_Q)).toEqual([{ type: "exact", value: URL_Q }]);
    expect(pagePatterns("https://shop.test/track", true)).toEqual([{ type: "exact", value: "https://shop.test/track" }]);
  });

  it("'whatever comes after ?' matches the page with any or no ?… part, and nothing else", () => {
    const p = pagePatterns(URL_Q, true);
    for (const url of [URL_Q, "https://shop.test/track?order=42&t=9999", "https://shop.test/track", "https://shop.test/track?x#y"]) {
      expect(matchesAny(p, url), url).not.toBeNull();
    }
    for (const url of ["https://shop.test/track/other", "https://shop.test/tracker?order=42", "https://other.test/track?order=42"]) {
      expect(matchesAny(p, url), url).toBeNull();
    }
  });

  it("helpers", () => {
    expect(hasQuery(URL_Q)).toBe(true);
    expect(hasQuery("https://shop.test/track?")).toBe(false);
    expect(hasQuery("not a url")).toBe(false);
    expect(withoutQuery("https://shop.test/track?a=1#b")).toBe("https://shop.test/track");
  });

  it("the popup's Refresh until and the page templates use the choice", () => {
    const r = untilRule({ url: URL_Q, site: "shop.test", seconds: 60, text: "Delivered", mode: "appears", anyQuery: true });
    expect(validateRule(r).valid).toBe(true);
    expect(matchesAny(r.target!.patterns, "https://shop.test/track?order=42&t=2")).not.toBeNull();
    const v: TemplateValues = {
      url: URL_Q,
      text: "x",
      seconds: 300,
      start: "08:00",
      end: "18:00",
      stopAfterMinutes: null,
      priority: 0,
      protects: false,
      anyQuery: true,
    };
    for (const t of TEMPLATES.filter((x) => x.scope === "page")) {
      const rule = t.build({ ...v, text: t.text?.initial ?? "" });
      expect(validateRule(rule).valid, t.id).toBe(true);
      expect(matchesAny(rule.target!.patterns, "https://shop.test/track?t=3"), t.id).not.toBeNull();
      expect(t.describe(v), t.id).toContain("shop.test/track (whatever comes after “?”)");
      expect(t.describe({ ...v, anyQuery: false }), t.id).toContain("shop.test/track?order=42&t=1731");
    }
  });
});

describe("rules set for this page with another ?… part", () => {
  const rule = (id: string, patterns: string[], extra = {}) => makeRule({ id, target: { patterns }, ...extra });

  it("are listed when they don't run here only because of the ?… part", () => {
    const rules = [
      rule("other-query", [URL_Q]),
      rule("no-query", ["https://shop.test/track"]),
      rule("matches", ["https://shop.test/track?order=42&t=2000"]),
      rule("other-page", ["https://shop.test/orders?order=42"]),
      rule("glob", ["https://shop.test/track?order=41*"]),
      rule("off", [URL_Q], { enabled: false }),
    ];
    const here = "https://shop.test/track?order=42&t=2000";
    expect(rulesForOtherQuery(rules, here).map((r) => r.id)).toEqual(["other-query", "no-query"]);
  });

  it("are not listed for a #fragment-only difference, or when an exclusion covers the page", () => {
    expect(rulesForOtherQuery([rule("hash", ["https://shop.test/track#a"])], "https://shop.test/track#b")).toEqual([]);
    const excluded = makeRule({ id: "ex", target: { patterns: [URL_Q], exclusions: ["https://shop.test/track*"] } });
    expect(rulesForOtherQuery([excluded], "https://shop.test/track?t=1")).toEqual([]);
  });
});

describe("review of the ?… choice", () => {
  it('works for file: pages (whose origin is "null")', () => {
    const p = pagePatterns("file:///Users/x/a.html?x=1", true);
    expect(p).toEqual([{ type: "regex", value: "^file:///Users/x/a\\.html(\\?[^#]*)?(#.*)?$" }]);
    expect(matchesAny(p, "file:///Users/x/a.html")).not.toBeNull();
    expect(matchesAny(p, "file:///Users/x/a.html#top")).not.toBeNull();
    expect(matchesAny(p, "file:///Users/x/a.htmlx")).toBeNull();
    expect(validateRule(untilRule({ url: "file:///Users/x/a.html?x=1", site: "a.html", seconds: 60, text: "x", mode: "appears", anyQuery: true })).valid).toBe(
      true,
    );
    expect(matchesAny(p, "file:///Users/x/a.html?x=2")).not.toBeNull();
  });

  it("a rule whose address differs only after # is not reported as a different ?… part", () => {
    expect(rulesForOtherQuery([makeRule({ id: "h", target: { patterns: ["https://shop.test/a?x=1#f"] } })], "https://shop.test/a?x=1")).toEqual([]);
  });
});

it("a * in the path stays literal", () => {
  const p = pagePatterns("https://shop.test/a*b?x=1", true);
  expect(matchesAny(p, "https://shop.test/a*b?y=2")).not.toBeNull();
  expect(matchesAny(p, "https://shop.test/aZZZb?y=2")).toBeNull();
});
