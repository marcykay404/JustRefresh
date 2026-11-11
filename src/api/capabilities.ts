/**
 * Capability discovery for agents and the rule builder: every registered
 * condition/trigger/action with its description and JSON Schema.
 */
import { z } from "zod";
import type { Registries } from "../registries";
import { MAX_CONDITION_DEPTH, MAX_CONDITION_NODES, MAX_ACTIONS } from "../core/rule-schema";
import { RULE_SCHEMA_VERSION } from "../core/types";
import { MIN_INTERVAL_SECONDS } from "../triggers/interval";
import { buildRuleJsonSchema } from "./json-schema";

export function toJsonSchema(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
  } catch {
    return {};
  }
}

export function buildCapabilities(registries: Registries) {
  return {
    ruleSchemaVersion: RULE_SCHEMA_VERSION,
    limits: {
      minIntervalSeconds: MIN_INTERVAL_SECONDS,
      maxConditionDepth: MAX_CONDITION_DEPTH,
      maxConditionNodes: MAX_CONDITION_NODES,
      maxActionsPerList: MAX_ACTIONS,
    },
    conditions: registries.conditions.list().map((h) => ({
      type: h.type,
      title: h.title,
      description: h.description,
      context: h.context,
      permissions: h.permissions,
      schema: toJsonSchema(h.schema),
    })),
    triggers: registries.triggers.list().map((h) => ({
      type: h.type,
      title: h.title,
      description: h.description,
      allowsRefresh: h.allowsRefresh,
      schema: toJsonSchema(h.schema),
    })),
    actions: registries.actions.list().map((h) => ({
      type: h.type,
      title: h.title,
      description: h.description,
      disruptive: h.disruptive,
      permissions: h.permissions,
      schema: toJsonSchema(h.schema),
    })),
    ruleSchema: buildRuleJsonSchema(registries),
    evaluationOutcomes: ["matched", "not_matched", "unknown"],
    unknownPolicies: ["pause", "skip", "refresh", "stop"],
    urlPatternTypes: {
      exact: "Full URL; normalized; fragment ignored unless the pattern has one",
      domain: "host[:port][/path-glob]; '*.example.com' matches example.com and subdomains",
      glob: "Full URL with '*' wildcards (any characters). '*://' = http or https",
      regex: "JavaScript regex (prefix 'regex:' or start with '^'); unsafe constructs are rejected",
    },
    notes: [
      "Agent-created rules are saved as disabled drafts; enableRule requests user approval.",
      "Use testRule for a side-effect-free dry run before requesting activation.",
      "Conditions return matched / not_matched / unknown; unknown is never treated as false.",
    ],
  };
}
