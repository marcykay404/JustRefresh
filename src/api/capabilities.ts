/**
 * Capability discovery for agents and the rule builder: every registered
 * condition/trigger/action with its description and JSON Schema. The
 * schemas are generated at build time (`npm run gen:schema`) and read from
 * the extension package on demand, so the service worker ships neither
 * zod's JSON Schema converter nor the schemas themselves.
 */
import type { Registries } from "../registries";
import { MAX_CONDITION_DEPTH, MAX_CONDITION_NODES, MAX_ACTIONS } from "../core/rule-schema";
import { RULE_SCHEMA_VERSION } from "../core/types";
import { FAST_MIN_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS } from "../triggers/interval";
import type { Settings } from "../core/types";

type SchemaMap = Record<string, unknown>;
/** schemas/rule.schema.json and schemas/handler-schemas.json. */
export interface SchemaBundle {
  rule: unknown;
  handlers: { conditions: SchemaMap; triggers: SchemaMap; actions: SchemaMap };
}
export const NO_SCHEMAS: SchemaBundle = { rule: {}, handlers: { conditions: {}, triggers: {}, actions: {} } };
const schemaOf = (map: SchemaMap, type: string): unknown => map[type] ?? {};

export function buildCapabilities(registries: Registries, settings?: Pick<Settings, "allowFastIntervals">, schemas: SchemaBundle = NO_SCHEMAS) {
  const fast = settings?.allowFastIntervals === true;
  return {
    ruleSchemaVersion: RULE_SCHEMA_VERSION,
    limits: {
      /** Effective minimum for new rules under the user's current settings. */
      minIntervalSeconds: fast ? FAST_MIN_INTERVAL_SECONDS : MIN_INTERVAL_SECONDS,
      fastIntervalsEnabled: fast,
      fastIntervalFloorSeconds: FAST_MIN_INTERVAL_SECONDS,
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
      schema: schemaOf(schemas.handlers.conditions, h.type),
    })),
    triggers: registries.triggers.list().map((h) => ({
      type: h.type,
      title: h.title,
      description: h.description,
      allowsRefresh: h.allowsRefresh,
      schema: schemaOf(schemas.handlers.triggers, h.type),
    })),
    actions: registries.actions.list().map((h) => ({
      type: h.type,
      title: h.title,
      description: h.description,
      disruptive: h.disruptive,
      permissions: h.permissions,
      schema: schemaOf(schemas.handlers.actions, h.type),
    })),
    ruleSchema: schemas.rule,
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
