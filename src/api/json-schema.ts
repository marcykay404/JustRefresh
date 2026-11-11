/**
 * Builds the authoritative JSON Schema (draft 2020-12) for rules from the
 * same zod schemas and registries used at runtime. Written to
 * schemas/rule.schema.json by `npm run gen:schema`; a test keeps it in sync.
 */
import { z } from "zod";
import type { Registries } from "../registries";
import { defaultRegistries } from "../registries";
import { ruleInputSchema } from "../core/rule-schema";

type Json = Record<string, any>;

const strip = (s: Json): Json => {
  const { $schema: _s, ...rest } = s;
  return rest;
};

const toSchema = (schema: z.ZodType): Json => strip(z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }) as Json);

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
    $id: "https://smart-auto-refresh.local/schemas/rule.schema.json",
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
