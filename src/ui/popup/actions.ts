/** "Refresh until something appears": create the rule for this page and hand the tab over to it. */
import { api } from "../shared/api";
import { askAccessThen } from "../shared/access";
import { setUpUntil, type UntilOutcome, type UntilPlan } from "../../shared/until";
import { priorityAbove, type UntilMode } from "./describe";
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
 * Sets it up (shared/until.ts), asking for site access first when needed (the
 * page must be read). Asking happens in the click, so call it synchronously
 * from the click handler; if Chrome's prompt closes the popup, the service
 * worker finishes the job once access is granted.
 *
 * `done: false`: nothing was set up (the form stays open). `warning`: why, or
 * what still needs doing.
 */
export function startUntil(r: UntilRequest): Promise<UntilOutcome> {
  const plan: UntilPlan = {
    tabId: r.tabId,
    url: r.state.tab.url,
    site: r.site,
    seconds: r.seconds,
    text: r.text,
    mode: r.mode,
    anyQuery: r.anyQuery,
    // Outrank rules already matching this page, or the new one would never run here.
    priority: priorityAbove(r.state.resolution.candidates),
    stopAfterMinutes: r.stopAfterMinutes,
  };
  if (r.state.hostAccess || !r.origin) return setUpUntil(plan, (method, params) => api(method, params));
  return askAccessThen(r.origin, { method: "refreshUntil", params: plan }).then(({ granted, results }) => {
    if (!granted) return { done: false, warning: `JustRefresh needs access to ${r.site} to read the page. Nothing was set up.` };
    const mine = results.find((x) => x.method === "refreshUntil");
    return mine ? { done: mine.ok, warning: mine.message } : { done: true };
  });
}
