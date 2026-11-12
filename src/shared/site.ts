/** Telling sites apart, for frames (used by the content script and the service worker). */

/**
 * The site a host belongs to, roughly (no public-suffix list): its last two
 * labels, or three under a country's second level ("example.com.sg",
 * "example.co.uk"). Addresses and single-label hosts are their own site.
 */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(h) || h.includes(":") || !h.includes(".")) return h;
  const labels = h.split(".");
  const countrySecondLevel = labels.at(-1)!.length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go|mil)$/.test(labels.at(-2)!);
  return labels.slice(countrySecondLevel ? -3 : -2).join(".");
}
