/**
 * Optional host permissions & dynamic content-script registration.
 *
 * The extension installs with NO host permissions. Site access is requested
 * per origin when the user enables refresh on a tab (or globally from
 * Settings). Content scripts are registered only for granted origins so
 * activity monitoring starts at document_start on those pages.
 */
import { normalizeUrl } from "../core/url-pattern";
import { withTimeout } from "../core/timeout";

export const CONTENT_SCRIPT_ID = "justrefresh-content";

export function originPattern(url: string): string | null {
  const u = normalizeUrl(url);
  if (!u) return null;
  if (u.protocol === "file:") return "file:///*";
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return `${u.protocol}//${u.hostname}/*`;
}

export async function hasHostAccess(url: string): Promise<boolean> {
  const origin = originPattern(url);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

export async function grantedOrigins(): Promise<string[]> {
  const p = await chrome.permissions.getAll();
  return p.origins ?? [];
}

/** Keep the registered content script's matches in sync with granted origins. */
export async function syncContentScripts(): Promise<void> {
  const origins = await grantedOrigins();
  const registered = await chrome.scripting.getRegisteredContentScripts();
  // Registrations persist across updates: drop any this version doesn't use
  // (e.g. one registered under an older id), or the page would get two copies.
  const stale = registered.map((s) => s.id).filter((id) => id !== CONTENT_SCRIPT_ID);
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  const existing = registered.filter((s) => s.id === CONTENT_SCRIPT_ID);
  if (!origins.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    return;
  }
  const script: chrome.scripting.RegisteredContentScript = {
    id: CONTENT_SCRIPT_ID,
    js: ["content.js"],
    matches: origins,
    runAt: "document_start",
    allFrames: false,
    persistAcrossSessions: true,
  };
  if (existing.length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

/** Inject into already-open tabs that match newly granted origins. */
export async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id === undefined || !t.url || !(await hasHostAccess(t.url))) continue;
    try {
      await withTimeout(chrome.scripting.executeScript({ target: { tabId: t.id, frameIds: [0] }, files: ["content.js"] }), 5000, "Content script injection");
    } catch {
      /* tab may be discarded or restricted */
    }
  }
}
