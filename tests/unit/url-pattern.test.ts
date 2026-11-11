import { checkRegexSafety, compilePattern, detectPattern, matchesAny, restrictedReason, validatePattern } from "@/core/url-pattern";

const t = (p: Parameters<typeof compilePattern>[0], url: string) => compilePattern(p).test(url);

describe("pattern detection", () => {
  it.each([
    ["https://example.com/dashboard", "exact"],
    ["*.example.com", "domain"],
    ["example.com", "domain"],
    ["https://example.com/reports/*", "glob"],
    ["^https://example\\.com/orders/.*$", "regex"],
    ["regex:example", "regex"],
    ["glob:https://a.com/*", "glob"],
  ])("%s → %s", (input, type) => {
    expect(detectPattern(input).type).toBe(type);
  });
});

describe("exact", () => {
  it("normalizes and ignores fragment", () => {
    expect(t("https://Example.com/dashboard", "https://example.com/dashboard#x")).toBe(true);
    expect(t("https://example.com:443/dashboard", "https://example.com/dashboard")).toBe(true);
  });
  it("query must match exactly", () => {
    expect(t("https://example.com/a", "https://example.com/a?x=1")).toBe(false);
    expect(t("https://example.com/a?x=1", "https://example.com/a?x=1")).toBe(true);
  });
  it("respects fragment when pattern has one", () => {
    expect(t("https://example.com/a#b", "https://example.com/a#c")).toBe(false);
  });
});

describe("domain", () => {
  it("bare host is exact host", () => {
    expect(t("example.com", "https://example.com/x")).toBe(true);
    expect(t("example.com", "http://example.com/")).toBe(true);
    expect(t("example.com", "https://www.example.com/")).toBe(false);
  });
  it("*. matches apex and subdomains", () => {
    expect(t("*.example.com", "https://example.com/")).toBe(true);
    expect(t("*.example.com", "https://a.b.example.com/")).toBe(true);
    expect(t("*.example.com", "https://badexample.com/")).toBe(false);
  });
  it("supports port and path globs", () => {
    expect(t("localhost:3000", "http://localhost:3000/x")).toBe(true);
    expect(t("localhost:3000", "http://localhost:4000/x")).toBe(false);
    expect(t("example.com/reports/*", "https://example.com/reports/q1?x=1")).toBe(true);
    expect(t("example.com/reports/*", "https://example.com/other")).toBe(false);
  });
  it("only matches http(s)", () => {
    expect(t("example.com", "ftp://example.com/")).toBe(false);
  });
});

describe("glob", () => {
  it("matches path with wildcard including query", () => {
    expect(t("https://example.com/reports/*", "https://example.com/reports/2024/q1?a=1")).toBe(true);
    expect(t("https://example.com/reports/*", "https://example.com/report")).toBe(false);
    expect(t("https://example.com/reports/*", "http://example.com/reports/x")).toBe(false);
  });
  it("*:// matches http and https only", () => {
    expect(t("*://example.com/*", "http://example.com/a")).toBe(true);
    expect(t("*://example.com/*", "https://example.com/a")).toBe(true);
    expect(t("*://example.com/*", "file:///example.com/a")).toBe(false);
  });
  it("? is literal", () => {
    expect(t("https://a.com/search?q=*", "https://a.com/search?q=cats")).toBe(true);
    expect(t("https://a.com/searchXq=*", "https://a.com/search?q=cats")).toBe(false);
  });
  it("fragment ignored unless in pattern", () => {
    expect(t("https://a.com/*", "https://a.com/x#frag")).toBe(true);
    expect(t("https://a.com/*#top", "https://a.com/x#top")).toBe(true);
  });
  it("rejects wildcards inside hosts", () => {
    expect(validatePattern("https://ex*ample.com/*")).toMatch(/Wildcards/);
  });
});

describe("regex", () => {
  it("matches", () => {
    expect(t("^https://example\\.com/orders/.*$", "https://example.com/orders/1")).toBe(true);
    expect(t("^https://example\\.com/orders/.*$", "https://example.com/other")).toBe(false);
  });
  it.each(["(a+)+$", "(a*)*", "(a|aa)+", "(.*a){3}x", "\\1", "(a"])("rejects unsafe %s", (re) => {
    expect(checkRegexSafety(re)).not.toBeNull();
  });
  it.each(["^https://a\\.com/(foo|bar)/\\d+$", "[a-z]+\\.com", "(ab){2}"])("accepts %s", (re) => {
    expect(checkRegexSafety(re)).toBeNull();
  });
});

describe("matchesAny / restricted", () => {
  it("ignores invalid patterns", () => {
    expect(matchesAny(["(a+)+", "example.com"], "https://example.com/")).toBe("example.com");
  });
  it("flags restricted URLs", () => {
    expect(restrictedReason("chrome://settings")).toMatch(/Browser-internal/);
    expect(restrictedReason("https://chromewebstore.google.com/detail/x")).toMatch(/Web Store/);
    expect(restrictedReason("https://example.com")).toBeNull();
    expect(restrictedReason(undefined)).toMatch(/not accessible/);
  });
});
