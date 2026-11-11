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
import { AuditRepository, ConfigRepository, HistoryRepository, RUNTIME_PREFIX, RuntimeRepository } from "../storage/repositories";
import { chromeAlarms, chromeBrowser, chromePage, setShortTimerHandler, systemClock } from "./chrome-ports";
import { hasHostAccess, injectIntoOpenTabs, syncContentScripts } from "./host-access";
import { createThrottle } from "./throttle";
import { restoreTabOverrides } from "./tab-manager";
import { registerExternalMessaging } from "../integrations/external-messaging";
import { bridgeStatus, setBridgeEnabled } from "../integrations/native-bridge";
import { STATUS_LABELS, type TabRuntime } from "../core/types";
import { tabBadge } from "../core/badge";

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

const engine = new RuleEngine({
  browser: chromeBrowser,
  alarms: chromeAlarms,
  page: chromePage,
  clock: systemClock,
  stores: { config, runtime, history },
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
  testSelector: (tabId, selector, includeText) => chromePage.testSelector(tabId, selector, includeText),
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
    const booted = (await chrome.storage.session.get(BOOT_KEY))[BOOT_KEY];
    if (!booted) {
      const tabs = await chromeBrowser.listTabs();
      await config.update((c) => {
        const r = restoreTabOverrides(c.tabOverrides, tabs);
        c.tabOverrides = r.overrides;
        if (r.ambiguous.length || r.dropped.length) {
          console.info(`Tab overrides: ${r.restored.length} restored, ${r.ambiguous.length} ambiguous, ${r.dropped.length} dropped`);
        }
      });
      await chrome.storage.session.set({ [BOOT_KEY]: Date.now() });
      await syncContentScripts().catch((e) => console.warn("Content script registration failed", e));
      await engine.reconcileAll("startup");
    } else {
      await engine.reconcileAll("wake");
    }
    const settings = (await config.get()).settings;
    if (settings.nativeBridgeEnabled) await setBridgeEnabled(service, true);
    await updateBadge();
  } catch (e) {
    console.error("Startup reconciliation failed", e);
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

async function after<T>(fn: () => Promise<T>): Promise<T> {
  await ready;
  return fn();
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

chrome.alarms.onAlarm.addListener((alarm) => void after(() => engine.handleAlarm(alarm.name)));
setShortTimerHandler((name) => void after(() => engine.handleAlarm(name)));

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url === undefined && change.status === undefined && change.discarded === undefined) return;
  void after(() => engine.onTabUpdated(tabId, { url: change.url, status: change.status }));
});
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) void after(() => engine.syncTab(tab.id!));
});
chrome.tabs.onRemoved.addListener((tabId) => void after(() => engine.onTabRemoved(tabId)));
chrome.tabs.onReplaced.addListener((added, removed) => void after(() => engine.onTabReplaced(added, removed)));

chrome.permissions.onAdded.addListener(() =>
  void after(async () => {
    await syncContentScripts();
    await injectIntoOpenTabs();
    await engine.reconcileAll("config");
  }),
);
chrome.permissions.onRemoved.addListener(() => void after(() => syncContentScripts()));

chrome.notifications.onClicked.addListener((id) => {
  const parts = id.split(":");
  const tabId = Number(parts[parts.length - 2]);
  if (Number.isFinite(tabId)) {
    void chrome.tabs.update(tabId, { active: true }).then((t) => t && chrome.windows.update(t.windowId, { focused: true })).catch(() => undefined);
  }
  void chrome.notifications.clear(id);
});

/* Internal API for the popup / dashboard. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isApiRequest(msg)) return false;
  if (!isExtensionPage(sender)) {
    sendResponse({ ok: false, error: { code: "forbidden", message: "Untrusted sender" } });
    return false;
  }
  void after(async () => {
    try {
      if (msg.method === "bridgeStatus") return { ok: true, result: bridgeStatus() };
      if (msg.method === "statusLabels") return { ok: true, result: STATUS_LABELS };
      return { ok: true, result: await service.call({ type: "user" }, msg.method, msg.params) };
    } catch (e) {
      return toErrorResponse(e);
    }
  }).then(sendResponse);
  return true;
});

registerExternalMessaging(service, async (id) => (await config.get()).settings.allowedExtensionIds.includes(id));

/* Debug/test hook (no privileged surface beyond what the worker already has). */
(globalThis as unknown as { __sar: unknown }).__sar = { engine, service, config, runtime, ready };
