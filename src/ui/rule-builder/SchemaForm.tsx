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
  const set = (k: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === "") {
      if (schema?.required?.includes(k)) next[k] = v ?? "";
      else delete next[k];
    } else next[k] = v;
    onChange(next);
  };
  return (
    <div className="row" style={{ alignItems: "flex-end" }}>
      {fields.map(([k, s]) => {
        const required = schema?.required?.includes(k);
        const label = `${humanize(k)}${required ? "" : " (optional)"}`;
        const v = value[k];
        let input: ReactNode;
        if (s.enum) {
          input = (
            <select value={String(v ?? "")} onChange={(e) => set(k, e.target.value || undefined)} aria-label={label}>
              {!required && <option value="">—</option>}
              {s.enum.map((o) => <option key={String(o)} value={String(o)}>{String(o).replace(/_/g, " ")}</option>)}
            </select>
          );
        } else if (s.type === "boolean") {
          input = (
            <select value={v === undefined ? "" : String(v)} onChange={(e) => set(k, e.target.value === "" ? undefined : e.target.value === "true")} aria-label={label}>
              {!required && <option value="">—</option>}
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          );
        } else if (s.type === "number" || s.type === "integer") {
          input = (
            <input
              type="number"
              aria-label={label}
              min={s.minimum}
              max={s.maximum}
              value={v === undefined ? "" : String(v)}
              onChange={(e) => set(k, e.target.value === "" ? undefined : Number(e.target.value))}
              style={{ width: 110 }}
            />
          );
        } else {
          const str = typeof v === "object" && v ? `${(v as { type: string }).type}:${(v as { value: string }).value}` : String(v ?? "");
          input = <input aria-label={label} value={str} onChange={(e) => set(k, e.target.value)} placeholder={s.description ?? ""} />;
        }
        return (
          <label key={k} className="field" title={s.description}>
            <span className="field-label">{label}</span>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              {input}
              {extra?.(k)}
            </div>
          </label>
        );
      })}
    </div>
  );
}
