/**
 * Builds the authoritative JSON Schema (draft 2020-12) for rules, and each
 * condition/trigger/action's own schema, from the same zod schemas and
 * registries used at runtime. Build-time only: `npm run gen:schema` writes
 * schemas/rule.schema.json and schemas/handler-schemas.json, which ship in
 * the extension package and are read when an agent asks for capabilities,
 * instead of bundling zod's JSON Schema converter. A test keeps both in sync
 * with the code.
 */
import { z } from "zod/mini";
import type { Registries } from "../registries";
import { defaultRegistries } from "../registries";
import { ruleInputSchema } from "../core/rule-schema";

type Json = Record<string, any>;

const strip = (s: Json): Json => {
  const { $schema: _s, ...rest } = s;
  return rest;
};

const toSchema = (schema: z.ZodMiniType): Json => strip(z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }) as Json);

export function buildRuleJsonSchema(registries: Registries = defaultRegistries()): Json {
  const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
  const conditions = registries.conditions.list().map((h) => {
    const s = toSchema(h.schema);
    if (s.properties?.conditions) s.properties.conditions.items = ref("condition");
    if (s.properties?.condition) s.properties.condition = ref("condition");
    return { title: h.title, description: h.description, ...s };
  });
  const triggers = registries.triggers.list().map((h) => ({ title: h.title, description: h.description, ...toSchema(h.schema) }));
  const actions = registries.actions.list().map((h) => ({ title: h.title, description: h.description, ...toSchema(h.schema) }));

  const rule = toSchema(ruleInputSchema);
  rule.properties.trigger = ref("trigger");
  rule.properties.stopWhen = ref("condition");
  for (const k of ["onMatched", "onNotMatched", "onUnknown"]) rule.properties.actions.properties[k].items = ref("action");
  delete rule.properties.meta;

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://justrefresh.local/schemas/rule.schema.json",
    title: "JustRefresh rule",
    description:
      "Declarative auto-refresh rule. Runtime validation additionally checks URL pattern syntax, regex safety, condition depth (max 6) and node count (max 50).",
    ...rule,
    $defs: {
      condition: { oneOf: conditions },
      trigger: { oneOf: triggers },
      action: { oneOf: actions },
    },
  };
}

/** Each registered condition/trigger/action's JSON Schema, by type (as getCapabilities reports them). */
export function buildHandlerSchemas(registries: Registries = defaultRegistries()) {
  const one = (schema: z.ZodMiniType): unknown => {
    try {
      return z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
    } catch {
      return {};
    }
  };
  const byType = (list: { type: string; schema: z.ZodMiniType }[]) => Object.fromEntries(list.map((h) => [h.type, one(h.schema)]));
  // all/any/not hold other conditions: say where their fields are (the rule schema uses $ref for this).
  const NESTED = "Any condition: see getSchema({ kind: 'condition', type }) for each type's fields";
  const conditions = byType(registries.conditions.list()) as Record<string, Json>;
  for (const s of Object.values(conditions)) {
    if (s.properties?.conditions?.items) s.properties.conditions.items.description = NESTED;
    if (s.properties?.condition) s.properties.condition.description = NESTED;
  }
  return {
    conditions,
    triggers: byType(registries.triggers.list()),
    actions: byType(registries.actions.list()),
  };
}
