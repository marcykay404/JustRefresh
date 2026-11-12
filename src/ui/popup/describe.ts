/**
 * Plain-language helpers for the popup: interval labels, the interval chips,
 * a one-line summary of a rule, and the rule that "Refresh until something
 * appears" creates. Pure functions, so they are unit tested.
 */
import type { ActionConfig, ConditionNode, Rule, RuleInput, UrlPatternInput } from "../../core/types";

/** "No limit", "20 min", "1 hour", "24 hours" for a stop-after choice in minutes. */
export function stopAfterLabel(minutes: number | null): string {
  return minutes === null ? "No limit" : intervalLabel(minutes * 60);
}

/** 30 → "30 sec", 60 → "1 min", 90 → "1 min 30 sec", 3600 → "1 hour", 5400 → "1 hr 30 min". */
export function intervalLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} sec`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${m} min ${rest} sec` : `${m} min`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (m) return `${h} hr ${m} min`;
  return h === 1 ? "1 hour" : `${h} hours`;
}

/** The one-tap interval chips (Custom… is added by the UI). */
export function intervalChips(fastAllowed: boolean): number[] {
  return fastAllowed ? [10, 30, 60, 300, 900] : [30, 60, 300, 900, 3600];
}

const quote = (v: unknown) => `“${String(v)}”`;

type Node = { type: string; [k: string]: unknown };
const whereOf = (n: Node) => (typeof n.selector === "string" && n.selector ? ` in ${n.selector}` : "");

const TEXT_WORDS: Record<string, (n: Node) => string> = {
  contains: (n) => `${quote(n.value)} appears${whereOf(n)}`,
  not_contains: (n) => `${quote(n.value)} isn't on the page${whereOf(n)}`,
  equals: (n) => `the text${whereOf(n)} is ${quote(n.value)}`,
};

const group = (n: Node) => {
  const items = (n.conditions as ConditionNode[] | undefined) ?? [];
  if (items.length === 1) return describeCondition(items[0]!);
  return `${n.type === "all" ? "all" : "any"} of ${items.length} conditions match`;
};

const CONDITION_WORDS: Record<string, (n: Node) => string> = {
  "dom.text": (n) => (Object.hasOwn(TEXT_WORDS, String(n.operator)) ? TEXT_WORDS[String(n.operator)]!(n) : `the text${whereOf(n)} matches ${quote(n.value)}`),
  "dom.text_lost": (n) => `${quote(n.value)} disappears${whereOf(n)}`,
  "dom.changed": (n) => (whereOf(n) ? `the content${whereOf(n)} changes` : "the page changes"),
  "dom.exists": (n) => `${String(n.selector)} appears on the page`,
  "dom.missing": (n) => `${String(n.selector)} is gone from the page`,
  all: group,
  any: group,
  not: () => "a condition stops matching",
};

/** "“In stock” appears", "an element matching .buy appears", … */
export function describeCondition(c: ConditionNode): string {
  const n = c as Node;
  return Object.hasOwn(CONDITION_WORDS, n.type) ? CONDITION_WORDS[n.type]!(n) : "its condition matches";
}

/**
 * "Refreshing every 10 min until “S$ 3” appears, then notify me".
 * `effectiveSeconds`: the interval actually in effect, when it differs from the
 * rule's own (fast intervals run at 30 s while they're turned off).
 */
export function describeRule(rule: Pick<Rule, "trigger" | "stopWhen" | "actions">, effectiveSeconds?: number | null): string {
  const when = triggerPhrase(rule.trigger as { type: string; seconds?: number }, effectiveSeconds);
  const { onUnknown } = rule.actions;
  const unknown = onUnknown?.length ? `; if the page can't be checked: ${actionsPhrase(onUnknown)}` : "";
  const main = rule.stopWhen ? withCondition(when, describeCondition(rule.stopWhen), rule.actions) : withoutCondition(when, rule.actions.onNotMatched);
  return main + unknown;
}

const TRIGGER_PHRASES: Record<string, string> = {
  startup: "once when the browser starts",
  manual: "only when you run it",
  navigation: "each time the page loads",
  urlChange: "each time the address changes",
};

/** "every 5 min", "each time the page loads", … */
function triggerPhrase(t: { type: string; seconds?: number }, effectiveSeconds?: number | null): string {
  const seconds = effectiveSeconds ?? t.seconds;
  if (t.type === "interval" && seconds) return `every ${intervalLabel(seconds)}`;
  return Object.hasOwn(TRIGGER_PHRASES, t.type) ? TRIGGER_PHRASES[t.type]! : `on its ${t.type} trigger`;
}

const has = (list: readonly ActionConfig[], type: string) => list.some((a) => a.type === type);
const without = (list: readonly ActionConfig[], type: string) => list.filter((a) => a.type !== type);
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

/** Without a condition every run counts as "not matched". */
function withoutCondition(when: string, onNotMatched: readonly ActionConfig[]): string {
  if (!onNotMatched.length) return `Runs ${when}`;
  const others = without(onNotMatched, "refresh");
  if (has(onNotMatched, "refresh")) return `Refreshing ${when}${others.length ? `, and each time: ${actionsPhrase(others)}` : ""}`;
  return `${cap(when)}: ${actionsPhrase(onNotMatched)} (no refresh)`;
}

