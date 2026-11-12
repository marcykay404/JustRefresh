/**
 * MV3 service worker: wires Chrome events to the rule engine and exposes the
 * Rule Management API to extension pages, external extensions and the
 * optional native MCP bridge.
 *
 * No timers are kept alive: scheduling relies on chrome.alarms and all state
 * is persisted, so the worker can be terminated at any time.
 */
import { RuleEngine } from "../core/rule-engine";
import { RuleManagementService } from "../api/rule-api";
import type { SchemaBundle } from "../api/capabilities";
import { isApiRequest, isExtensionPage, toErrorResponse } from "../api/messaging";
import { ApiError } from "../api/permissions";
import { AgentEventRepository, AuditRepository, ConfigRepository, HistoryRepository, RUNTIME_PREFIX, RuntimeRepository } from "../storage/repositories";
import { AgentEvents } from "../api/agent-events";
import { chromeAlarms, chromeBrowser, chromePage, setShortTimerHandler, systemClock } from "./chrome-ports";
import { hasHostAccess, injectIntoOpenTabs, originPattern, syncContentScripts } from "./host-access";
import { createThrottle } from "./throttle";
import { restoreTabOverrides } from "./tab-manager";
import { registerExternalMessaging } from "../integrations/external-messaging";
import { bridgeStatus, setBridgeEnabled } from "../integrations/native-bridge";
import { STATUS_LABELS, type TabRuntime } from "../core/types";
import { tabBadge } from "../core/badge";
import { healthReport, startupDone, startupStep, timed } from "./diagnostics";
import { createAfterAccess, parseAfterAccess } from "./after-access";
import { HEALTH_CHANNEL } from "../shared/messaging-types";

/** The generated JSON Schemas ship as package files; read them once, when an agent first asks. */
let schemaBundle: Promise<SchemaBundle> | null = null;
function loadSchemas(): Promise<SchemaBundle> {
  const read = (path: string) =>
    fetch(chrome.runtime.getURL(path)).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    });
  schemaBundle ??= Promise.all([read("schemas/rule.schema.json"), read("schemas/handler-schemas.json")]).then(([rule, handlers]) => ({ rule, handlers }));
  schemaBundle.catch(() => (schemaBundle = null));
  return schemaBundle;
}

const config = new ConfigRepository(chrome.storage.local);
const runtime = new RuntimeRepository(chrome.storage.session);
const history = new HistoryRepository(chrome.storage.local, config);
const audit = new AuditRepository(chrome.storage.local);
const events = new AgentEvents({ store: new AgentEventRepository(chrome.storage.local), config, now: systemClock.now });

const engine = new RuleEngine({
  browser: chromeBrowser,
  alarms: chromeAlarms,
  page: chromePage,
  clock: systemClock,
  stores: { config, runtime, history },
  events,
  throttle: createThrottle(750),
});

const service = new RuleManagementService({
  config,
  runtime,
  history,
  audit,
  engine,
  browser: chromeBrowser,
  clock: systemClock,
  hostAccess: hasHostAccess,
  schemas: loadSchemas,
  events,
  testSelector: (tabId, selector, includeText) => chromePage.testSelector(tabId, selector, includeText),
  picker: { start: (tabId, session) => chromePage.startPicker(tabId, session), cancel: (tabId) => chromePage.cancelPicker(tabId) },
});

/* ------------------------------------------------------------------ */
/* Startup & reconciliation                                            */
/* ------------------------------------------------------------------ */

const BOOT_KEY = "boot";

/**
 * Runs on every worker start. storage.session is cleared when the browser
 * restarts, so a missing boot marker means a fresh browser session: per-tab
 * overrides are re-associated with restored tabs before reconciling.
 */
