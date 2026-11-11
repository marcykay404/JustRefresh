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
import type { Actor, AgentRecord, AgentScope, Config, Rule, UrlPatternInput } from "../core/types";
import { detectPattern } from "../core/url-pattern";

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

/**
 * Hide the query string and #fragment inside a URL pattern
 * ("…/order?id=42" → "…/order?…"). Regex patterns keep "?" quantifiers and
 * "#"; only an escaped literal "\?" starts the hidden part there.
 */
export function redactPattern(p: UrlPatternInput): UrlPatternInput {
  const cut = (value: string, regex: boolean) => {
    const q = regex ? value.indexOf("\\?") : value.indexOf("?");
    const h = regex ? -1 : value.indexOf("#");
    const i = q < 0 ? h : h < 0 ? q : Math.min(q, h);
    if (i < 0) return value;
    return `${value.slice(0, i)}${i === q ? (regex ? "\\?" : "?") : "#"}…`;
  };
  const { type, value } = detectPattern(p);
  const hidden = cut(value, type === "regex");
  return hidden === value ? p : { type, value: hidden };
}

/** A condition tree with every url.match pattern redacted (see redactPattern). */
export function redactConditionUrls<T>(node: T): T {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(redactConditionUrls) as T;
  const n = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) out[k] = k === "pattern" && n.type === "url.match" ? redactPattern(v as UrlPatternInput) : redactConditionUrls(v);
  return out as T;
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
