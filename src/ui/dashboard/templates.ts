/**
 * Ready-made rules for the Templates page. Each template asks only for its
 * blanks (a page or site, sometimes a text, an interval or working hours),
 * describes the resulting rule in words before anything is saved, and builds
 * a RuleInput. Only features that exist today are used.
 */
import type { RuleInput } from "../../core/types";
import { intervalLabel, pageName, stopAfterLabel, untilRule } from "../popup/describe";

export interface TemplateValues {
  /** Full page address (scope "page") or any page on the site (scope "site"). */
  url: string;
  text: string;
  seconds: number;
  start: string;
  end: string;
  /** Stop watching after this many minutes (null = no limit); "until" templates only. */
  stopAfterMinutes: number | null;
  /** Priority for the new rule (see priorityAbove). */
  priority: number;
  /** Whether new rules wait while you're typing (Settings → Activity protection). */
  protects: boolean;
}

export interface Template {
  id: string;
  title: string;
  description: string;
  /** "You fill in: …" line on the card. */
  fills: string;
  badge?: string;
  /** Shown on the card and in the form: when NOT to use this template. */
  warning?: string;
  /** "page": exactly this address. "site": every page on its host. */
  scope: "page" | "site";
  /** Label and starting value of the text blank; absent = no text blank. */
  text?: { label: string; hint: string; initial: string };
  /** Interval chips; absent = the template has no interval choice. */
  intervals?: number[];
  initialSeconds: number;
  /** Working-hours blank (Monday to Friday). */
  hours?: boolean;
  /** Waits for something on the page: offers "Stop watching after". */
  until?: boolean;
  build(v: TemplateValues): RuleInput;
  describe(v: TemplateValues): string;
}

/** The site's host as shown to people ("www." dropped). */
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
const waits = (v: TemplateValues) => (v.protects ? " It waits while you're typing." : "");
const stopClause = (v: TemplateValues, what: string) =>
  v.stopAfterMinutes ? ` If ${what} after ${stopAfterLabel(v.stopAfterMinutes)}, it stops and tells you.` : "";

/** A "refresh until the text appears/disappears" rule with the template's name, priority and time limit. */
function until(v: TemplateValues, mode: "appears" | "disappears", name: string): RuleInput {
  return {
    ...untilRule({
      url: v.url,
      site: hostOf(v.url),
      seconds: v.seconds,
      text: v.text,
      mode,
      priority: v.priority,
      stopAfterSeconds: v.stopAfterMinutes ? v.stopAfterMinutes * 60 : null,
    }),
    name: `${name}: ${pageName(v.url)}`.slice(0, 100),
  };
}

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
    until: true,
    build: (v) => until(v, "appears", "Back in stock"),
    describe: (v) =>
      `Refresh ${pageLabel(v.url)} every ${intervalLabel(v.seconds)} until ${quote(v.text)} appears, then stop and notify you with a sound.${stopClause(v, "it hasn't appeared")}${waits(v)}`,
  },
  {
    id: "status-changes",
    title: "Tell me when a status changes",
    description:
      "Refreshes a status page, such as a delivery tracker, an application or a support ticket, while it shows something like “Pending”, and notifies you when that changes.",
    fills: "the status page, the text shown while waiting · Every 5 min",
    warning: "Only for pages you just look at. Never use it on payment or checkout pages: refreshing those can send an order twice.",
    scope: "page",
    text: { label: "Keep refreshing while this text is on the page", hint: "When it's gone, refreshing stops and you're notified.", initial: "Pending" },
    intervals: [60, 300, 900, 1800],
    initialSeconds: 300,
    until: true,
    build: (v) => until(v, "disappears", "Status"),
    describe: (v) =>
      `Refresh ${pageLabel(v.url)} every ${intervalLabel(v.seconds)} while ${quote(v.text)} is on the page; when it changes, stop and notify you with a sound.${stopClause(v, "it hasn't changed")}${waits(v)}`,
  },
  {
    id: "work-hours-dashboard",
    title: "Keep a dashboard fresh during work hours",
    description: "Refreshes every 5 to 6 minutes (slightly random), Monday to Friday, during your working hours only.",
    fills: "the dashboard, your working hours",
    scope: "page",
    initialSeconds: 300,
    hours: true,
    build: (v) =>
      ({
        name: `Work hours: ${pageName(v.url)}`.slice(0, 100),
        enabled: true,
        priority: v.priority,
        target: exactPage(v.url),
        trigger: { type: "interval", seconds: 300, randomMaxSeconds: 360 },
        schedule: { days: [1, 2, 3, 4, 5], startTime: v.start, endTime: v.end },
        actions: { onMatched: [], onNotMatched: [{ type: "refresh" }] },
      }) as RuleInput,
    describe: (v) => `Refresh ${pageLabel(v.url)} every 5 to 6 min, Monday to Friday, ${v.start} to ${v.end}.${waits(v)}`,
  },
  {
    id: "build-failed",
    title: "Tell me when a build fails",
    description: "Refreshes a build or deploy page every few minutes until a failure message appears, then stops and alerts you once with a sound.",
    fills: "the build page, its failure message · Every 2 min",
    scope: "page",
    text: {
      label: "Stop and alert me when this text appears",
      hint: "Use the exact words your build page shows when it fails, so it doesn't match things like “0 failed”.",
      initial: "Build failed",
    },
    intervals: [60, 120, 300],
    initialSeconds: 120,
    until: true,
    build: (v) => {
      const r = until(v, "appears", "Build failed");
      return {
        ...r,
        actions: {
          ...r.actions!,
          onMatched: [{ type: "stopRefresh" }, { type: "notify", title: "Build failed", message: pageName(v.url), sound: true }],
        },
      } as RuleInput;
    },
    describe: (v) =>
      `Refresh ${pageLabel(v.url)} every ${intervalLabel(v.seconds)} until ${quote(v.text)} appears, then stop and alert you once with a sound.${stopClause(v, "it hasn't appeared")}${waits(v)}`,
  },
  {
    id: "stay-signed-in",
    title: "Stay signed in",
    description: "Refreshes a site every 10 minutes so it doesn't log you out for being idle.",
    fills: "the site · Every 10 min",
    scope: "site",
    intervals: [300, 600, 900, 1800],
    initialSeconds: 600,
    build: (v) =>
      ({
        name: `Stay signed in: ${new URL(v.url).host}`.slice(0, 100),
        enabled: true,
        priority: v.priority,
        target: { type: "url", patterns: [{ type: "domain", value: new URL(v.url).host }], exclusions: [] },
        trigger: { type: "interval", seconds: v.seconds },
        actions: { onMatched: [], onNotMatched: [{ type: "refresh" }] },
      }) as RuleInput,
    // The exact host: "www.example.com" and "example.com" are different sites to the rule.
    describe: (v) => `Refresh any open ${new URL(v.url).host} page every ${intervalLabel(v.seconds)} so it doesn't log you out.${waits(v)}`,
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
