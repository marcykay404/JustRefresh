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

/** `result`: what happened to this click's request (null: nothing ran, e.g. the tab moved on). */
export function askAccessThen(origin: string, then: AfterAccessRequest): Promise<{ granted: boolean; result: AfterAccessResult | null }> {
  const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  void api("afterAccess", { id, origins: [origin], ...then }).catch(() => undefined);
  return requestOrigins([origin])
    .catch(() => false)
    .then(async (granted) => {
      if (!granted) {
        // Declined: don't leave it waiting to start later by surprise (only this click's request).
        await api("takeAfterAccess", { tabId: then.params.tabId, id }).catch(() => null);
        return { granted, result: null };
      }
      // Still open: whichever side ran it (Chrome's event may come first), say what happened.
      const result = ((await api("runAfterAccess", { id }).catch(() => null)) as AfterAccessResult | null) ?? null;
      return { granted, result };
    });
}

/**
 * A page about to ask Chrome for these sites itself (dashboard): drop what
 * declined popup clicks left waiting for them, so granting here can't start those.
 * Sent before the request, in the same click.
 */
export function cancelAfterAccessFor(origins: string[]): void {
  void api("cancelAfterAccessFor", { origins }).catch(() => null);
}

/** Cancel what a declined click left waiting (e.g. the user chose "refresh without protection" instead). */
export function cancelAfterAccess(tabId: number): Promise<unknown> {
  return api("takeAfterAccess", { tabId }).catch(() => null);
}
