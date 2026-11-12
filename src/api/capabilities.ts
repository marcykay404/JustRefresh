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
/** Used when the schema files can't be read: capabilities say so (`schemasUnavailable`). */
export const NO_SCHEMAS: SchemaBundle = { rule: {}, handlers: { conditions: {}, triggers: {}, actions: {} } };
const schemaOf = (map: SchemaMap, type: string): unknown => map[type] ?? {};

export type SchemaKind = "rule" | "condition" | "trigger" | "action";
const PLURAL = { condition: "conditions", trigger: "triggers", action: "actions" } as const;

/**
 * What agents and the rule builder can use. By default a summary: every
 * condition/trigger/action with its title, description and permissions, the
 * limits and notes, but no JSON Schemas (about half the size of the full
 * payload, which agents pay for in tokens). `includeSchemas` adds each
 * handler's schema and the whole rule schema, as the rule builder needs;
 * agents ask for one piece at a time with getSchema instead.
 */
export function buildCapabilities(
  registries: Registries,
  settings?: Pick<Settings, "allowFastIntervals">,
  schemas: SchemaBundle = NO_SCHEMAS,
  { includeSchemas = false }: { includeSchemas?: boolean } = {},
) {
  const fast = settings?.allowFastIntervals === true;
  const withSchema = (kind: keyof SchemaBundle["handlers"], type: string) => (includeSchemas ? { schema: schemaOf(schemas.handlers[kind], type) } : {});
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
      ...withSchema("conditions", h.type),
    })),
    triggers: registries.triggers.list().map((h) => ({
      type: h.type,
      title: h.title,
      description: h.description,
      allowsRefresh: h.allowsRefresh,
      ...withSchema("triggers", h.type),
    })),
    actions: registries.actions.list().map((h) => ({
      type: h.type,
      title: h.title,
      description: h.description,
      disruptive: h.disruptive,
      permissions: h.permissions,
      ...withSchema("actions", h.type),
    })),
    ...(includeSchemas ? { ruleSchema: schemas.rule } : {}),
    ...(includeSchemas && schemas === NO_SCHEMAS ? { schemasUnavailable: true } : {}),
    evaluationOutcomes: ["matched", "not_matched", "unknown"],
    unknownPolicies: ["pause", "skip", "refresh", "stop"],
    urlPatternTypes: {
      exact: "Full URL; normalized; fragment ignored unless the pattern has one",
      domain: "host[:port][/path-glob]; '*.example.com' matches example.com and subdomains",
      glob: "Full URL with '*' wildcards (any characters). '*://' = http or https",
      regex: "JavaScript regex (prefix 'regex:' or start with '^'); unsafe constructs are rejected",
    },
    notes: [
      "JSON Schemas: getSchema({ kind: 'rule' }) for a rule's fields, getSchema({ kind: 'condition' | 'trigger' | 'action', type }) for one handler.",
      "Agent-created rules are saved as disabled drafts; enableRule asks the user to approve (a trusted agent's enable and delete act at once).",
      "An agent's updateRule turns the rule off and makes it a draft again, even a running one; enable it again afterwards.",
      "Use testRule for a side-effect-free dry run before asking to enable. To check a CSS selector, test a throwaway rule whose stopWhen is a dom.exists condition.",
      "Conditions return matched / not_matched / unknown; unknown is never treated as false. Its code says why (invalid_selector: fix the selector).",
      "Refresh as slowly as the task allows, and set limits (maxRefreshes, maxDurationSeconds) for one-off watches.",
    ],
  };
}

/**
 * One piece of the JSON Schema. "rule": the rule's own fields, with the
 * condition, trigger and action definitions left as pointers to getSchema
 * (each is its own call). A kind with a type: that handler's schema; without
 * a type: every handler of that kind. null = no such type (the caller says
 * which types exist).
 */
export function schemaFor(registries: Registries, schemas: SchemaBundle, kind: SchemaKind, type?: string): unknown {
  if (kind === "rule") {
    const rule = schemas.rule as { $defs?: Record<string, unknown> };
    const pointer = (k: string) => ({ description: `Any ${k}: see getSchema({ kind: '${k}', type }) for each type's fields` });
    return { ...rule, $defs: { condition: pointer("condition"), trigger: pointer("trigger"), action: pointer("action") } };
  }
  const registered = registries[PLURAL[kind]].list().map((h) => h.type);
  const map = schemas.handlers[PLURAL[kind]];
  if (type === undefined) return Object.fromEntries(registered.map((t) => [t, schemaOf(map, t)]));
  return registered.includes(type) ? schemaOf(map, type) : null;
}
