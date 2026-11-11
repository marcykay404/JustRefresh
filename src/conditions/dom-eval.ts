/**
 * Page-side DOM condition evaluation. This module is bundled into the content
 * script, so it must stay dependency-free (no zod, no chrome APIs).
 *
 * Only minimal, structural information leaves the page: match status, counts,
 * and (for user-facing callers) a truncated text preview.
 */
import type { ConditionNode, ElementSummary, EvaluationResult, MatchDetails } from "../core/types";
import { checkRegexSafety } from "../core/url-pattern";

export const MAX_TEXT_LENGTH = 100_000;
export const PREVIEW_LENGTH = 80;

export type TextOperator =
  | "contains"
  | "not_contains"
  | "equals"
  | "not_equals"
  | "starts_with"
  | "ends_with"
  | "matches";

export type AttributeOperator = "exists" | "missing" | "equals" | "not_equals" | "contains" | "matches";

export interface DomEvalOptions {
  includeText: boolean;
}

export function summarizeElement(el: Element, includeText: boolean): ElementSummary {
  const summary: ElementSummary = { tag: el.tagName.toLowerCase() };
  if (el.id) summary.id = el.id;
  const classes = Array.from(el.classList).slice(0, 5);
  if (classes.length) summary.classes = classes;
  if (includeText) {
    const t = normalizeText(readText(el));
    summary.textPreview = t.length > PREVIEW_LENGTH ? `${t.slice(0, PREVIEW_LENGTH)}…` : t;
  }
  return summary;
}

function readText(el: Element): string {
  // innerText respects visibility and excludes <script>/<style>; jsdom lacks it.
  const html = el as HTMLElement;
  const raw = typeof html.innerText === "string" ? html.innerText : (el.textContent ?? "");
  return raw.length > MAX_TEXT_LENGTH ? raw.slice(0, MAX_TEXT_LENGTH) : raw;
}

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function query(doc: Document, selector: string): { ok: true; els: Element[] } | { ok: false; error: string } {
  try {
    return { ok: true, els: Array.from(doc.querySelectorAll(selector)) };
  } catch (e) {
    return { ok: false, error: `Invalid CSS selector "${selector}": ${(e as Error).message}` };
  }
}

export function compareText(
  actual: string,
  operator: TextOperator,
  expected: string,
  caseSensitive: boolean,
): boolean | { error: string } {
  const a = caseSensitive ? actual : actual.toLowerCase();
  const e = caseSensitive ? expected : expected.toLowerCase();
  switch (operator) {
    case "contains":
      return a.includes(e);
    case "not_contains":
      return !a.includes(e);
    case "equals":
      return a === e;
    case "not_equals":
      return a !== e;
    case "starts_with":
      return a.startsWith(e);
    case "ends_with":
      return a.endsWith(e);
    case "matches": {
      const problem = checkRegexSafety(expected);
      if (problem) return { error: problem };
      return new RegExp(expected, caseSensitive ? "" : "i").test(actual);
    }
  }
}

const bool = (b: boolean, details?: MatchDetails): EvaluationResult =>
  b ? { status: "matched", details } : { status: "not_matched", details };

export function evaluateDomCondition(node: ConditionNode, doc: Document, opts: DomEvalOptions): EvaluationResult {
  if (doc.readyState === "loading") {
    return { status: "unknown", code: "page_not_ready", reason: "Document is still loading" };
  }
  const evaluate = Object.hasOwn(EVALUATORS, node.type) ? EVALUATORS[node.type] : undefined;
  if (!evaluate) return { status: "unknown", code: "evaluation_error", reason: `Unsupported page condition "${node.type}"` };
  try {
    return evaluate(node, doc, opts);
  } catch (e) {
    return { status: "unknown", code: "evaluation_error", reason: (e as Error).message };
  }
}

type DomEvaluator = (node: ConditionNode, doc: Document, opts: DomEvalOptions) => EvaluationResult;

const invalidSelector = (error: string): EvaluationResult => ({ status: "unknown", code: "invalid_selector", reason: error });
const notFound: EvaluationResult = { status: "not_matched", details: { count: 0, note: "Element not found" } };
const compared = (out: boolean | { error: string }, details: MatchDetails): EvaluationResult =>
  typeof out === "object" ? { status: "unknown", code: "evaluation_error", reason: out.error } : bool(out, details);

/** dom.exists / dom.missing: at least `minCount` (default 1) elements match, or not. */
const existence: DomEvaluator = (node, doc, opts) => {
  const r = query(doc, String(node.selector));
  if (!r.ok) return invalidSelector(r.error);
  const min = typeof node.minCount === "number" ? node.minCount : 1;
  const exists = r.els.length >= min;
  const details = { count: r.els.length, element: r.els[0] ? summarizeElement(r.els[0], opts.includeText) : undefined };
  return bool(node.type === "dom.exists" ? exists : !exists, details);
};

/** dom.text: the first match's text (or the whole page's) compared with a value. */
const text: DomEvaluator = (node, doc, opts) => {
  const r = query(doc, typeof node.selector === "string" && node.selector ? node.selector : "body");
  if (!r.ok) return invalidSelector(r.error);
  const el = r.els[0];
  if (!el) return notFound;
  const out = compareText(normalizeText(readText(el)), node.operator as TextOperator, String(node.value ?? ""), node.caseSensitive === true);
  return compared(out, { count: r.els.length, element: summarizeElement(el, opts.includeText) });
};

const ATTRIBUTE_TEXT_OPS: Record<string, TextOperator> = { equals: "equals", not_equals: "not_equals", contains: "contains", matches: "matches" };

/** dom.attribute: the first match has / lacks an attribute, or its value compares with one. */
const attribute: DomEvaluator = (node, doc) => {
  const r = query(doc, String(node.selector));
  if (!r.ok) return invalidSelector(r.error);
  const el = r.els[0];
  if (!el) return notFound;
  const op = node.operator as AttributeOperator;
  const name = String(node.attribute);
  const value = el.getAttribute(name);
  const details = { count: r.els.length, element: summarizeElement(el, false) };
  if (op === "exists" || op === "missing") return bool((value !== null) === (op === "exists"), details);
  if (value === null) return { status: "not_matched", details: { ...details, note: `Attribute "${name}" absent` } };
  return compared(compareText(value, ATTRIBUTE_TEXT_OPS[op], String(node.value ?? ""), true), details);
};

const EVALUATORS: Record<string, DomEvaluator> = { "dom.exists": existence, "dom.missing": existence, "dom.text": text, "dom.attribute": attribute };

/** Selector testing utility for the rule builder. */
export function testSelector(doc: Document, selector: string, includeText: boolean) {
  const r = query(doc, selector);
  if (!r.ok) return { ok: false as const, error: r.error };
  return {
    ok: true as const,
    count: r.els.length,
    samples: r.els.slice(0, 5).map((el) => summarizeElement(el, includeText)),
  };
}
