/**
 * Agent integration Level 2: other extensions call the Rule Management API
 * through chrome.runtime.onMessageExternal.
 *
 * Protocol: { protocol: "sar-agent/1", method, params }
 *  - "pair" registers a pending agent the user must approve (no scopes).
 *  - every other method requires an approved agent with the right scope.
 * Calls are rate limited per agent and every call is audited.
 */
import type { RuleManagementService } from "../api/rule-api";
import { ApiError } from "../api/permissions";
import { toErrorResponse } from "../api/messaging";

export const AGENT_PROTOCOL = "sar-agent/1";

export interface AgentMessage {
  protocol: typeof AGENT_PROTOCOL;
  method: string;
  params?: unknown;
  /** Display name, used when pairing. */
  name?: string;
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}

export async function handleAgentMessage(
  service: RuleManagementService,
  limiter: RateLimiter,
  identity: { id: string; name: string; transport: "extension" | "native"; extensionId?: string },
  msg: unknown,
) {
  try {
    if (!msg || typeof msg !== "object" || (msg as AgentMessage).protocol !== AGENT_PROTOCOL || typeof (msg as AgentMessage).method !== "string") {
      throw new ApiError("invalid_params", `Expected { protocol: "${AGENT_PROTOCOL}", method, params }`);
    }
    const m = msg as AgentMessage;
    if (!limiter.allow(identity.id)) throw new ApiError("forbidden", "Rate limit exceeded");
    if (m.method === "pair") {
      const agent = await service.ensureAgent({ ...identity, name: typeof m.name === "string" ? m.name : identity.name });
      return { ok: true, result: { agentId: agent.id, status: agent.status, scopes: agent.scopes } };
    }
    return { ok: true, result: await service.call({ type: "agent", agentId: identity.id }, m.method, m.params) };
  } catch (e) {
    return toErrorResponse(e);
  }
}

export function registerExternalMessaging(service: RuleManagementService) {
  const limiter = new RateLimiter(60, 60_000);
  chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    if (!sender.id) {
      sendResponse({ ok: false, error: { code: "forbidden", message: "Only extensions may connect" } });
      return false;
    }
    void handleAgentMessage(service, limiter, { id: `ext:${sender.id}`, name: `Extension ${sender.id}`, transport: "extension", extensionId: sender.id }, msg).then(sendResponse);
    return true;
  });
}
