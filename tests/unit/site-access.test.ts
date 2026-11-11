import { groupOrigins, hasAllSites } from "@/ui/shared/site-access";

describe("Settings site-access grouping", () => {
  it("shows 'grant all sites' (http + https patterns) as one row that removes both", () => {
    const groups = groupOrigins(["https://*/*", "http://*/*"]);
    expect(groups).toEqual([
      { key: "all", kind: "all", label: "All websites", schemes: ["http", "https"], origins: ["http://*/*", "https://*/*"] },
    ]);
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
