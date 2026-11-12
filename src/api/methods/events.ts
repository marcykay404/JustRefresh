/** Events for agents: what happened to their rules and requests (see agent-events.ts). */
import { AGENT_EVENT_KINDS, type AgentEventKind } from "../../core/types";
import { z } from "../../core/zod";
import { publicEvent } from "../agent-events";
import { ApiError } from "../permissions";
import { m, type MethodDef } from "../method";
import type { ServiceInternals } from "../rule-api";

/**
 * The longest an agent may hold a call open waiting for events. Below the
 * 5 minutes Chrome gives one event (a message from another extension) before
 * it stops the service worker.
 */
export const MAX_WAIT_SECONDS = 240;

export function eventsMethods(svc: ServiceInternals): Record<string, MethodDef> {
  const d = svc.deps;
  return {
    getEvents: m({
      scope: "status:read",
      params: z.optional(
        z.strictObject({
          since: z.optional(z.int().check(z.nonnegative())),
          ruleId: z.optional(z.string().check(z.minLength(1), z.maxLength(64))),
          kinds: z.optional(z.array(z.enum(AGENT_EVENT_KINDS as unknown as [AgentEventKind, ...AgentEventKind[]])).check(z.minLength(1))),
          waitSec: z.optional(z.int().check(z.gte(0), z.lte(MAX_WAIT_SECONDS))),
        }),
      ),
      handler: async (actor, p) => {
        if (!d.events) throw new ApiError("unsupported_method", "Events are unavailable");
        const agentId = actor.type === "agent" ? actor.agentId : null;
        const page = await d.events.wait(agentId, { since: p?.since, ruleId: p?.ruleId, kinds: p?.kinds }, (p?.waitSec ?? 0) * 1000);
        const config = await d.config.get();
        const redact = agentId !== null && config.settings.redactUrlsForAgents;
        // Desktop agents can also follow their file (the bridge knows where it is).
        const file = agentId !== null && config.agents[agentId]?.transport === "native" && config.settings.agentEventsFile;
        return { ...page, events: page.events.map((e) => publicEvent(e, redact)), ...(file ? { file: true } : {}) };
      },
    }),
  };
}
