/** Agents: pairing, permissions, approvals and the activity log. */
import type { AgentScope } from "../../core/types";
import { ALL_AGENT_SCOPES } from "../../core/types";
import { z } from "../../core/zod";
import { ApiError } from "../permissions";
import { m, none, ruleId, type MethodDef } from "../method";
import type { ServiceInternals } from "../rule-api";

export function agentsMethods(svc: ServiceInternals): Record<string, MethodDef> {
  const d = svc.deps;
  return {
    getAudit: m({ scope: null, params: none, handler: async () => (await d.audit.list()).slice().reverse() }),
    clearAudit: m({ scope: null, params: none, handler: async () => d.audit.clear().then(() => ({ cleared: true })) }),
    listAgents: m({
      scope: null,
      params: none,
      handler: async () => {
        const c = await d.config.get();
        return { agents: Object.values(c.agents), approvals: c.approvals.slice().reverse(), allScopes: ALL_AGENT_SCOPES };
      },
    }),
    updateAgent: m({
      scope: null,
      params: z.strictObject({
        id: z.string(),
        status: z.optional(z.enum(["approved", "revoked"])),
        scopes: z.optional(z.array(z.enum(ALL_AGENT_SCOPES as [AgentScope, ...AgentScope[]]))),
        trustedActivation: z.optional(z.boolean()),
      }),
      handler: async (_a, p) => {
        await d.config.update((c) => {
          const a = c.agents[p.id];
          if (!a) throw new ApiError("not_found", "Agent not found");
          if (p.status) a.status = p.status;
          if (p.scopes) a.scopes = p.scopes;
          if (p.trustedActivation !== undefined) a.trustedActivation = p.trustedActivation;
        });
        return (await d.config.get()).agents[p.id];
      },
    }),
    removeAgent: m({
      scope: null,
      params: ruleId,
      handler: async (_a, p) => {
        await d.config.update((c) => {
          delete c.agents[p.id];
          c.approvals = c.approvals.filter((a) => a.agentId !== p.id);
        });
        await d.events?.forget(p.id);
        return { removed: p.id };
      },
    }),
    resolveApproval: m({
      scope: null,
      params: z.strictObject({ id: z.string(), approve: z.boolean() }),
      mutates: true,
      handler: async (_a, p) => {
        let outcome = "rejected";
        await d.config.update((c) => {
          const req = c.approvals.find((a) => a.id === p.id);
          if (!req) throw new ApiError("not_found", "No pending approval with that id");
          // Withdrawn or outdated just before the click: say so quietly, as for any outdated request.
          if (req.status === "stale") {
            outcome = "stale";
            return;
          }
          if (req.status !== "pending") throw new ApiError("not_found", "No pending approval with that id");
          const rule = c.rules[req.ruleId];
          if (!rule || rule.meta.revision !== req.ruleRevision) {
            req.status = "stale";
            outcome = "stale";
            return;
          }
          if (!p.approve) {
            req.status = "rejected";
            return;
          }
          req.status = "approved";
          outcome = req.kind === "activate" ? "activated" : "deleted";
          if (req.kind === "activate") {
            rule.enabled = true;
            rule.meta.draft = false;
            rule.meta.revision++;
            rule.meta.updatedAt = d.clock.now();
          } else {
            delete c.rules[req.ruleId];
            for (const o of c.approvals) if (o.ruleId === req.ruleId && o.status === "pending") o.status = "stale";
          }
        });
        return { outcome };
      },
    }),
  };
}
