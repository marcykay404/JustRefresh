import { readFileSync } from "node:fs";
import { RuleManagementService } from "@/api/rule-api";
import type { AgentScope } from "@/core/types";
import { createEnv } from "./fake-env";

export function createApiEnv() {
  const env = createEnv();
  let n = 0;
  const service = new RuleManagementService({
    config: env.config,
    runtime: env.runtime,
    history: env.history,
    audit: env.audit,
    engine: env.engine,
    browser: env.browser,
    clock: env.clock,
    events: env.events,
    hostAccess: async () => true,
    newId: (p) => `${p}-${++n}`,
    schemas: async () => ({
      rule: JSON.parse(readFileSync("schemas/rule.schema.json", "utf8")),
      handlers: JSON.parse(readFileSync("schemas/handler-schemas.json", "utf8")),
    }),
  });
  const user = { type: "user" } as const;
  const agent = (id = "native:claude") => ({ type: "agent", agentId: id }) as const;
  async function pairAgent(
    id = "native:claude",
    scopes: AgentScope[] = ["tabs:read", "rules:read", "rules:write", "rules:test", "rules:activate", "rules:delete", "status:read"],
    trusted = false,
  ) {
    await service.ensureAgent({ id, name: "Test agent", transport: "native" });
    await service.call(user, "updateAgent", { id, status: "approved", scopes, trustedActivation: trusted });
  }
  return { ...env, service, user, agent, pairAgent };
}
