/** "Refresh until something appears": create the rule for this page and hand the tab over to it. */
import { api, requestOrigins } from "../shared/api";
import type { Rule } from "../../core/types";
import { priorityAbove, untilRule, type UntilMode } from "./describe";
import type { TabState } from "./parts";

export interface UntilRequest {
  state: TabState;
  tabId: number;
  site: string;
  origin: string | null;
  seconds: number;
  text: string;
  mode: UntilMode;
  anyQuery: boolean;
  /** Settings → "Stop watching after" (minutes, null = no limit). */
  stopAfterMinutes: number | null;
}

/**
 * Asks for site access when needed (the page must be read), creates the
 * rule above the rules already matching the page, hands the tab over (a tab
 * timer outranks rules) and checks at once.
 *
 * `done: false`: nothing was set up (the form stays open). `warning`: the rule
 * was saved but another rule still controls the tab.
 */
export async function startUntil(r: UntilRequest, run: (method: string, params?: unknown) => Promise<unknown>): Promise<{ done: boolean; warning?: string }> {
  if (!r.state.hostAccess && r.origin && !(await requestOrigins([r.origin]).catch(() => false))) {
    return { done: false, warning: `JustRefresh needs access to ${r.site} to read the page. Nothing was set up.` };
  }
  // "Disappears" only counts text that has been on the page: make sure it is there now,
  // or a typo would refresh forever without saying so.
  if (r.mode === "disappears") {
    const missing = await textMissing(r.tabId, r.state.tab.url, r.text, r.anyQuery);
    if (missing) return { done: false, warning: missing };
  }
  const rule = untilRule({
    url: r.state.tab.url,
    site: r.site,
    seconds: r.seconds,
    text: r.text,
    mode: r.mode,
    // Outrank rules already matching this page, or the new one would never run here.
    priority: priorityAbove(r.state.resolution.candidates),
    stopAfterSeconds: r.stopAfterMinutes ? r.stopAfterMinutes * 60 : null,
    anyQuery: r.anyQuery,
  });
  const created = (await run("createRule", { rule })) as Rule | null;
  if (!created) return { done: false };
  if (r.state.override?.mode === "custom") await run("clearTabOverride", { tabId: r.tabId });
  const after = (await api("getTabState", { tabId: r.tabId }).catch(() => null)) as TabState | null;
  if (after && after.resolution.controllerId !== created.id) {
    return {
      done: true,
      warning: `The rule was saved, but “${after.resolution.controllerName ?? "another rule"}” still controls this tab. Raise the new rule's priority in the Rule Builder.`,
    };
  }
  await run("runNow", { tabId: r.tabId });
  return { done: true };
}

/**
 * Why "disappears" can't start: the text isn't on the tab's page now. null =
 * it is, or the page couldn't be checked (then the rule still waits to see it).
 */
export async function textMissing(tabId: number, url: string, text: string, anyQuery?: boolean): Promise<string | null> {
  const probe = untilRule({ url, site: "check", seconds: 60, text, mode: "appears", anyQuery });
  const test = (await api("testRule", { rule: probe, tabId }).catch(() => null)) as { result?: { status: string } } | null;
  if (test?.result?.status !== "not_matched") return null;
  return `“${text.trim()}” isn't on this page now, so it can't disappear. Check the spelling, or start when the page shows it.`;
}
