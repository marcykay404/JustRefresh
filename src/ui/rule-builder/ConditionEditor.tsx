import type { ConditionNode } from "../../core/types";
import { defaultsFor, SchemaForm, type JsonSchema } from "./SchemaForm";

export interface CapabilityItem {
  type: string;
  title: string;
  description: string;
  context?: string;
  schema: JsonSchema;
}

const LOGICAL = new Set(["all", "any", "not"]);

interface Props {
  node: ConditionNode;
  onChange: (n: ConditionNode | null) => void;
  conditions: CapabilityItem[];
  advanced: boolean;
  depth?: number;
  onTestSelector?: (selector: string) => void;
}

export function ConditionEditor({ node, onChange, conditions, advanced, depth = 0, onTestSelector }: Props) {
  const leafTypes = conditions.filter((c) => !LOGICAL.has(c.type));
  const schemaOf = (t: string) => conditions.find((c) => c.type === t)?.schema;

  if (node.type === "all" || node.type === "any") {
    const children = (node.conditions as ConditionNode[]) ?? [];
    const setChild = (i: number, c: ConditionNode | null) => {
      const next = c === null ? children.filter((_, j) => j !== i) : children.map((x, j) => (j === i ? c : x));
      if (next.length === 0) onChange(null);
      else onChange({ ...node, conditions: next });
    };
    return (
      <div className="cond-group">
        <div className="row">
          <select
            aria-label="Group logic"
            value={node.type}
            onChange={(e) => onChange({ ...node, type: e.target.value })}
          >
            <option value="any">ANY of these (OR)</option>
            <option value="all">ALL of these (AND)</option>
          </select>
          {depth > 0 && <button className="small danger" onClick={() => onChange(null)}>Remove group</button>}
        </div>
        {children.map((c, i) => (
          <ConditionEditor key={i} node={c} onChange={(n) => setChild(i, n)} conditions={conditions} advanced={advanced} depth={depth + 1} onTestSelector={onTestSelector} />
        ))}
        <div className="row">
          <button className="small" onClick={() => onChange({ ...node, conditions: [...children, defaultsFor(leafTypes[0].type, leafTypes[0].schema) as ConditionNode] })}>
            + Condition
          </button>
          {advanced && depth < 4 && (
            <>
              <button className="small" onClick={() => onChange({ ...node, conditions: [...children, { type: node.type === "any" ? "all" : "any", conditions: [defaultsFor(leafTypes[0].type, leafTypes[0].schema) as ConditionNode] }] })}>
                + Group
              </button>
              <button className="small" onClick={() => onChange({ ...node, conditions: [...children, { type: "not", condition: defaultsFor(leafTypes[0].type, leafTypes[0].schema) as ConditionNode }] })}>
                + NOT
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (node.type === "not") {
    return (
      <div className="cond-group not">
        <div className="row">
          <strong className="small">NOT</strong>
          <button className="small danger" onClick={() => onChange(null)}>Remove</button>
        </div>
        <ConditionEditor
          node={node.condition as ConditionNode}
          onChange={(n) => onChange(n === null ? null : { ...node, condition: n })}
          conditions={conditions}
          advanced={advanced}
          depth={depth + 1}
          onTestSelector={onTestSelector}
        />
      </div>
    );
  }

  const cap = conditions.find((c) => c.type === node.type);
  return (
    <div className="cond-leaf">
      <div className="row">
        <select
          aria-label="Condition type"
          value={node.type}
          onChange={(e) => onChange(defaultsFor(e.target.value, schemaOf(e.target.value)) as ConditionNode)}
        >
          {leafTypes.map((c) => (
            <option key={c.type} value={c.type}>{c.title}</option>
          ))}
          {!cap && <option value={node.type}>{node.type} (unknown)</option>}
        </select>
        <span className="small muted" style={{ flex: 1 }}>{cap?.description}</span>
        <button className="small danger" aria-label="Remove condition" onClick={() => onChange(null)}>✕</button>
      </div>
      <SchemaForm
        schema={cap?.schema}
        value={node}
        onChange={(v) => onChange(v as ConditionNode)}
        extra={(k) =>
          k === "selector" && onTestSelector ? (
            <button className="small" type="button" onClick={() => onTestSelector(String(node.selector ?? ""))} title="Count matching elements in the selected tab">
              Test
            </button>
          ) : null
        }
      />
    </div>
  );
}

export function isSimpleTree(node: ConditionNode | undefined): boolean {
  if (!node) return true;
  if (node.type === "any" || node.type === "all") {
    return (node.conditions as ConditionNode[]).every((c) => !LOGICAL.has(c.type));
  }
  return !LOGICAL.has(node.type);
}

const nested = (n: ConditionNode, joiner: string) => (n.conditions as ConditionNode[]).map(describeCondition).join(joiner);

const DESCRIBE: Record<string, (n: ConditionNode) => string> = {
  all: (n) => nested(n, " AND "),
  any: (n) => nested(n, " OR "),
  not: (n) => `NOT (${describeCondition(n.condition as ConditionNode)})`,
  "dom.exists": (n) => `${n.selector} exists`,
  "dom.missing": (n) => `${n.selector} is missing`,
  "dom.text": (n) => `${n.selector ?? "page"} text ${String(n.operator).replace(/_/g, " ")} "${n.value}"`,
  "dom.attribute": (n) => `${n.selector}[${n.attribute}] ${n.operator}${n.value !== undefined ? ` "${n.value}"` : ""}`,
  "url.match": (n) => `URL matches ${typeof n.pattern === "string" ? n.pattern : JSON.stringify(n.pattern)}`,
  refreshCount: (n) => `refresh count ${n.operator} ${n.value}`,
  "time.after": (n) => `time is after ${n.at}`,
  "time.before": (n) => `time is before ${n.at}`,
  "tab.status": (n) => `tab is ${n.value}`,
};

export function describeCondition(n: ConditionNode): string {
  return Object.hasOwn(DESCRIBE, n.type) ? DESCRIBE[n.type]!(n) : n.type;
}