const ready: Promise<void> = (async () => {
  try {
    startupStep("reading its state");
    const booted = (await chrome.storage.session.get(BOOT_KEY))[BOOT_KEY];
    if (!booted) {
      startupStep("restoring per-tab settings");
      const tabs = await chromeBrowser.listTabs();
      await config.update((c) => {
        const r = restoreTabOverrides(c.tabOverrides, tabs);
        c.tabOverrides = r.overrides;
        if (r.ambiguous.length || r.dropped.length) {
          console.info(`Tab overrides: ${r.restored.length} restored, ${r.ambiguous.length} ambiguous, ${r.dropped.length} dropped`);
        }
      });
      await chrome.storage.session.set({ [BOOT_KEY]: Date.now() });
      startupStep("registering the content script");
      await syncContentScripts().catch((e) => console.warn("Content script registration failed", e));
      startupStep("checking every tab (browser or extension just started)");
      await engine.reconcileAll("startup", { progress: startupStep });
    } else {
      startupStep("checking every tab (waking up)");
      await engine.reconcileAll("wake", { progress: startupStep });
    }
    const settings = (await config.get()).settings;
    if (settings.nativeBridgeEnabled) {
      startupStep("connecting the desktop bridge");
      await setBridgeEnabled(service, true);
    }
    startupStep("updating the toolbar badge");
    await updateBadge();
  } catch (e) {
    console.error("Startup reconciliation failed", e);
  } finally {
    startupDone();
  }
})();

let lastBridgeSetting: boolean | null = null;
config.onChange((c) => {
  if (lastBridgeSetting !== c.settings.nativeBridgeEnabled) {
    lastBridgeSetting = c.settings.nativeBridgeEnabled;
    void setBridgeEnabled(service, c.settings.nativeBridgeEnabled);
  }
  void updateBadge();
});

async function updateBadge() {
  const c = await config.get();
  const pending = c.approvals.filter((a) => a.status === "pending").length + Object.values(c.agents).filter((a) => a.status === "pending").length;
  if (pending) {
    await chrome.action.setBadgeText({ text: String(pending) });
    await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
  } else if (!c.settings.enabled || c.settings.paused) {
    await chrome.action.setBadgeText({ text: c.settings.enabled ? "II" : "off" });
    await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
  }
}

/** Per-tab badge + tooltip, recomputed when that tab's runtime state changes. */
async function updateTabBadge(tabId: number, rt: TabRuntime | null) {
  const b = tabBadge(rt, (t) => new Date(t).toLocaleTimeString());
  try {
    // null clears the tab-specific text so the global badge (approvals, paused) shows.
    await chrome.action.setBadgeText({ tabId, text: b ? b.text : (null as unknown as string) });
    if (b) await chrome.action.setBadgeBackgroundColor({ tabId, color: b.color });
    await chrome.action.setTitle({ tabId, title: b?.title ?? "JustRefresh" });
  } catch {
    /* tab already closed */
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith(RUNTIME_PREFIX)) continue;
    void updateTabBadge(Number(key.slice(RUNTIME_PREFIX.length)), (change.newValue as TabRuntime | undefined) ?? null);
  }
});

/** What a popup click asked for, done once Chrome grants site access (the popup may have closed). */
const afterAccess = createAfterAccess({
  storage: chrome.storage.session,
  granted: async (origin) => chrome.permissions.contains({ origins: [origin] }).catch(() => false),
  tabOn: async (tabId, origins) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const pattern = tab?.url ? originPattern(tab.url) : null;
    return pattern !== null && origins.includes(pattern);
  },
  call: (method, params) => service.call({ type: "user" }, method, params),
  popupOpen: async (tabId) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.POPUP], ...(tab ? { windowIds: [tab.windowId] } : {}) });
    return contexts.length > 0;
  },
  notify: async (tabId, title, message) => {
    // tabId before the time: clicking it brings the tab to the front (see notifications.onClicked).
    if ((await config.get()).settings.notificationsEnabled) await chromeBrowser.notify(`justrefresh:access:${tabId}:${Date.now()}`, title, message);
  },
  now: () => Date.now(),
});

/** Run `fn` once startup has finished; `what` names it in the health report while it waits or runs. */
async function after<T>(fn: () => Promise<T>, what = "an event"): Promise<T> {
  return timed(what, fn, ready);
}

/* ------------------------------------------------------------------ */
/* Event listeners (registered synchronously at top level)            */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener((details) => {
  void after(() => syncContentScripts());
  // First install only (not updates or reloads): a short welcome page.
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html#/welcome") });
});
chrome.runtime.onStartup.addListener(() => void ready);

