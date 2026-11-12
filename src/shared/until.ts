/**
 * Setting up "Refresh until something appears" on a tab, once JustRefresh can
 * read the page: check the text is there (for "disappears"), create the rule,
 * hand the tab over to it and check at once. Runs in the popup, or in the
 * service worker when the popup closed while Chrome asked for access (see
 * background/after-access.ts). `call` is the Rule Management API either way.
 */
import type { Rule } from "../core/types";
import { untilRule, type UntilMode } from "../ui/popup/describe";

export type ApiCall = (method: string, params?: unknown) => Promise<unknown>;

/** Everything needed to set it up, worked out in the popup before asking Chrome for access. */
export interface UntilPlan {
  tabId: number;
  url: string;
  site: string;
  seconds: number;
  text: string;
  mode: UntilMode;
  anyQuery: boolean;
  /** Outranks the rules already matching the page (see priorityAbove). */
  priority: number;
  /** Settings → "Stop watching after" (minutes, null = no limit). */
  stopAfterMinutes: number | null;
}

/** `done: false`: nothing was set up. `warning`: why not, or what still needs doing. */
export interface UntilOutcome {
  done: boolean;
  warning?: string;
}

/**
 * Why "disappears" can't start: the text isn't on the tab's page now. null =
 * it is, or the page couldn't be checked (then the rule still waits to see it).
 */
export async function textMissing(call: ApiCall, tabId: number, url: string, text: string, anyQuery?: boolean): Promise<string | null> {
  const probe = untilRule({ url, site: "check", seconds: 60, text, mode: "appears", anyQuery });
  const test = (await call("testRule", { rule: probe, tabId }).catch(() => null)) as { result?: { status: string } } | null;
  if (test?.result?.status !== "not_matched") return null;
  return `“${text.trim()}” isn't on this page now, so it can't disappear. Check the spelling, or start when the page shows it.`;
}

export async function setUpUntil(p: UntilPlan, call: ApiCall): Promise<UntilOutcome> {
  // "Disappears" only counts text that has been on the page: make sure it is there now,
  // or a typo would refresh forever without saying so.
  if (p.mode === "disappears") {
    const missing = await textMissing(call, p.tabId, p.url, p.text, p.anyQuery);
    if (missing) return { done: false, warning: missing };
  }
  const rule = untilRule({
    url: p.url,
    site: p.site,
    seconds: p.seconds,
    text: p.text,
    mode: p.mode,
    priority: p.priority,
    stopAfterSeconds: p.stopAfterMinutes ? p.stopAfterMinutes * 60 : null,
    anyQuery: p.anyQuery,
  });
  const created = (await call("createRule", { rule })) as Rule | null;
  if (!created) return { done: false };
  // A tab timer outranks rules: hand the tab over.
  const before = (await call("getTabState", { tabId: p.tabId }).catch(() => null)) as { override: { mode: string } | null } | null;
  if (before?.override?.mode === "custom") await call("clearTabOverride", { tabId: p.tabId });
  const after = (await call("getTabState", { tabId: p.tabId }).catch(() => null)) as {
    resolution: { controllerId: string | null; controllerName: string | null };
  } | null;
  if (after && after.resolution.controllerId !== created.id) {
    return {
      done: true,
      warning: `The rule was saved, but “${after.resolution.controllerName ?? "another rule"}” still controls this tab. Raise the new rule's priority in the Rule Builder.`,
    };
  }
  await call("runNow", { tabId: p.tabId });
  return { done: true };
}
