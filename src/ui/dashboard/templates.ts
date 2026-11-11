/**
 * Ready-made rules for the Templates page. Each template asks only for its
 * blanks (a page or site, sometimes a text, an interval or working hours),
 * describes the resulting rule in words before anything is saved, and builds
 * a RuleInput. Only features that exist today are used.
 */
import type { RuleInput } from "../../core/types";
import { intervalLabel, untilRule } from "../popup/describe";

export interface TemplateValues {
  /** Full page address (scope "page") or any page on the site (scope "site"). */
  url: string;
  text: string;
  seconds: number;
  start: string;
  end: string;
}

export interface Template {
  id: string;
  title: string;
  description: string;
  /** "You fill in: …" line on the card. */
  fills: string;
  badge?: string;
  /** "page": exactly this address. "site": every page on its host. */
  scope: "page" | "site";
  /** Label and starting value of the text blank; absent = no text blank. */
  text?: { label: string; hint: string; initial: string };
  /** Interval chips; absent = the template has no interval choice. */
  intervals?: number[];
  initialSeconds: number;
  /** Working-hours blank (Monday to Friday). */
  hours?: boolean;
  build(v: TemplateValues): RuleInput;
  describe(v: TemplateValues): string;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** "shop.example.com/item/42" (no scheme, no trailing slash). */
export function pageLabel(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

const exactPage = (url: string) => ({ type: "url" as const, patterns: [{ type: "exact" as const, value: url }], exclusions: [] });
const quote = (s: string) => `“${s.trim()}”`;

export const TEMPLATES: Template[] = [
  {
    id: "back-in-stock",
    title: "Tell me when it's back in stock",
    description: "Refreshes a page until a word or phrase appears, then stops and notifies you with a sound.",
    fills: "the page, the text to look for · Every 1 min",
    badge: "Popular",
    scope: "page",
    text: { label: "Stop when this text appears", hint: "Anywhere on the page, ignoring upper/lower case.", initial: "In stock" },
    intervals: [30, 60, 300, 900],
    initialSeconds: 60,
    build: (v) => ({ ...untilRule({ url: v.url, site: hostOf(v.url), seconds: v.seconds, text: v.text, mode: "appears" }), name: `Back in stock: ${pageLabel(v.url)}`.slice(0, 100) }),
    describe: (v) =>
      `Refresh ${pageLabel(v.url)} every ${intervalLabel(v.seconds)} until ${quote(v.text)} appears, then stop and notify you with a sound. It waits while you're typing.`,
  },
  {
    id: "while-processing",
    title: "Refresh while my order is processing",
    description: "Keeps refreshing while the page says something like “Processing”, and notifies you when that text goes away.",
    fills: "the page, the text shown while waiting · Every 1 min",
    scope: "page",
    text: { label: "Keep refreshing while this text is on the page", hint: "When it's gone, refreshing stops and you're notified.", initial: "Processing" },
    intervals: [30, 60, 300, 900],
    initialSeconds: 60,
    build: (v) => ({ ...untilRule({ url: v.url, site: hostOf(v.url), seconds: v.seconds, text: v.text, mode: "disappears" }), name: `While processing: ${pageLabel(v.url)}`.slice(0, 100) }),
    describe: (v) =>
      `Refresh ${pageLabel(v.url)} every ${intervalLabel(v.seconds)} while ${quote(v.text)} is on the page; when it's gone, stop and notify you with a sound. It waits while you're typing.`,
  },
  {
    id: "work-hours-dashboard",
    title: "Keep a dashboard fresh during work hours",
    description: "Refreshes every 5 to 6 minutes (slightly random), Monday to Friday, during your working hours only.",
    fills: "the dashboard, your working hours",
    scope: "page",
    initialSeconds: 300,
    hours: true,
    build: (v) => ({
      name: `Work hours: ${pageLabel(v.url)}`.slice(0, 100),
      enabled: true,
      target: exactPage(v.url),
      trigger: { type: "interval", seconds: 300, randomMaxSeconds: 360 },
      schedule: { days: [1, 2, 3, 4, 5], startTime: v.start, endTime: v.end },
      actions: { onMatched: [], onNotMatched: [{ type: "refresh" }] },
    }) as RuleInput,
    describe: (v) => `Refresh ${pageLabel(v.url)} every 5 to 6 min, Monday to Friday, ${v.start} to ${v.end}. It waits while you're typing.`,
  },
  {
    id: "build-failed",
    title: "Tell me when a build fails",
    description: "Every time the page loads, notifies you if it shows a failure. It doesn't refresh on its own: pair it with a timer if you like.",
    fills: "the build page, the text that means it failed",
    scope: "page",
    text: { label: "Notify me when this text appears", hint: "Checked each time the page loads, ignoring upper/lower case.", initial: "Failed" },
    initialSeconds: 0,
    build: (v) =>
      ({
        name: `Build failed: ${pageLabel(v.url)}`.slice(0, 100),
        enabled: true,
        target: exactPage(v.url),
        trigger: { type: "navigation" },
        stopWhen: { type: "dom.text", operator: "contains", value: v.text.trim(), caseSensitive: false },
        actions: { onMatched: [{ type: "notify", title: "Build failed", message: pageLabel(v.url), sound: true }], onNotMatched: [] },
      }) as RuleInput,
    describe: (v) => `Each time ${pageLabel(v.url)} loads, notify you with a sound if ${quote(v.text)} appears. It doesn't refresh the page itself.`,
  },
  {
    id: "stay-signed-in",
    title: "Stay signed in",
    description: "Refreshes a site every 10 minutes so it doesn't log you out for being idle. Still waits while you're typing.",
    fills: "the site · Every 10 min",
    scope: "site",
    intervals: [300, 600, 900, 1800],
    initialSeconds: 600,
    build: (v) =>
      ({
        name: `Stay signed in: ${hostOf(v.url)}`.slice(0, 100),
        enabled: true,
        target: { type: "url", patterns: [{ type: "domain", value: new URL(v.url).host }], exclusions: [] },
        trigger: { type: "interval", seconds: v.seconds },
        actions: { onMatched: [], onNotMatched: [{ type: "refresh" }] },
      }) as RuleInput,
    describe: (v) => `Refresh any open ${hostOf(v.url)} page every ${intervalLabel(v.seconds)} so it doesn't log you out. It waits while you're typing.`,
  },
];

/** A usable http(s) address, or null. */
export function normalizeAddress(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/* "Customise in the Rule Builder": hand the filled-in rule to the builder. */
const DRAFT_KEY = "justrefresh:builder-draft";

export function stashBuilderDraft(rule: RuleInput) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(rule));
  } catch {
    /* private mode etc.: the builder then starts from a blank rule */
  }
}

export function takeBuilderDraft(): RuleInput | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as RuleInput) : null;
  } catch {
    return null;
  }
}
