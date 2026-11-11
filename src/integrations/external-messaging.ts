/**
 * Agent integration Level 2: other extensions call the Rule Management API
 * through chrome.runtime.onMessageExternal.
 *
 * Only extensions on the user's allowlist (Settings → allowedExtensionIds,
 * empty by default) are accepted; others are rejected before anything is
 * recorded, so unknown extensions cannot flood the pairing queue.
 *
 * Protocol: { protocol: "justrefresh-agent/1", method, params }
 *  - "pair" registers a pending agent the user must approve (no scopes).
 *  - every other method requires an approved agent with the right scope.
 * Calls are rate limited per agent and every call is audited.
 */
import type { RuleManagementService } from "../api/rule-api";
import { ApiError } from "../api/permissions";
import { toErrorResponse } from "../api/messaging";

export const AGENT_PROTOCOL = "justrefresh-agent/1";

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
  /** `key`: a desktop agent's own key (see checkAgentKey); extensions are identified by Chrome instead. */
  identity: { id: string; name: string; transport: "extension" | "native"; extensionId?: string; key?: string },
  msg: unknown,
) {
  try {
    if (!msg || typeof msg !== "object" || (msg as AgentMessage).protocol !== AGENT_PROTOCOL || typeof (msg as AgentMessage).method !== "string") {
      throw new ApiError("invalid_params", `Expected { protocol: "${AGENT_PROTOCOL}", method, params }`);
    }
    const m = msg as AgentMessage;
    if (!limiter.allow(identity.id)) throw new ApiError("forbidden", "Rate limit exceeded");
    const { key, ...who } = identity;
    const issued = await service.checkAgentKey(who.id, key);
    const withKey = <T extends object>(r: T) => (issued ? { ...r, agentKey: issued } : r);
    if (m.method === "pair") {
      const agent = await service.ensureAgent({ ...who, name: typeof m.name === "string" ? m.name : who.name });
      return withKey({ ok: true, result: { agentId: agent.id, status: agent.status, scopes: agent.scopes } });
    }
    return withKey({ ok: true, result: await service.call({ type: "agent", agentId: who.id }, m.method, m.params) });
  } catch (e) {
    return toErrorResponse(e);
  }
}

/** Entry point for one external message: allowlist check, then the agent protocol. */
export async function handleExternalMessage(
  service: RuleManagementService,
  limiter: RateLimiter,
  isAllowed: (extensionId: string) => Promise<boolean>,
  senderId: string | undefined,
  msg: unknown,
) {
  if (!senderId) return { ok: false, error: { code: "forbidden", message: "Only extensions may connect" } };
  if (!(await isAllowed(senderId))) {
    return {
      ok: false,
      error: {
        code: "forbidden",
        message: `Extension ${senderId} is not allowed. The user can add its ID in JustRefresh → Dashboard → Agent Integrations.`,
      },
    };
  }
  return handleAgentMessage(service, limiter, { id: `ext:${senderId}`, name: `Extension ${senderId}`, transport: "extension", extensionId: senderId }, msg);
}

export function registerExternalMessaging(service: RuleManagementService, isAllowed: (extensionId: string) => Promise<boolean>) {
  const limiter = new RateLimiter(60, 60_000);
  chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    void handleExternalMessage(service, limiter, isAllowed, sender.id, msg).then(sendResponse);
    return true;
  });
}
