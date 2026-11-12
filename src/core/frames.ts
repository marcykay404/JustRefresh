/**
 * A page and its frames, read as one page (frames from the page's own site
 * that the user granted access to; see content/index.ts and
 * background/chrome-ports.ts). Results come per frame, the top frame first.
 *
 * - A selector is looked up in the top frame, then in each frame: the first
 *   frame where it matches is the one compared. Counts (exists / missing) add
 *   up across frames.
 * - Text with no selector is the whole page's: it "contains" or "matches" when
 *   any frame does, "doesn't contain" only when no frame does, and "content
 *   changed" watches every frame. Other comparisons (equals, starts with, …)
 *   read the top frame only, as one text can't be put together from frames.
 * - A frame that can't be read yet (still loading, not set up) leaves a
 *   condition that depends on it `unknown` with code "frame_not_ready" (so
 *   `not` can't turn it into a match): "missing", "doesn't contain", "text
 *   gone" and "content changed" need every frame read. Something found in a
 *   frame that was read still counts. The engine treats an evaluation that is
 *   unknown only because of frames as "not this time" (see
 *   onlyFramesNotReady), and stateful conditions keep what they remembered.
 *   The top frame's own problems are the result's.
 */
import { fingerprint } from "../conditions/dom-eval";
import type { ActivitySnapshot } from "../shared/messaging-types";
import type { ConditionNode, EvaluationResult } from "./types";

const countOf = (r: EvaluationResult) => (r.status === "unknown" ? 0 : (r.details?.count ?? 0));
const hasSelector = (n: ConditionNode) => typeof n.selector === "string" && n.selector !== "";
const UNREAD = "A frame on the page couldn't be read yet";

/** Can't tell yet, because a frame couldn't be read. */
const notYet = (_from?: EvaluationResult): EvaluationResult => ({ status: "unknown", code: "frame_not_ready", reason: UNREAD });

/** One condition's results, one per frame (top first), as one page's. */
export function mergeLeaf(leaf: ConditionNode, perFrame: EvaluationResult[]): EvaluationResult {
  const [top, ...rest] = perFrame;
  if (!top) return { status: "unknown", code: "evaluation_error", reason: "No frame answered" };
  if (top.status === "unknown") return top;
  // A frame that was read but can't be checked (a real error, not "loading") is the result's problem too.
  const broken = rest.find((r) => r.status === "unknown" && r.code !== "page_not_ready" && r.code !== "frame_not_ready");
  if (broken) return broken;
  const read = [top, ...rest.filter((r) => r.status !== "unknown")];
  const unread = read.length < perFrame.length;
  if (leaf.type === "dom.exists" || leaf.type === "dom.missing") return existence(leaf, read, unread);
  if (hasSelector(leaf)) {
    // Found in the page itself: frames don't matter. Elsewhere, an unread frame might come first.
    if (countOf(top) > 0) return top;
    const found = read.find((r) => countOf(r) > 0);
    if (unread) return found?.status === "matched" && isPositive(leaf) ? found : notYet(top);
    return found ?? top;
  }
  return wholePage(leaf, read, unread) ?? top;
}

/** Conditions whose match is something found, not something absent: an unread frame can't undo it. */
function isPositive(leaf: ConditionNode): boolean {
  if (leaf.type === "dom.text") return ["contains", "equals", "starts_with", "ends_with", "matches"].includes(String(leaf.operator));
  if (leaf.type === "dom.attribute") return ["exists", "equals", "contains", "matches"].includes(String(leaf.operator));
  // "Text gone": the page reports "the text is there" as matched, which a frame not read can't undo.
  return leaf.type === "dom.text_lost";
}

function existence(leaf: ConditionNode, read: EvaluationResult[], unread: boolean): EvaluationResult {
  const count = read.reduce((n, r) => n + countOf(r), 0);
  const min = typeof leaf.minCount === "number" ? leaf.minCount : 1;
  const first = read.find((r) => countOf(r) > 0) ?? read[0]!;
  const details = { ...(first.status === "unknown" ? {} : first.details), count };
  const exists = count >= min;
  // Enough found is enough; "too few" or "missing" needs every frame read.
  if (leaf.type === "dom.exists") return exists ? { status: "matched", details } : unread ? notYet(first) : { status: "not_matched", details };
  if (count > 0) return { status: "not_matched", details };
  return unread ? notYet(first) : { status: "matched", details };
}

