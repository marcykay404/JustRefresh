import { groupOrigins, hasAllSites } from "@/ui/shared/site-access";

describe("Settings site-access grouping", () => {
  it("shows 'grant all sites' (http + https patterns) as one row that removes both", () => {
    const groups = groupOrigins(["https://*/*", "http://*/*"]);
    expect(groups).toEqual([{ key: "all", kind: "all", label: "All websites", schemes: ["http", "https"], origins: ["http://*/*", "https://*/*"] }]);
  });

  it("groups a site's schemes, keeps distinct sites apart and puts all-sites and files first", () => {
    const groups = groupOrigins(["https://github.com/*", "http://github.com/*", "https://*.trip.com/*", "file:///*", "https://*/*"]);
    expect(groups.map((g) => [g.label, g.schemes, g.origins.length])).toEqual([
      ["All websites", ["https"], 1],
      ["Local files (file://)", [], 1],
      ["*.trip.com", ["https"], 1],
      ["github.com", ["http", "https"], 2],
    ]);
  });

  it("knows when every site is already granted", () => {
    expect(hasAllSites(["http://*/*", "https://*/*"])).toBe(true);
    expect(hasAllSites(["https://*/*"])).toBe(false);
    expect(hasAllSites(["<all_urls>"])).toBe(true);
    expect(hasAllSites([])).toBe(false);
  });
});

import { describeUsage, siteUsage, type SiteGroup } from "@/ui/shared/site-access";

describe("site usage", () => {
  const group = (origins: string[]): SiteGroup => groupOrigins(origins)[0]!;
  const tabs = [
    { url: "https://github.com/a", status: "scheduled" },
    { url: "https://github.com/b", status: "paused_activity" },
    { url: "https://gist.github.com/x", status: "scheduled" },
    { url: "https://amap.com/", status: "idle" }, // open but not refreshing
    { url: "https://trip.com/", status: "excluded" },
  ];
  const rules = [{ name: "Stock", patterns: ["https://*.trip.com/*", { value: "^https://shop\\.example\\.com/" }] }];

  it("counts running tabs on the exact host, not open idle or excluded tabs", () => {
    expect(siteUsage(group(["https://github.com/*"]), tabs, rules)).toEqual({ tabs: 2, rules: [] });
    expect(siteUsage(group(["https://amap.com/*"]), tabs, rules)).toEqual({ tabs: 0, rules: [] });
  });

  it("matches wildcard subdomains and rule patterns (including regex escapes)", () => {
    expect(siteUsage(group(["https://*.github.com/*"]), tabs, rules).tabs).toBe(3);
    expect(siteUsage(group(["https://*.trip.com/*"]), tabs, rules).rules).toEqual(["Stock"]);
    expect(siteUsage(group(["https://shop.example.com/*"]), tabs, rules).rules).toEqual(["Stock"]);
  });

  it("describes usage in words", () => {
    expect(describeUsage({ tabs: 0, rules: [] })).toBe("Not in use");
    expect(describeUsage({ tabs: 1, rules: [] })).toBe("Used by 1 tab");
    expect(describeUsage({ tabs: 2, rules: ["Stock"] })).toBe("Used by 2 tabs and rule “Stock”");
  });
});
