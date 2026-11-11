/**
 * Content script entry. Injected at document_start into pages the user
 * granted access to. Responds only to messages from this extension.
 */
import { evaluateDomCondition, testSelector } from "../conditions/dom-eval";
import { CONTENT_PROTOCOL, type ContentRequest, type ContentResponse } from "../shared/messaging-types";
import { ActivityMonitor } from "./activity-monitor";

const FLAG = "__smartAutoRefreshContent__";
const g = globalThis as unknown as Record<string, unknown>;

if (!g[FLAG]) {
  g[FLAG] = true;
  const monitor = new ActivityMonitor(document);
  monitor.start();

  chrome.runtime.onMessage.addListener((msg: ContentRequest, sender, sendResponse: (r: ContentResponse) => void) => {
    if (sender.id !== chrome.runtime.id || !msg || msg.protocol !== CONTENT_PROTOCOL) return false;
    try {
      switch (msg.kind) {
        case "ping":
          sendResponse({ requestId: msg.requestId, kind: "pong", readyState: document.readyState });
          break;
        case "activity":
          sendResponse({ requestId: msg.requestId, kind: "activity", activity: monitor.snapshot() });
          break;
        case "evaluate":
          sendResponse({
            requestId: msg.requestId,
            kind: "evaluate",
            results: msg.conditions.slice(0, 100).map((c) => evaluateDomCondition(c, document, { includeText: msg.includeText })),
          });
          break;
        case "testSelector":
          sendResponse({ requestId: msg.requestId, kind: "testSelector", result: testSelector(document, msg.selector, msg.includeText) });
          break;
        default:
          return false;
      }
    } catch (e) {
      sendResponse({ requestId: (msg as { requestId: string }).requestId, kind: "error", error: (e as Error).message });
    }
    return false;
  });
}
