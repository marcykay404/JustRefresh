/**
 * Tab-instance restoration. Chrome tab ids are not stable across browser
 * restarts, so per-tab overrides are re-associated by URL:
 *  1. same tab id and same URL → keep
 *  2. exactly one open tab with the same URL → reassign
 *  3. several candidates → pick the one at the same tab index, else ambiguous
 *  4. no candidate → dropped (the tab was closed; closed tabs are never reopened)
 */
import type { TabInfo, TabOverride } from "../core/types";

export interface RestoreResult {
  overrides: Record<string, TabOverride>;
  restored: { from: number; to: number }[];
  ambiguous: TabOverride[];
  dropped: TabOverride[];
}

export function restoreTabOverrides(overrides: Record<string, TabOverride>, tabs: TabInfo[]): RestoreResult {
  const out: Record<string, TabOverride> = {};
  const restored: RestoreResult["restored"] = [];
  const ambiguous: TabOverride[] = [];
  const dropped: TabOverride[] = [];
  const taken = new Set<number>();
  const list = Object.values(overrides);

  // Pass 1: ids that still refer to the same page.
  const pending: TabOverride[] = [];
  for (const o of list) {
    const same = tabs.find((t) => t.id === o.tabId && t.url === o.restore.url);
    if (same) {
      out[String(o.tabId)] = o;
      taken.add(o.tabId);
    } else pending.push(o);
  }
  // Pass 2: URL matching among the remaining tabs.
  for (const o of pending) {
    const candidates = tabs.filter((t) => t.url === o.restore.url && !taken.has(t.id));
    let pick: TabInfo | undefined;
    if (candidates.length === 1) pick = candidates[0];
    else if (candidates.length > 1) {
      const byIndex = candidates.filter((t) => t.index === o.restore.tabIndex);
      if (byIndex.length === 1) pick = byIndex[0];
      else {
        ambiguous.push(o);
        continue;
      }
    }
    if (!pick) {
      dropped.push(o);
      continue;
    }
    taken.add(pick.id);
    out[String(pick.id)] = { ...o, tabId: pick.id, restore: { ...o.restore, tabIndex: pick.index } };
    restored.push({ from: o.tabId, to: pick.id });
  }
  return { overrides: out, restored, ambiguous, dropped };
}
