/**
 * Agent integration Level 3: optional local MCP bridge via Chrome Native
 * Messaging. The extension connects OUT to a separately installed host
 * (`bridge/`), which relays MCP tool calls from local agents.
 *
 * The extension never depends on the bridge; it connects only when the user
 * enables it in Settings and has granted the optional nativeMessaging
 * permission. Each MCP client is a distinct agent that must be approved.
 */
import { publicEvent } from "../api/agent-events";
import type { RuleManagementService } from "../api/rule-api";
import type { AgentEvent } from "../core/types";
import { BRIDGE_STATUS_KEY } from "../storage/keys";
import { handleAgentMessage, RateLimiter, AGENT_PROTOCOL } from "./external-messaging";

export const NATIVE_HOST = "com.justrefresh.bridge";

interface BridgeRequest {
  id: string;
  client: { id: string; name: string; key?: string };
  method: string;
  params?: unknown;
}

let port: chrome.runtime.Port | null = null;
let retry = 0;
let wanted = false;
/**
 * Chrome only exposes chrome.runtime.connectNative to a worker that started
 * with the nativeMessaging permission. When the user grants it at runtime the
 * running worker cannot connect until the extension restarts.
 */
let restartRequired = false;
const limiter = new RateLimiter(120, 60_000);

export function bridgeStatus() {
  return { connected: port !== null, wanted, restartRequired };
}

/** Keep a copy where the dashboard can watch it (storage.onChanged) instead of polling. */
let published = "";
function publishStatus() {
  const s = bridgeStatus();
  const json = JSON.stringify(s);
  if (json === published) return;
  published = json;
  void chrome.storage?.session?.set({ [BRIDGE_STATUS_KEY]: s }).catch(() => undefined);
}

/**
 * With "write events to a file" on, each desktop agent's events also go to the
 * native host, which appends them to that agent's file (~/.justrefresh/events).
 * Only while connected: an agent catches up on the rest with getEvents.
 */
let unsubscribe: (() => void) | null = null;
function forwardEvents(service: RuleManagementService) {
  unsubscribe ??= service.deps.events?.onEvents((added) => void sendEvents(service, added)) ?? null;
}

async function sendEvents(service: RuleManagementService, added: AgentEvent[]) {
  if (!port) return;
  const { settings, agents } = await service.deps.config.get();
  if (!settings.agentEventsFile) return;
  for (const e of added) {
    if (agents[e.agentId]?.transport !== "native" || !e.agentId.startsWith("native:")) continue;
    port?.postMessage({ type: "event", agent: e.agentId.slice("native:".length), event: publicEvent(e, settings.redactUrlsForAgents) });
  }
}

export async function setBridgeEnabled(service: RuleManagementService, enabled: boolean) {
  forwardEvents(service);
  try {
    await applyBridgeEnabled(service, enabled);
  } finally {
    publishStatus();
  }
}

async function applyBridgeEnabled(service: RuleManagementService, enabled: boolean) {
  wanted = enabled;
  retry = 0; // switching it on (again) gets a fresh set of tries
  if (!enabled) {
    restartRequired = false;
    port?.disconnect();
    port = null;
    return;
  }
  const granted = await chrome.permissions.contains({ permissions: ["nativeMessaging"] }).catch(() => false);
  if (!granted || port) return;
  if (typeof chrome.runtime.connectNative !== "function") {
    restartRequired = true;
    return;
  }
  connect(service);
}

function connect(service: RuleManagementService) {
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    console.warn("Native bridge unavailable", e);
    port = null;
    publishStatus();
    return;
  }
  publishStatus();
  const connectedAt = Date.now();
  port.onMessage.addListener((raw: unknown) => {
    const req = raw as BridgeRequest;
    if (!req || typeof req.id !== "string" || !req.client || typeof req.client.id !== "string") return;
    const clientId = req.client.id.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 48) || "unknown";
    void handleAgentMessage(
      service,
      limiter,
      {
        id: `native:${clientId}`,
        name: String(req.client.name ?? clientId).slice(0, 80),
        transport: "native",
        ...(typeof req.client.key === "string" ? { key: req.client.key } : {}),
      },
      { protocol: AGENT_PROTOCOL, method: req.method, params: req.params, name: req.client.name },
    ).then((res) => port?.postMessage({ id: req.id, ...res }));
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    if (err) console.warn("Native bridge disconnected:", err);
    port = null;
    publishStatus();
    // A host that stayed connected for a while was really there: start the
    // back-off again. One that drops at once (not installed) gives up after 5 tries.
    if (Date.now() - connectedAt > 30_000) retry = 0;
    if (wanted && retry < 5) {
      const delay = 2000 * 2 ** retry++;
      setTimeout(() => wanted && !port && connect(service), delay);
    }
  });
}
