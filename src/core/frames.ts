/**
 * A page and its frames, read as one page (frames from sites the user granted
 * access to; see content/index.ts). Results come per frame, the top frame
 * first, then the others in the order Chrome numbered them.
 *
 * - A selector is looked up in the top frame, then in each frame: the first
 *   frame where it matches is the one compared. Counts (exists / missing) add
 *   up across frames.
 * - Text with no selector is the whole page's: it "contains" or "matches" when
 *   any frame does, "doesn't contain" only when no frame does, and "content
 *   changed" watches every frame. Other comparisons (equals, starts with, …)
 *   read the top frame only, as one text can't be put together from frames.
 * - A frame that can't be read right now (still loading) is left out; the top
 *   frame's problems are the result's.
 */
import { fingerprint } from "../conditions/dom-eval";
import type { ActivitySnapshot } from "../shared/messaging-types";
import type { ConditionNode, EvaluationResult } from "./types";

const countOf = (r: EvaluationResult) => (r.status === "unknown" ? 0 : (r.details?.count ?? 0));
const hasSelector = (n: ConditionNode) => typeof n.selector === "string" && n.selector !== "";

/** One condition's results, one per frame (top first), as one page's. */
export function mergeLeaf(leaf: ConditionNode, perFrame: EvaluationResult[]): EvaluationResult {
  const [top, ...rest] = perFrame;
  if (!top) return { status: "unknown", code: "evaluation_error", reason: "No frame answered" };
  const frames = rest.filter((r) => r.status !== "unknown");
  if (top.status === "unknown" || frames.length === 0) return top;
  const all = [top, ...frames];
  if (leaf.type === "dom.exists" || leaf.type === "dom.missing") return existence(leaf, all);
  if (hasSelector(leaf)) return all.find((r) => countOf(r) > 0) ?? top;
  return wholePage(leaf, all) ?? top;
}

function existence(leaf: ConditionNode, all: EvaluationResult[]): EvaluationResult {
  const count = all.reduce((n, r) => n + countOf(r), 0);
  const min = typeof leaf.minCount === "number" ? leaf.minCount : 1;
  const exists = leaf.type === "dom.exists" ? count >= min : count === 0;
  const first = all.find((r) => countOf(r) > 0) ?? all[0]!;
  const details = { ...(first.status === "unknown" ? {} : first.details), count };
  return exists ? { status: "matched", details } : { status: "not_matched", details };
}

/** Text conditions without a selector, over every frame's text. null: the top frame decides. */
function wholePage(leaf: ConditionNode, all: EvaluationResult[]): EvaluationResult | null {
  const anyMatched = () => all.find((r) => r.status === "matched") ?? all[0]!;
  if (leaf.type === "dom.text_lost") return anyMatched(); // the page reports "the text is there"
  if (leaf.type === "dom.changed") {
    const prints = all.map((r) => (r.status === "unknown" ? "" : (r.details?.fingerprint ?? "")));
    const top = all[0]!;
    if (top.status === "unknown") return top;
    return { ...top, details: { ...top.details, fingerprint: fingerprint(prints.join("|")) } };
  }
  if (leaf.type !== "dom.text") return null;
  if (leaf.operator === "contains" || leaf.operator === "matches") return anyMatched();
  if (leaf.operator === "not_contains") return all.find((r) => r.status === "not_matched") ?? all[0]!;
  return null;
}

/** Results per frame (each an array over `leaves`), top first, as one page's. */
export function mergeFrames(leaves: ConditionNode[], frames: EvaluationResult[][]): EvaluationResult[] {
  return leaves.map((leaf, i) =>
    mergeLeaf(
      leaf,
      frames.map((f) => f[i] ?? { status: "unknown", code: "evaluation_error", reason: "Missing result" }),
    ),
  );
}

/** You're using the page if you're using any of its frames. Form results are the top frame's. */
export function mergeActivity(frames: ActivitySnapshot[]): ActivitySnapshot | null {
  const [top, ...rest] = frames;
  if (!top) return null;
  const all = [top, ...rest];
  const since = (k: "sinceKeyMs" | "sinceInputMs" | "sincePointerMs" | "sinceScrollMs") => {
    const known = all.map((s) => s[k]).filter((v): v is number => v !== null);
    return known.length ? Math.min(...known) : null;
  };
  const dirty = all.some((s) => s.dirty === "dirty") ? "dirty" : all.some((s) => s.dirty === "unknown") ? "unknown" : "clean";
  return {
    ...top,
    sinceKeyMs: since("sinceKeyMs"),
    sinceInputMs: since("sinceInputMs"),
    sincePointerMs: since("sincePointerMs"),
    sinceScrollMs: since("sinceScrollMs"),
    composing: all.some((s) => s.composing),
    editing: all.some((s) => s.editing),
    dirty,
  };
}

/** Selector test over every frame: counts add up, samples from the first frames with matches. */
export function mergeSelectorTests<T extends { ok: true; count: number; samples: unknown[] } | { ok: false; error: string }>(results: T[]): T {
  const [top, ...rest] = results;
  if (!top || !top.ok) return top!;
  const ok = [top, ...rest].filter((r): r is T & { ok: true } => r.ok);
  return { ...top, count: ok.reduce((n, r) => n + r.count, 0), samples: ok.flatMap((r) => r.samples).slice(0, 5) };
}
