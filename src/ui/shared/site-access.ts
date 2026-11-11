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

export function groupOrigins(origins: readonly string[]): SiteGroup[] {
  const groups = new Map<string, SiteGroup>();
  for (const o of origins) {
    let key: string, kind: SiteGroup["kind"], label: string, scheme: string | null;
    if (o === "<all_urls>") {
      // Not requested by JustRefresh, but shown correctly if granted some other way.
      [key, kind, label, scheme] = ["all", "all", "All websites", null];
    } else if (o.startsWith("file://")) {
      [key, kind, label, scheme] = ["file", "file", "Local files (file://)", null];
    } else {
      const m = /^([a-z*]+):\/\/([^/]+)\//.exec(o);
      const host = m?.[2] ?? o;
      scheme = m?.[1] ?? null;
      if (host === "*") [key, kind, label] = ["all", "all", "All websites"];
      else [key, kind, label] = [host, "host", host];
    }
    const g = groups.get(key) ?? { key, kind, label, schemes: [], origins: [] };
    g.origins.push(o);
    const schemes = scheme === "*" ? ["http", "https"] : scheme ? [scheme] : o === "<all_urls>" ? ["http", "https"] : [];
    for (const s of schemes) if (!g.schemes.includes(s)) g.schemes.push(s);
    groups.set(key, g);
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
