/**
 * Agent integration Level 3: optional local MCP bridge via Chrome Native
 * Messaging. The extension connects OUT to a separately installed host
 * (`bridge/`), which relays MCP tool calls from local agents.
 *
 * The extension never depends on the bridge; it connects only when the user
 * enables it in Settings and has granted the optional nativeMessaging
 * permission. Each MCP client is a distinct agent that must be approved.
 */
import type { RuleManagementService } from "../api/rule-api";
import { handleAgentMessage, RateLimiter, AGENT_PROTOCOL } from "./external-messaging";

export const NATIVE_HOST = "com.smartautorefresh.bridge";

interface BridgeRequest {
  id: string;
  client: { id: string; name: string };
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

export async function setBridgeEnabled(service: RuleManagementService, enabled: boolean) {
  wanted = enabled;
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
    return;
  }
  retry = 0;
  port.onMessage.addListener((raw: unknown) => {
    const req = raw as BridgeRequest;
    if (!req || typeof req.id !== "string" || !req.client || typeof req.client.id !== "string") return;
    const clientId = req.client.id.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 48) || "unknown";
    void handleAgentMessage(
      service,
      limiter,
      { id: `native:${clientId}`, name: String(req.client.name ?? clientId).slice(0, 80), transport: "native" },
      { protocol: AGENT_PROTOCOL, method: req.method, params: req.params, name: req.client.name },
    ).then((res) => port?.postMessage({ id: req.id, ...res }));
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    if (err) console.warn("Native bridge disconnected:", err);
    port = null;
    if (wanted && retry < 5) {
      const delay = 2000 * 2 ** retry++;
      setTimeout(() => wanted && !port && connect(service), delay);
    }
  });
}
