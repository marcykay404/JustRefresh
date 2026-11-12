/**
 * Content script entry. Injected at document_start into pages the user
 * granted access to. Responds only to messages from this extension.
 */
import { evaluateDomCondition, testSelector } from "../conditions/dom-eval";
import { CONTENT_PROTOCOL, PICK_CHANNEL, type ContentRequest, type ContentResponse, type PickMessage } from "../shared/messaging-types";
import { ActivityMonitor } from "./activity-monitor";
import { currentNavigation, detectFormResult, watchFormPosts } from "./form-post";
import { highlight, isBusy } from "./highlight";
import { clickElement, restoreScroll, saveScroll } from "./page-actions";
import { cancelPicker, startPicker } from "./picker";

/** sessionStorage, or null where the site has storage switched off. */
function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const FLAG = "__justRefreshContent__";
const g = globalThis as unknown as Record<string, unknown>;
// Set up once per page and version. Injected twice by the same version, the
// second copy does nothing. After an update the old copy is cut off (its
// listener never hears from the extension again) but its flag can remain, so
// it records the version: a newer one sets the page up again.
const version = chrome.runtime.getManifest().version;

if (g[FLAG] !== version) {
  g[FLAG] = version;
  const monitor = new ActivityMonitor(document);
  monitor.start();
  // Whether this page came from submitting a form (reloading it would send the form again).
  const formResult = detectFormResult(
    location.href,
    currentNavigation(window),
    () => sessionStorage,
    Date.now(),
    performance.timeOrigin,
    (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true,
  );
  watchFormPosts(window);

  // A refresh that asked to keep the scroll position: scroll back once the page has content.
  const store = sessionStore();
  if (store) restoreScroll(window, store);

  type Handlers = { [K in ContentRequest["kind"]]: (msg: Extract<ContentRequest, { kind: K }>) => ContentResponse };
  const handlers: Handlers = {
    ping: (msg) => ({ requestId: msg.requestId, kind: "pong", readyState: document.readyState }),
    activity: (msg) => ({ requestId: msg.requestId, kind: "activity", activity: { ...monitor.snapshot(), formResult } }),
    evaluate: (msg) => ({
      requestId: msg.requestId,
      kind: "evaluate",
      results: msg.conditions.slice(0, 100).map((c) => evaluateDomCondition(c, document, { includeText: msg.includeText })),
    }),
    testSelector: (msg) => ({ requestId: msg.requestId, kind: "testSelector", result: testSelector(document, msg.selector, msg.includeText) }),
    click: (msg) => ({ requestId: msg.requestId, kind: "click", result: clickElement(document, msg.selector) }),
    highlight: (msg) => ({
      requestId: msg.requestId,
      kind: "highlight",
      result: highlight(window, { selector: msg.selector, text: msg.text }, { busy: isBusy(monitor.snapshot()) }),
    }),
    saveScroll: (msg) => {
      if (store) saveScroll(window, store);
      return { requestId: msg.requestId, kind: "done" };
    },
    pick: (msg) => {
      startPicker(window, (r) => {
        const picked = "picked" in r ? r.picked : null;
        const message: PickMessage = {
          channel: PICK_CHANNEL,
          session: msg.session,
          selector: picked?.selector ?? null,
          ...(picked ? { count: picked.count, positional: picked.positional } : {}),
          ...("replaced" in r ? { replaced: true } : {}),
        };
        void chrome.runtime.sendMessage(message).catch(() => undefined);
      });
      return { requestId: msg.requestId, kind: "done" };
    },
    cancelPick: (msg) => {
      cancelPicker();
      return { requestId: msg.requestId, kind: "done" };
    },
  };

  chrome.runtime.onMessage.addListener((msg: ContentRequest, sender, sendResponse: (r: ContentResponse) => void) => {
    if (sender.id !== chrome.runtime.id || !msg || msg.protocol !== CONTENT_PROTOCOL || !Object.hasOwn(handlers, msg.kind)) return false;
    try {
      sendResponse((handlers[msg.kind] as (m: ContentRequest) => ContentResponse)(msg));
    } catch (e) {
      sendResponse({ requestId: msg.requestId, kind: "error", error: (e as Error).message });
    }
    return false;
  });
}