chrome.alarms.onAlarm.addListener((alarm) => void after(() => engine.handleAlarm(alarm.name), `timer ${alarm.name}`));
setShortTimerHandler((name) => void after(() => engine.handleAlarm(name), `timer ${name}`));

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url === undefined && change.status === undefined && change.discarded === undefined) return;
  void after(() => engine.onTabUpdated(tabId, { url: change.url, status: change.status }), `tab ${tabId} ${change.status ?? "address"} change`);
});
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) void after(() => engine.syncTab(tab.id!), `new tab ${tab.id}`);
});
chrome.tabs.onRemoved.addListener((tabId) => void after(() => engine.onTabRemoved(tabId), `closed tab ${tabId}`));
chrome.tabs.onReplaced.addListener((added, removed) => void after(() => engine.onTabReplaced(added, removed)));

chrome.permissions.onAdded.addListener(
  (added) =>
    void after(async () => {
      // First what the click was for (the popup may be gone), then the open tabs (whatever happened to it).
      await afterAccess.runGranted(added.origins ?? []).catch((e) => console.warn("JustRefresh: couldn't finish what access was asked for", e));
      await syncContentScripts();
      await injectIntoOpenTabs();
      await engine.reconcileAll("config");
    }, "site access granted: setting up open tabs"),
);
chrome.permissions.onRemoved.addListener(() => void after(() => syncContentScripts(), "site access removed"));

chrome.notifications.onClicked.addListener((id) => {
  const parts = id.split(":");
  const tabId = Number(parts[parts.length - 2]);
  if (Number.isFinite(tabId)) {
    void chrome.tabs
      .update(tabId, { active: true })
      .then((t) => t && chrome.windows.update(t.windowId, { focused: true }))
      .catch(() => undefined);
  }
  void chrome.notifications.clear(id);
});

/** Invalid parameters for a page-only request. */
const invalid = (message: string) => new ApiError("invalid_params", message);

/**
 * Requests only JustRefresh's own pages make: the bridge's status, status
 * labels, and what a popup click that asks Chrome for access is for
 * (background/after-access.ts).
 */
const PAGE_ONLY: Record<string, (params: unknown) => Promise<unknown>> = {
  bridgeStatus: async () => bridgeStatus(),
  statusLabels: async () => STATUS_LABELS,
  afterAccess: async (params) => {
    const req = parseAfterAccess(params);
    if (!req) throw invalid("Invalid request");
    await afterAccess.queue(req.id, req.origins, req.request);
    return null;
  },
  runAfterAccess: async (params) => {
    const id = (params as { id?: unknown } | undefined)?.id;
    return typeof id === "string" ? afterAccess.resultFor(id) : null;
  },
  takeAfterAccess: async (params) => {
    const { tabId, id } = (params ?? {}) as { tabId?: unknown; id?: unknown };
    return typeof tabId === "number" ? afterAccess.take(tabId, typeof id === "string" ? id : undefined) : null;
  },
  cancelAfterAccessFor: async (params) => {
    const origins = (params as { origins?: unknown } | undefined)?.origins;
    if (Array.isArray(origins) && origins.every((o) => typeof o === "string")) await afterAccess.cancelFor(origins as string[]);
    return null;
  },
};

/* Internal API for the popup / dashboard. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // What it's busy with: answered at once, without waiting for startup.
  if ((msg as { channel?: string } | null)?.channel === HEALTH_CHANNEL && isExtensionPage(sender)) {
    sendResponse(healthReport());
    return false;
  }
  if (!isApiRequest(msg)) return false;
  if (!isExtensionPage(sender)) {
    sendResponse({ ok: false, error: { code: "forbidden", message: "Untrusted sender" } });
    return false;
  }
  void after(async () => {
    try {
      // Requests only extension pages make (never agents): answered here, not by the Rule Management API.
      if (Object.hasOwn(PAGE_ONLY, msg.method)) return { ok: true, result: await PAGE_ONLY[msg.method]!(msg.params) };
      return { ok: true, result: await service.call({ type: "user" }, msg.method, msg.params) };
    } catch (e) {
      return toErrorResponse(e);
    }
  }, `request ${msg.method}`).then(sendResponse);
  return true;
});

registerExternalMessaging(service, async (id) => (await config.get()).settings.allowedExtensionIds.includes(id));

/* Debug/test hook (no privileged surface beyond what the worker already has). */
(globalThis as unknown as { __justrefresh: unknown }).__justrefresh = { engine, service, config, runtime, ready };
