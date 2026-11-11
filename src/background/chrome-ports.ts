/**
 * Chrome-backed implementations of the engine ports.
 */
import type { AlarmPort, BrowserPort, ClockPort, PagePort } from "../core/rule-engine";
import { restrictedReason } from "../core/url-pattern";
import type { ConditionNode, EvaluationResult, TabInfo } from "../core/types";
import { CONTENT_PROTOCOL, OFFSCREEN_CHANNEL, type ActivitySnapshot, type ContentRequest, type ContentResponse, type OffscreenMessage } from "../shared/messaging-types";
import { hasHostAccess } from "./host-access";
import { withTimeout } from "../core/timeout";

export function toTabInfo(t: chrome.tabs.Tab): TabInfo | null {
  if (t.id === undefined || t.id < 0) return null;
  const url = t.url ?? t.pendingUrl ?? "";
  return {
    id: t.id,
    windowId: t.windowId,
    index: t.index,
    title: t.title ?? "",
    url,
    active: t.active,
    discarded: t.discarded,
    status: t.status,
    restricted: restrictedReason(url) !== null,
  };
}

export const chromeBrowser: BrowserPort = {
  async getTab(tabId) {
    try {
      return toTabInfo(await chrome.tabs.get(tabId));
    } catch {
      return null;
    }
  },
  async listTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map(toTabInfo).filter((t): t is TabInfo => t !== null);
  },
  async reload(tabId, bypassCache) {
    await chrome.tabs.reload(tabId, { bypassCache });
  },
  async notify(id, title, message, opts) {
    try {
      await chrome.notifications.create(id, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title,
        message: message.slice(0, 300),
        priority: 1,
      });
    } catch (e) {
      console.warn("Notification failed", e);
    }
    if (opts?.sound) await playAlertSound();
  },
};

const OFFSCREEN_URL = "offscreen.html";

/** Service workers cannot play audio: use an offscreen document (AUDIO_PLAYBACK). */
async function playAlertSound() {
  try {
    const url = chrome.runtime.getURL(OFFSCREEN_URL);
    const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
    if (!existing.length) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: "Play the alert sound of a notify action",
      });
    }
    const msg: OffscreenMessage = { channel: OFFSCREEN_CHANNEL, kind: "play" };
    await chrome.runtime.sendMessage(msg);
  } catch (e) {
    console.warn("Alert sound failed", e);
  }
}

export const chromeAlarms: AlarmPort = {
  async set(name, when) {
    await chrome.alarms.create(name, { when });
  },
  async clear(name) {
    await chrome.alarms.clear(name);
  },
  async getAll() {
    return (await chrome.alarms.getAll()).map((a) => ({ name: a.name, scheduledTime: a.scheduledTime }));
  },
};

export const systemClock: ClockPort = { now: () => Date.now(), random: () => Math.random() };

let seq = 0;
const requestId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

const MESSAGE_TIMEOUT_MS = 3000;
const INJECT_TIMEOUT_MS = 5000;

async function send<K extends ContentResponse["kind"]>(tabId: number, req: ContentRequest, expect: K): Promise<Extract<ContentResponse, { kind: K }>> {
  const res = (await withTimeout(chrome.tabs.sendMessage(tabId, req, { frameId: 0 }), MESSAGE_TIMEOUT_MS, "Content script")) as ContentResponse | undefined;
  if (!res) throw new Error("No response from content script");
  if (res.requestId !== req.requestId) throw new Error("Stale response discarded");
  if (res.kind === "error") throw new Error(res.error);
  if (res.kind !== expect) throw new Error(`Unexpected response ${res.kind}`);
  return res as Extract<ContentResponse, { kind: K }>;
}

/** Ensure the content script is present; inject it on demand if we have access. */
async function ensureContent(tabId: number): Promise<{ ok: true } | { ok: false; reason: string; code: "missing_permission" | "content_script_unavailable" | "restricted_url" }> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, reason: "Tab not found", code: "content_script_unavailable" };
  }
  const url = tab.url ?? "";
  const restricted = restrictedReason(url);
  if (restricted) return { ok: false, reason: restricted, code: "restricted_url" };
  if (!(await hasHostAccess(url))) return { ok: false, reason: "Site access not granted for this page", code: "missing_permission" };
  try {
    await send(tabId, { protocol: CONTENT_PROTOCOL, requestId: requestId(), kind: "ping" }, "pong");
    return { ok: true };
  } catch {
    /* not injected yet */
  }
  try {
    // executeScript has no timeout of its own and can stall indefinitely
    // (e.g. page paused in a debugger, tab driven via chrome.debugger).
    await withTimeout(chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] }), INJECT_TIMEOUT_MS, "Content script injection");
    await send(tabId, { protocol: CONTENT_PROTOCOL, requestId: requestId(), kind: "ping" }, "pong");
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `Content script unavailable: ${(e as Error).message}`, code: "content_script_unavailable" };
  }
}

export const chromePage: PagePort & { testSelector(tabId: number, selector: string, includeText: boolean): Promise<unknown> } = {
  async evaluate(tabId: number, leaves: ConditionNode[], includeText: boolean): Promise<EvaluationResult[]> {
    const ok = await ensureContent(tabId);
    if (!ok.ok) return leaves.map(() => ({ status: "unknown", code: ok.code, reason: ok.reason }));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await send(tabId, { protocol: CONTENT_PROTOCOL, requestId: requestId(), kind: "evaluate", conditions: leaves, includeText }, "evaluate");
        return res.results;
      } catch (e) {
        if (attempt === 2) {
          return leaves.map(() => ({ status: "unknown", code: "timeout", reason: (e as Error).message }));
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return leaves.map(() => ({ status: "unknown", code: "evaluation_error", reason: "unreachable" }));
  },
  async activity(tabId: number): Promise<{ activity: ActivitySnapshot | null; reason?: string }> {
    const ok = await ensureContent(tabId);
    if (!ok.ok) return { activity: null, reason: ok.reason };
    try {
      const res = await send(tabId, { protocol: CONTENT_PROTOCOL, requestId: requestId(), kind: "activity" }, "activity");
      return { activity: res.activity };
    } catch (e) {
      return { activity: null, reason: (e as Error).message };
    }
  },
  async testSelector(tabId, selector, includeText) {
    const ok = await ensureContent(tabId);
    if (!ok.ok) return { ok: false, error: ok.reason };
    const res = await send(tabId, { protocol: CONTENT_PROTOCOL, requestId: requestId(), kind: "testSelector", selector, includeText }, "testSelector");
    return res.result;
  },
};