function withCondition(when: string, cond: string, { onMatched, onNotMatched }: Rule["actions"]): string {
  // The usual shape: refresh until the condition matches, then stop (and notify).
  const refreshesOnly = has(onNotMatched, "refresh") && without(onNotMatched, "refresh").length === 0;
  if (refreshesOnly && has(onMatched, "stopRefresh") && !has(onMatched, "refresh")) {
    const then = without(onMatched, "stopRefresh");
    return `Refreshing ${when} until ${cond}${then.length ? `, then ${actionsPhrase(then)}` : ""}`;
  }
  // Rules that only look at the page (page loads can't refresh).
  if (!onNotMatched.length && onMatched.length && !has(onMatched, "refresh")) return `Checking ${when}: ${actionsPhrase(onMatched)} when ${cond}`;
  return `${cap(when)}: when ${cond}, ${actionsPhrase(onMatched)}; otherwise ${actionsPhrase(onNotMatched)}`;
}

type ActionWords = ActionConfig & { minutes?: number; selector?: string; text?: string; keepScroll?: boolean; url?: string; includePageUrl?: boolean };

const ACTION_WORDS: Record<string, (a: ActionWords) => string> = {
  refresh: (a) => (a.keepScroll ? "refresh (keeping the scroll position)" : "refresh"),
  stopRefresh: () => "stop",
  pauseRefresh: (a) => (a.minutes ? `pause for ${intervalLabel(a.minutes * 60)}` : "pause"),
  resumeRefresh: () => "resume",
  notify: () => "notify me",
  log: () => "note it in History",
  click: (a) => `click ${a.selector}`,
  highlight: (a) => `highlight ${a.text ? quote(a.text) : a.selector}${a.text && a.selector ? ` in ${a.selector}` : ""}`,
  // Shown when approving agents' rules: say exactly where it goes and what it sends.
  webhook: (a) => `send a message to ${a.url}${a.includePageUrl ? " (with the page address)" : ""}`,
};

/** "refresh", "notify me and stop", … ("do nothing" for none). */
export function actionsPhrase(list: readonly ActionConfig[]): string {
  const words = list.map((a) => (Object.hasOwn(ACTION_WORDS, a.type) ? ACTION_WORDS[a.type]!(a as ActionWords) : a.type));
  if (!words.length) return "do nothing";
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

export type UntilMode = "appears" | "disappears";

/**
 * A priority that outranks every rule in `matching`. Between rules, the higher
 * priority wins and ties go to the older rule, so a new rule needs to be above
 * the ones already matching its page to take effect there.
 */
export function priorityAbove(matching: readonly { priority: number }[]): number {
  return matching.length ? Math.min(1000, Math.max(...matching.map((r) => r.priority)) + 1) : 0;
}

/** "Back in stock: shop.example.com/item/42" without the query string (it may hold order numbers or emails). */
export function pageName(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

/** Whether the address has a "?…" part (which some sites change on every load). */
export function hasQuery(url: string): boolean {
  try {
    return new URL(url).search.length > 1;
  } catch {
    return false;
  }
}

/** The address without its "?…" and "#…" parts. */
export function withoutQuery(url: string): string {
  try {
    // Not origin + pathname: a file: URL's origin is "null".
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

/**
 * URL patterns for one page. `anyQuery`: the page whatever comes after "?"
 * (the address without it, or with any "?…"); otherwise exactly this address.
 */
export function pagePatterns(url: string, anyQuery = false): UrlPatternInput[] {
  if (!anyQuery || !hasQuery(url)) return [{ type: "exact", value: url }];
  const base = withoutQuery(url);
  // Globs need a host (file: has none) and treat "*" as a wildcard: use one regex then.
  if (!/^https?:\/\/[^/]/.test(base) || base.includes("*")) {
    return [{ type: "regex", value: `^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\?[^#]*)?(#.*)?$` }];
  }
  return [
    { type: "exact", value: base },
    { type: "glob", value: `${base}?*` },
  ];
}

/**
 * "Refresh until something appears": refresh this exact page every
 * `seconds` until `text` appears anywhere on it (then highlight it), or
 * disappears after having been there, then stop and notify with a sound.
 * "Disappears" never counts a page that didn't show the text in the first
 * place (a login or error page); the popup checks the text is there first.
 */
export function untilRule(o: {
  url: string;
  site: string;
  seconds: number;
  text: string;
  mode: UntilMode;
  /** See priorityAbove. */
  priority?: number;
  /** Stop watching after this long (null/undefined = no limit). */
  stopAfterSeconds?: number | null;
  /** Match the page whatever comes after "?" (see pagePatterns). */
  anyQuery?: boolean;
}): RuleInput {
  const text = o.text.trim();
  return {
    name: `${o.site}: until ${quote(text)} ${o.mode === "appears" ? "appears" : "disappears"}`.slice(0, 100),
    enabled: true,
    priority: o.priority ?? 0,
    ...(o.stopAfterSeconds ? { limits: { maxDurationSeconds: o.stopAfterSeconds } } : {}),
    target: { type: "url", patterns: pagePatterns(o.url, o.anyQuery), exclusions: [] },
    trigger: { type: "interval", seconds: o.seconds },
    stopWhen:
      o.mode === "appears"
        ? { type: "dom.text", operator: "contains", value: text, caseSensitive: false }
        : { type: "dom.text_lost", value: text, caseSensitive: false },
    actions: {
      onMatched: [
        { type: "stopRefresh" },
        ...(o.mode === "appears" ? [{ type: "highlight", text }] : []),
        { type: "notify", title: o.mode === "appears" ? `Found ${quote(text)}` : `${quote(text)} is gone`, message: o.site, sound: true },
      ],
      onNotMatched: [{ type: "refresh" }],
    },
  } as RuleInput;
}
