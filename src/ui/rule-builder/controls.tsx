/** Small inputs used across the builder's sections. */
import { detectPattern, patternToString, validatePattern } from "../../core/url-pattern";
import type { ActionConfig, UrlPatternInput } from "../../core/types";
import { hasQuery, pagePatterns } from "../popup/describe";
import type { Capabilities } from "./draft";
import { defaultsFor, SchemaForm } from "./SchemaForm";

export function IntervalInput({ seconds, onChange, min }: { seconds: number; onChange: (s: number) => void; min: number }) {
  const unit = seconds % 3600 === 0 ? 3600 : seconds % 60 === 0 ? 60 : 1;
  return (
    <span className="row" style={{ gap: 4 }}>
      <span className="small">every</span>
      <input
        type="number"
        min={1}
        style={{ width: 80 }}
        value={seconds / unit}
        onChange={(e) => onChange(Math.round(Number(e.target.value) * unit))}
        aria-label="Interval value"
      />
      <select value={unit} onChange={(e) => onChange(Math.round((seconds / unit) * Number(e.target.value)))} aria-label="Interval unit">
        <option value={1}>seconds</option>
        <option value={60}>minutes</option>
        <option value={3600}>hours</option>
      </select>
      {seconds < min && (
        <span className="small" style={{ color: "var(--error)" }}>
          min {min}s
        </span>
      )}
    </span>
  );
}

export function PatternList({ label, items, onChange }: { label: string; items: UrlPatternInput[]; onChange: (p: UrlPatternInput[]) => void }) {
  return (
    <div className="col" style={{ gap: 4 }}>
      <span className="field-label">{label}</span>
      {items.map((p, i) => {
        const str = patternToString(p);
        const problem = validatePattern(p);
        return (
          <div key={i} className="row">
            <input
              style={{ flex: 1 }}
              className="mono"
              value={str}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
              aria-label={`${label} ${i + 1}`}
            />
            <span className="pill pill-muted">{detectPattern(p).type}</span>
            <button className="small danger" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove pattern">
              ✕
            </button>
            {problem && (
              <span className="small" style={{ color: "var(--error)", width: "100%" }}>
                {problem}
              </span>
            )}
            {!problem && detectPattern(p).type === "exact" && hasQuery(detectPattern(p).value) && (
              <button
                className="link small"
                style={{ width: "100%", textAlign: "left" }}
                onClick={() => onChange([...items.slice(0, i), ...pagePatterns(detectPattern(p).value, true), ...items.slice(i + 1)])}
              >
                Match this page whatever comes after “?” (for sites that change it on every load)
              </button>
            )}
          </div>
        );
      })}
      <div>
        <button className="small" onClick={() => onChange([...items, ""])}>
          + Pattern
        </button>{" "}
        <span className="small muted">
          Examples: <code>example.com</code>, <code>*.example.com</code>, <code>https://example.com/reports/*</code>,{" "}
          <code>^https://example\.com/orders/\d+$</code>
        </span>
      </div>
    </div>
  );
}

export function ActionList({
  label,
  items,
  caps,
  allowRefresh,
  onChange,
}: {
  label: string;
  items: ActionConfig[];
  caps: Capabilities["actions"];
  allowRefresh: boolean;
  onChange: (a: ActionConfig[]) => void;
}) {
  const available = caps.filter((a) => allowRefresh || a.type !== "refresh");
  return (
    <div className="col" style={{ gap: 4 }}>
      <span className="field-label">{label}</span>
      {items.length === 0 && <span className="small muted">Do nothing</span>}
      {items.map((a, i) => {
        const cap = caps.find((x) => x.type === a.type);
        return (
          <div key={i} className="cond-leaf">
            <div className="row">
              <select
                value={a.type}
                onChange={(e) =>
                  onChange(
                    items.map((x, j) => (j === i ? (defaultsFor(e.target.value, caps.find((c) => c.type === e.target.value)?.schema) as ActionConfig) : x)),
                  )
                }
                aria-label="Action type"
              >
                {available.map((c) => (
                  <option key={c.type} value={c.type}>
                    {c.title}
                  </option>
                ))}
                {!cap && <option value={a.type}>{a.type} (unknown)</option>}
              </select>
              <span className="small muted" style={{ flex: 1 }}>
                {cap?.description}
              </span>
              <button className="small danger" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove action">
                ✕
              </button>
            </div>
            <SchemaForm schema={cap?.schema} value={a} onChange={(v) => onChange(items.map((x, j) => (j === i ? (v as ActionConfig) : x)))} />
          </div>
        );
      })}
      <div>
        <button
          className="small"
          onClick={() => onChange([...items, { type: available.find((c) => !items.some((x) => x.type === c.type))?.type ?? available[0].type }])}
        >
          + Action
        </button>
      </div>
    </div>
  );
}

export function TriToggle({ label, value, onChange }: { label: string; value: boolean | undefined; onChange: (v: boolean | undefined) => void }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}>
        <option value="">Same as Settings</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    </label>
  );
}

export function OptNumber({
  value,
  onChange,
  placeholder = "—",
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      min={0}
      style={{ width: 140 }}
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
    />
  );
}

/** A select whose empty choice means "use the Settings default"; options are [value, label]. */
export function OptSelect({ value, options, onChange }: { value: string | undefined; options: [string, string][]; onChange: (v: string | undefined) => void }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">Same as Settings</option>
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}
