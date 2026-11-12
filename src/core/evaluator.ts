/**
 * Condition-tree evaluation with tri-state results.
 *
 * Page conditions (DOM) are collected and evaluated in ONE batched round-trip
 * to the content script; browser and logical conditions run in the service
 * worker. Logical nodes combine children with Kleene three-valued logic, so a
 * definite answer is still possible when some leaves are `unknown`
 * (e.g. `any(unknownDom, refreshCount >= 100)` matches once the count is hit).
 */
import type { Registries } from "../registries";
import { defaultRegistries } from "../registries";
import type { RuleContext } from "../registries/contracts";
import type { ConditionNode, EvaluationResult, EvaluationTrace } from "./types";
import { TimeoutError } from "./timeout";

export type PageEvaluator = (leaves: ConditionNode[]) => Promise<EvaluationResult[]>;

export interface EvaluationInput {
  now: number;
  tab: RuleContext["tab"];
  runtime: RuleContext["runtime"];
  pageEvaluator: PageEvaluator;
  registries?: Registries;
  /** What stateful conditions remembered at the previous check (TabRuntime.memory); null = don't compare this time. */
  memory?: Record<string, string> | null;
}

export interface EvaluationOutput {
  result: EvaluationResult;
  trace: EvaluationTrace;
  /** The memory to keep for the next check. */
  memory: Record<string, string>;
}

/** Each node's place in the tree ("0", "0.1", …): the key stateful conditions remember under. */
function placesOf(root: ConditionNode, registries: Registries): Map<ConditionNode, string> {
  const out = new Map<ConditionNode, string>();
  const visit = (n: ConditionNode, place: string) => {
    out.set(n, place);
    (registries.conditions.get(n.type)?.children?.(n) ?? []).forEach((c, i) => visit(c, `${place}.${i}`));
  };
  visit(root, "0");
  return out;
}

export function collectPageLeaves(root: ConditionNode, registries: Registries): ConditionNode[] {
  const out: ConditionNode[] = [];
  const visit = (n: ConditionNode) => {
    const h = registries.conditions.get(n.type);
    if (!h) return;
    if (h.context === "page") out.push(n);
    for (const c of h.children?.(n) ?? []) visit(c);
  };
  visit(root);
  return out;
}

export async function evaluateConditionTree(root: ConditionNode, input: EvaluationInput): Promise<EvaluationOutput> {
  const registries = input.registries ?? defaultRegistries();
  const leaves = collectPageLeaves(root, registries);
  const pageResults = new Map<ConditionNode, EvaluationResult>();
  if (leaves.length) {
    let results: EvaluationResult[];
    try {
      results = await input.pageEvaluator(leaves);
    } catch (e) {
      const reason = (e as Error).message || "Page evaluation failed";
      const code = e instanceof TimeoutError ? "timeout" : "content_script_unavailable";
      results = leaves.map(() => ({ status: "unknown", code, reason }));
    }
    leaves.forEach((leaf, i) => {
      pageResults.set(leaf, results[i] ?? { status: "unknown", code: "evaluation_error", reason: "Missing page result" });
    });
  }

  const traces = new Map<ConditionNode, EvaluationTrace>();
  const places = placesOf(root, registries);
  const memory: Record<string, string> = { ...input.memory };
  const memoryOf = (node: ConditionNode): RuleContext["memory"] => {
    if (input.memory === null) return null;
    const key = `${places.get(node) ?? "?"}:${node.type}`;
    return {
      get: () => (Object.hasOwn(memory, key) ? memory[key] : undefined),
      set: (v) => {
        if (v === undefined) delete memory[key];
        else memory[key] = v;
      },
    };
  };

  const evaluate = async (node: ConditionNode): Promise<EvaluationResult> => {
    const handler = registries.conditions.get(node.type);
    let result: EvaluationResult;
    if (!handler) {
      result = { status: "unknown", code: "evaluation_error", reason: `Unknown condition "${node.type}"` };
    } else {
      const ctx: RuleContext = {
        now: input.now,
        tab: input.tab,
        runtime: input.runtime,
        evaluateChild: evaluate,
        pageResult: (n) => pageResults.get(n) ?? { status: "unknown", code: "evaluation_error", reason: "Page condition was not evaluated" },
        memory: memoryOf(node),
      };
      try {
        result = await handler.evaluate(node, ctx);
      } catch (e) {
        result = { status: "unknown", code: "evaluation_error", reason: (e as Error).message };
      }
    }
    const children = handler
      ?.children?.(node)
      .map((c) => traces.get(c))
      .filter((t): t is EvaluationTrace => !!t);
    traces.set(node, { type: node.type, result, ...(children?.length ? { children } : {}) });
    return result;
  };

  const result = await evaluate(root);
  return { result, trace: traces.get(root)!, memory };
}

/**
 * Unknown only because frames of the page couldn't be read yet (every unknown
 * leaf says "frame_not_ready"): nothing is wrong with the page, so the engine
 * treats it as "not this time" rather than applying the onUnknown policy.
 */
export function onlyFramesNotReady(trace: EvaluationTrace): boolean {
  if (trace.result.status !== "unknown") return false;
  // Only the unknown parts decide the result's unknown: a subtree that resolved doesn't count.
  const leaves: EvaluationTrace[] = [];
  const walk = (t: EvaluationTrace) => {
    if (t.result.status !== "unknown") return;
    if (t.children?.length) t.children.forEach(walk);
    else leaves.push(t);
  };
  walk(trace);
  return leaves.length > 0 && leaves.every((l) => l.result.status === "unknown" && l.result.code === "frame_not_ready");
}

/** Human-readable one-line explanation of a trace (for status & history). */
export function explainTrace(trace: EvaluationTrace): string {
  const r = trace.result;
  if (r.status === "unknown") {
    const leaf = findFirstUnknownLeaf(trace);
    return `unknown (${leaf ? `${leaf.type}: ` : ""}${leaf && leaf.result.status === "unknown" ? leaf.result.reason : r.reason})`;
  }
  return r.status;
}

function findFirstUnknownLeaf(t: EvaluationTrace): EvaluationTrace | null {
  if (t.result.status !== "unknown") return null;
  for (const c of t.children ?? []) {
    const found = findFirstUnknownLeaf(c);
    if (found) return found;
  }
  return t;
}
