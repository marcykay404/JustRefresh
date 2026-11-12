/**
 * Ask Chrome for a site's access in a click, for something that needs it:
 * the service worker is told first what the click is for, and does it once
 * access is granted. On macOS Chrome closes the popup when its prompt opens,
 * so the popup can't do it afterwards itself (background/after-access.ts).
 *
 * MUST be called synchronously from the click handler (both messages are
 * sent before anything is awaited, so Chrome still sees the user's click).
 */
import { api, requestOrigins } from "./api";
import type { AfterAccessRequest, AfterAccessResult } from "../../background/after-access";

export type { AfterAccessRequest, AfterAccessResult };

export function askAccessThen(origin: string, then: AfterAccessRequest): Promise<{ granted: boolean; results: AfterAccessResult[] }> {
  void api("afterAccess", { origins: [origin], ...then }).catch(() => undefined);
  return requestOrigins([origin])
    .catch(() => false)
    .then(async (granted) => {
      // Still open: run it now and show what happened (if Chrome's event ran it first, there's nothing left).
      if (!granted) return { granted, results: [] };
      const results = ((await api("runAfterAccess").catch(() => [])) as AfterAccessResult[]) ?? [];
      return { granted, results };
    });
}
