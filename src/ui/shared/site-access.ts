/**
 * Grouping of granted host permissions for display. Chrome stores one match
 * pattern per scheme, so "all sites" is two entries (http://*\/* and
 * https://*\/*) and a site granted for both schemes is two entries too. Users
 * think in sites, so the Settings card shows one row per site and removes all
 * of its patterns together.
 */
export type SiteGroup = {
  /** Stable key: "all", "file" or the host (wildcard subdomains kept, e.g. "*.example.com"). */
  key: string;
  kind: "all" | "file" | "host";
  label: string;
  /** Schemes covered, e.g. ["http", "https"]; empty for file access. */
  schemes: string[];
  /** The exact granted patterns, to pass to chrome.permissions.remove. */
  origins: string[];
};

const ALL_SITE_PATTERNS = ["http://*/*", "https://*/*"];

const BOTH_SCHEMES = ["http", "https"] as const;
const ALL_WEBSITES = { key: "all", kind: "all", label: "All websites" } as const;

/** One granted pattern: the site it belongs to and the schemes it covers. */
function parseOrigin(o: string): Pick<SiteGroup, "key" | "kind" | "label"> & { schemes: readonly string[] } {
  // Not requested by JustRefresh, but shown correctly if granted some other way.
  if (o === "<all_urls>") return { ...ALL_WEBSITES, schemes: BOTH_SCHEMES };
  if (o.startsWith("file://")) return { key: "file", kind: "file", label: "Local files (file://)", schemes: [] };
  const m = /^([a-z*]+):\/\/([^/]+)\//.exec(o);
  const host = m?.[2] ?? o;
  const scheme = m?.[1];
  const schemes = scheme === "*" ? BOTH_SCHEMES : scheme ? [scheme] : [];
  return host === "*" ? { ...ALL_WEBSITES, schemes } : { key: host, kind: "host", label: host, schemes };
}

export function groupOrigins(origins: readonly string[]): SiteGroup[] {
  const groups = new Map<string, SiteGroup>();
  for (const o of origins) {
    const { schemes, ...site } = parseOrigin(o);
    const g = groups.get(site.key) ?? { ...site, schemes: [], origins: [] };
    g.origins.push(o);
    for (const s of schemes) if (!g.schemes.includes(s)) g.schemes.push(s);
    groups.set(site.key, g);
  }
  const rank = { all: 0, file: 1, host: 2 } as const;
  return [...groups.values()]
    .map((g) => ({ ...g, schemes: g.schemes.sort(), origins: g.origins.sort() }))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label));
}

/** True when every http and https site is already granted. */
export function hasAllSites(origins: readonly string[]): boolean {
  if (origins.includes("<all_urls>") || origins.includes("*://*/*")) return true;
  return ALL_SITE_PATTERNS.every((p) => origins.includes(p));
}

export { ALL_SITE_PATTERNS };

/** What the usage check needs from a tab row (getOverview) and a rule. */
export interface UsageTab {
  url: string;
  /** Status from getOverview: "idle" / "excluded" / "stopped" etc. mean nothing runs there. */
  status: string;
}
export interface UsageRule {
  name: string;
  patterns: readonly (string | { value: string })[];
}
export interface SiteUsage {
  tabs: number;
  rules: string[];
}

const ACTIVE_TAB = (status: string) => !["idle", "excluded", "stopped", "completed"].includes(status);

function hostMatches(groupHost: string, hostname: string): boolean {
  if (groupHost.startsWith("*.")) {
    const base = groupHost.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  }
  return hostname === groupHost;
}

/**
 * Which running tabs and rules use a site. Tabs match by host exactly; rules
 * by their patterns mentioning the host (a hint: patterns can be regexes).
 * "All websites" is used by anything running anywhere.
 */
export function siteUsage(g: SiteGroup, tabs: readonly UsageTab[], rules: readonly UsageRule[]): SiteUsage {
  const running = tabs.filter((t) => ACTIVE_TAB(t.status));
  if (g.kind === "all") {
    return { tabs: running.filter((t) => /^https?:/.test(t.url)).length, rules: rules.map((r) => r.name) };
  }
  if (g.kind === "file") {
    const usedByRule = (r: UsageRule) => r.patterns.some((p) => (typeof p === "string" ? p : p.value).startsWith("file:"));
    return { tabs: running.filter((t) => t.url.startsWith("file:")).length, rules: rules.filter(usedByRule).map((r) => r.name) };
  }
  const tabCount = running.filter((t) => {
    try {
      return hostMatches(g.key, new URL(t.url).hostname);
    } catch {
      return false;
    }
  }).length;
  const host = g.key.replace(/^\*\./, "").toLowerCase();
  const ruleNames = rules
    .filter((r) => r.patterns.some((p) => (typeof p === "string" ? p : p.value).replace(/\\/g, "").toLowerCase().includes(host)))
    .map((r) => r.name);
  return { tabs: tabCount, rules: ruleNames };
}

export const inUse = (u: SiteUsage) => u.tabs > 0 || u.rules.length > 0;

/** "Used by 2 tabs and rule “Stock”" / "Not in use". */
export function describeUsage(u: SiteUsage): string {
  const parts: string[] = [];
  if (u.tabs) parts.push(`${u.tabs} tab${u.tabs === 1 ? "" : "s"}`);
  if (u.rules.length) parts.push(`${u.rules.length === 1 ? "rule" : "rules"} ${u.rules.map((n) => `“${n}”`).join(", ")}`);
  return parts.length ? `Used by ${parts.join(" and ")}` : "Not in use";
}
