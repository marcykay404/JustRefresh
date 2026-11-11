/**
 * Authorization for the Rule Management API.
 *
 *  - The user (extension pages) may call every method.
 *  - Agents must be paired & approved, and each method requires a scope.
 *  - Agent-created rules are drafts; activation and deletion need user
 *    approval unless the user granted the limited "trusted activation"
 *    capability to that agent.
 *  - Agents may only modify rules they created.
 */
import type { Actor, AgentRecord, AgentScope, Config, Rule } from "../core/types";

export class ApiError extends Error {
  constructor(
    public readonly code:
      | "invalid_params"
      | "validation_failed"
      | "not_found"
      | "conflict"
      | "forbidden"
      | "pairing_required"
      | "unsupported_method"
      | "internal",
    message: string,
    public readonly diagnostics?: unknown[],
  ) {
    super(message);
  }
}

export function agentFor(actor: Actor, config: Config): AgentRecord | null {
  return actor.type === "agent" ? (config.agents[actor.agentId] ?? null) : null;
}

export function authorize(actor: Actor, scope: AgentScope | null, config: Config): void {
  if (actor.type === "user" || actor.type === "system") return;
  if (scope === null) throw new ApiError("forbidden", "This operation is only available to the user");
  const agent = config.agents[actor.agentId];
  if (!agent || agent.status === "pending") throw new ApiError("pairing_required", "Agent is not paired. Approve it in Dashboard → Agent Integrations.");
  if (agent.status === "revoked") throw new ApiError("forbidden", "Agent access has been revoked");
  if (!agent.scopes.includes(scope)) throw new ApiError("forbidden", `Agent lacks the "${scope}" scope`);
}

export function assertCanModify(actor: Actor, rule: Rule): void {
  if (actor.type !== "agent") return;
  if (rule.meta.origin.type !== "agent" || rule.meta.origin.agentId !== actor.agentId) {
    throw new ApiError("forbidden", "Agents may only modify rules they created");
  }
}

/** Agents never see query strings or fragments unless the user allows it. */
export function redactUrl(url: string, redact: boolean): string {
  if (!redact) return url;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return "";
  }
}