/** What was found, else (nothing found) the top frame's answer, or "not yet" while a frame is unread. */
const foundOr = (found: EvaluationResult | undefined, top: EvaluationResult, unread: boolean) => found ?? (unread ? notYet(top) : top);

/** Text conditions without a selector, over every frame's text. null: the top frame decides. */
function wholePage(leaf: ConditionNode, read: EvaluationResult[], unread: boolean): EvaluationResult | null {
  const top = read[0]!;
  const matched = read.find((r) => r.status === "matched");
  if (leaf.type === "dom.changed") return wholePageChanged(read, unread);
  // "Text gone": the page reports "the text is there" as matched.
  if (leaf.type === "dom.text_lost") return foundOr(matched, top, unread);
  if (leaf.type !== "dom.text") return null;
  if (leaf.operator === "contains" || leaf.operator === "matches") return foundOr(matched, top, unread);
  // "Doesn't contain" is not_matched in a frame that contains it (one without a body has nothing to contain).
  if (leaf.operator === "not_contains")
    return foundOr(
      read.find((r) => r.status === "not_matched" && countOf(r) > 0),
      top,
      unread,
    );
  return null;
}

/** "Content changed" on the whole page: one fingerprint over every frame's, the same way however many there are. */
function wholePageChanged(read: EvaluationResult[], unread: boolean): EvaluationResult {
  const top = read[0]!;
  if (top.status === "unknown") return top;
  if (unread) return notYet(top);
  // Frames with no text don't count: an empty or helper frame coming and going isn't a change.
  const empty = fingerprint("");
  const prints = read
    .slice(1)
    .map((r) => (r.status === "unknown" ? "" : (r.details?.fingerprint ?? "")))
    .filter((f) => f !== "" && f !== empty);
  return { ...top, details: { ...top.details, fingerprint: fingerprint([top.details?.fingerprint ?? "", ...prints].join("|")) } };
}

/** Results per frame (each an array over `leaves`, or null for a frame that couldn't answer), top first, as one page's. */
export function mergeFrames(leaves: ConditionNode[], frames: (EvaluationResult[] | null)[]): EvaluationResult[] {
  const unreadable: EvaluationResult = { status: "unknown", code: "page_not_ready", reason: UNREAD };
  return leaves.map((leaf, i) =>
    mergeLeaf(
      leaf,
      frames.map((f) => (f ? (f[i] ?? unreadable) : unreadable)),
    ),
  );
}

/**
 * You're using the page if you're using any of its frames. Form results are
 * the top frame's. "Monitoring for" is the shortest among frames you're
 * editing in (a frame given access just now has no typing history yet).
 */
export function mergeActivity(frames: ActivitySnapshot[]): ActivitySnapshot | null {
  const [top, ...rest] = frames;
  if (!top) return null;
  const all = [top, ...rest];
  const since = (k: "sinceKeyMs" | "sinceInputMs" | "sincePointerMs" | "sinceScrollMs") => {
    const known = all.map((s) => s[k]).filter((v): v is number => v !== null);
    return known.length ? Math.min(...known) : null;
  };
  const dirty = all.some((s) => s.dirty === "dirty") ? "dirty" : all.some((s) => s.dirty === "unknown") ? "unknown" : "clean";
  const editing = all.filter((s) => s.editing);
  return {
    ...top,
    monitoringForMs: editing.length ? Math.min(...editing.map((s) => s.monitoringForMs)) : top.monitoringForMs,
    sinceKeyMs: since("sinceKeyMs"),
    sinceInputMs: since("sinceInputMs"),
    sincePointerMs: since("sincePointerMs"),
    sinceScrollMs: since("sinceScrollMs"),
    composing: all.some((s) => s.composing),
    editing: editing.length > 0,
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

/**
 * The site a host belongs to, roughly (no public-suffix list): its last two
 * labels, or three under a country's second level ("example.com.sg",
 * "example.co.uk"). Addresses and single-label hosts are their own site.
 */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(h) || h.includes(":") || !h.includes(".")) return h;
  const labels = h.split(".");
  const countrySecondLevel = labels.at(-1)!.length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go|mil)$/.test(labels.at(-2)!);
  return labels.slice(countrySecondLevel ? -3 : -2).join(".");
}
