/**
 * Renders a form for a flat JSON Schema object (as published by
 * getCapabilities). New condition/action types registered in the engine
 * appear in the builder automatically — no UI changes needed.
 */
import type { ReactNode } from "react";

export interface JsonSchema {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  description?: string;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
}

const LABELS: Record<string, string> = {
  selector: "CSS selector",
  minCount: "Min. count",
  caseSensitive: "Case sensitive",
  bypassCache: "Bypass cache",
  randomMaxSeconds: "Random max (s)",
};

export const humanize = (k: string) => LABELS[k] ?? k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

/** Fields managed by the schema form (excludes `type` and nested conditions). */
export function editableFields(schema: JsonSchema | undefined): [string, JsonSchema][] {
  return Object.entries(schema?.properties ?? {}).filter(([k]) => k !== "type" && k !== "conditions" && k !== "condition");
}

export function defaultsFor(type: string, schema: JsonSchema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { type };
  for (const [k, s] of editableFields(schema)) {
    if (!schema?.required?.includes(k)) continue;
    if (s.enum) out[k] = s.enum[0];
    else if (s.type === "number" || s.type === "integer") out[k] = s.minimum ?? 0;
    else if (s.type === "boolean") out[k] = false;
    else out[k] = "";
  }
  return out;
}

/** "type:value" for a pattern object, else the value as text. */
const asText = (v: unknown) => (typeof v === "object" && v ? `${(v as { type: string }).type}:${(v as { value: string }).value}` : String(v ?? ""));

/** One field's control, chosen by its schema; `set(undefined)` clears it. */
function FieldInput({
  schema: s,
  value: v,
  label,
  required,
  set,
}: {
  schema: JsonSchema;
  value: unknown;
  label: string;
  required: boolean;
  set: (v: unknown) => void;
}) {
  const none = required ? null : <option value="">—</option>;
  if (s.enum) {
    return (
      <select value={String(v ?? "")} onChange={(e) => set(e.target.value || undefined)} aria-label={label}>
        {none}
        {s.enum.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o).replace(/_/g, " ")}
          </option>
        ))}
      </select>
    );
  }
  if (s.type === "boolean") {
    return (
      <select value={v === undefined ? "" : String(v)} onChange={(e) => set(e.target.value === "" ? undefined : e.target.value === "true")} aria-label={label}>
        {none}
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  if (s.type === "number" || s.type === "integer") {
    return (
      <input
        type="number"
        aria-label={label}
        min={s.minimum}
        max={s.maximum}
        value={v === undefined ? "" : String(v)}
        onChange={(e) => set(e.target.value === "" ? undefined : Number(e.target.value))}
        style={{ width: 110 }}
      />
    );
  }
  return <input aria-label={label} value={asText(v)} onChange={(e) => set(e.target.value)} placeholder={s.description ?? ""} />;
}

export function SchemaForm({
  schema,
  value,
  onChange,
  extra,
}: {
  schema: JsonSchema | undefined;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  extra?: (key: string) => ReactNode;
}) {
  const fields = editableFields(schema);
  if (!fields.length) return null;
  const isRequired = (k: string) => !!schema?.required?.includes(k);
  const set = (k: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === "") {
      if (isRequired(k)) next[k] = v ?? "";
      else delete next[k];
    } else next[k] = v;
    onChange(next);
  };
  return (
    <div className="row" style={{ alignItems: "flex-end" }}>
      {fields.map(([k, s]) => {
        const label = `${humanize(k)}${isRequired(k) ? "" : " (optional)"}`;
        return (
          <label key={k} className="field" title={s.description}>
            <span className="field-label">{label}</span>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <FieldInput schema={s} value={value[k]} label={label} required={isRequired(k)} set={(v) => set(k, v)} />
              {extra?.(k)}
            </div>
          </label>
        );
      })}
    </div>
  );
}
