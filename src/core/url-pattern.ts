/**
 * URL pattern parsing and matching.
 *
 * See docs/url-matching.md for the precise semantics. Summary:
 *
 *  - Strings are auto-detected:
 *      "regex:..." or starting with "^"      → regex
 *      "exact:..." / "glob:..." / "domain:..." → explicit type
 *      contains "://" and "*"                → glob   (full URL)
 *      contains "://"                        → exact  (full URL)
 *      otherwise                             → domain (host[:port][/path-glob])
 *  - URLs are normalized with the WHATWG URL parser first (lowercased scheme
 *    and host, default port removed, IDN → punycode).
 *  - The fragment (#…) is ignored unless the pattern itself contains "#".
 */

import type { PatternType, UrlPatternInput } from "./types";

export const MAX_PATTERN_LENGTH = 1000;
export const MAX_URL_LENGTH = 8192;

export interface CompiledPattern {
  type: PatternType;
  source: string;
  test(url: string): boolean;
}

export class PatternError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

export function detectPattern(input: UrlPatternInput): { type: PatternType; value: string } {
  if (typeof input !== "string") return { type: input.type, value: input.value };
  const s = input.trim();
  const prefixed = /^(regex|exact|glob|domain):/i.exec(s);
  if (prefixed) return { type: prefixed[1].toLowerCase() as PatternType, value: s.slice(prefixed[0].length) };
  if (s.startsWith("^")) return { type: "regex", value: s };
  if (s.includes("://")) return { type: s.includes("*") ? "glob" : "exact", value: s };
  return { type: "domain", value: s };
}

/* ------------------------------------------------------------------ */
/* Safe regex                                                          */
/* ------------------------------------------------------------------ */

/**
 * Conservative check against catastrophic backtracking. JavaScript offers no
 * regex timeout, so we reject constructs that commonly cause exponential
 * behaviour: nested quantifiers ("star height" > 1), quantified groups with
 * alternation, and backreferences. URL inputs are additionally length-bounded.
 */
export function checkRegexSafety(source: string): string | null {
  if (source.length > MAX_PATTERN_LENGTH) return "Regular expression is too long";
  if (/\\[1-9]/.test(source) || /\\k</.test(source)) return "Backreferences are not allowed";
  const problem = findBacktrackingRisk(source);
  if (problem) return problem;
  try {
    new RegExp(source);
  } catch (e) {
    return `Invalid regular expression: ${(e as Error).message}`;
  }
  return null;
}

/** A group being scanned: whether it contains a quantifier or an alternation. */
interface Group {
  hasQuant: boolean;
  hasAlt: boolean;
}

/** Walk the pattern tracking groups that contain quantifiers / alternation. */
function findBacktrackingRisk(source: string): string | null {
  const stack: Group[] = [{ hasQuant: false, hasAlt: false }];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
    } else if (inClass) {
      inClass = c !== "]";
    } else if (c === "[") {
      inClass = true;
    } else {
      const problem = scanChar(stack, source, i);
      if (problem) return problem;
    }
  }
  return stack.length === 1 ? null : "Unbalanced parentheses";
}

function scanChar(stack: Group[], source: string, i: number): string | null {
  const c = source[i];
  const top = stack[stack.length - 1];
  if (c === "(") stack.push({ hasQuant: false, hasAlt: false });
  else if (c === "|") top.hasAlt = true;
  else if (c === ")") return closeGroup(stack, source, i);
  else if (c === "*" || c === "+" || c === "{") top.hasQuant = true;
  return null;
}

/** A group closes: a repeated group may not contain a quantifier or an alternation. */
function closeGroup(stack: Group[], source: string, i: number): string | null {
  const group = stack.pop();
  if (!group || stack.length === 0) return "Unbalanced parentheses";
  const next = source[i + 1];
  const quantified = next === "*" || next === "+" || next === "{" || next === "?";
  const repeating = next === "*" || next === "+" || (next === "{" && !/^\{1\}/.test(source.slice(i + 1)));
  if (repeating && group.hasQuant) return "Nested quantifiers are not allowed (risk of catastrophic backtracking)";
  if (repeating && group.hasAlt) return "Repeated alternation groups are not allowed (risk of catastrophic backtracking)";
  if (group.hasQuant || quantified) stack[stack.length - 1].hasQuant = true;
  return null;
}

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

export function normalizeUrl(url: string): URL | null {
  if (url.length > MAX_URL_LENGTH) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function withoutFragment(u: URL): string {
  const copy = new URL(u.href);
  copy.hash = "";
  return copy.href;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `*` → any run of characters (may be empty). Everything else is literal. */
function globToRegex(glob: string): RegExp {
  const body = glob
    .split(/\*+/)
    .map(escapeRegex)
    .join(".*");
  return new RegExp(`^${body}$`, "s");
}

/* ------------------------------------------------------------------ */
/* Compilation                                                         */
/* ------------------------------------------------------------------ */

const compileCache = new Map<string, CompiledPattern>();

export function compilePattern(input: UrlPatternInput): CompiledPattern {
  const { type, value } = detectPattern(input);
  const key = `${type}\u0000${value}`;
  const cached = compileCache.get(key);
  if (cached) return cached;
  const compiled = compileUncached(type, value);
  if (compileCache.size > 500) compileCache.clear();
  compileCache.set(key, compiled);
  return compiled;
}

function compileUncached(type: PatternType, value: string): CompiledPattern {
  if (!value) throw new PatternError("Pattern is empty", "pattern_empty");
  if (value.length > MAX_PATTERN_LENGTH) throw new PatternError("Pattern is too long", "pattern_too_long");
  const compilers: Record<PatternType, (v: string) => (url: string) => boolean> = { regex: compileRegex, exact: compileExact, glob: compileGlob, domain: compileDomain };
  if (!Object.hasOwn(compilers, type)) throw new PatternError(`Unknown pattern type "${type}"`, "pattern_invalid");
  return { type, source: value, test: compilers[type](value) };
}

function compileRegex(value: string): (url: string) => boolean {
  const problem = checkRegexSafety(value);
  if (problem) throw new PatternError(problem, "regex_unsafe");
  const re = new RegExp(value);
  return (url) => url.length <= MAX_URL_LENGTH && re.test(url);
}

function compileExact(value: string): (url: string) => boolean {
  const target = normalizeUrl(value);
  if (!target) throw new PatternError(`"${value}" is not a valid URL`, "url_invalid");
  const keepHash = value.includes("#");
  const expected = keepHash ? target.href : withoutFragment(target);
  return (url) => {
    const u = normalizeUrl(url);
    return !!u && (keepHash ? u.href : withoutFragment(u)) === expected;
  };
}

function compileGlob(value: string): (url: string) => boolean {
  const m = /^([a-z*][a-z0-9+.\-*]*):\/\/([^/?#]*)(.*)$/i.exec(value);
  if (!m) throw new PatternError(`"${value}" is not a valid URL glob`, "glob_invalid");
  const [, scheme, hostPort, rest] = m;
  const schemeRe = scheme === "*" ? /^https?$/ : globToRegex(scheme.toLowerCase());
  const hostMatcher = compileHost(hostPort);
  const restRaw = rest === "" ? "/" : rest;
  const keepHash = restRaw.includes("#");
  const restRe = globToRegex(restRaw);
  return (url) => {
    const u = normalizeUrl(url);
    if (!u || !schemeRe.test(u.protocol.slice(0, -1)) || !hostMatcher(u)) return false;
    return restRe.test(u.pathname + u.search + (keepHash ? u.hash : ""));
  };
}

function compileDomain(value: string): (url: string) => boolean {
  const m = /^([^/?#]+)(.*)$/.exec(value);
  if (!m) throw new PatternError(`"${value}" is not a valid domain pattern`, "domain_invalid");
  const [, hostPort, rest] = m;
  const hostMatcher = compileHost(hostPort);
  const keepHash = rest.includes("#");
  const restRe = rest ? globToRegex(rest) : null;
  return (url) => {
    const u = normalizeUrl(url);
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || !hostMatcher(u)) return false;
    return !restRe || restRe.test(u.pathname + u.search + (keepHash ? u.hash : ""));
  };
}

/**
 * Host matching:
 *  - "example.com"    → exactly example.com
 *  - "*.example.com"  → example.com and any subdomain
 *  - "*"              → any host
 *  - optional ":port" → port must match (default ports normalize to "")
 */
function compileHost(hostPort: string): (u: URL) => boolean {
  const pm = /^(.*?)(?::(\d+|\*))?$/.exec(hostPort);
  if (!pm || !pm[1]) throw new PatternError(`Invalid host "${hostPort}"`, "host_invalid");
  const rawHost = pm[1].toLowerCase();
  const port = pm[2];
  let hostTest: (h: string) => boolean;
  if (rawHost === "*") {
    hostTest = () => true;
  } else if (rawHost.startsWith("*.")) {
    const base = toAsciiHost(rawHost.slice(2));
    if (base.includes("*")) throw new PatternError(`Wildcards are only allowed as a leading "*." in hosts`, "host_invalid");
    hostTest = (h) => h === base || h.endsWith(`.${base}`);
  } else {
    if (rawHost.includes("*")) throw new PatternError(`Wildcards are only allowed as a leading "*." in hosts`, "host_invalid");
    const base = toAsciiHost(rawHost);
    hostTest = (h) => h === base;
  }
  return (u) => {
    if (!hostTest(u.hostname)) return false;
    if (port === undefined || port === "*") return true;
    const actual = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
    return actual === port;
  };
}

function toAsciiHost(host: string): string {
  try {
    return new URL(`http://${host}/`).hostname;
  } catch {
    throw new PatternError(`Invalid host "${host}"`, "host_invalid");
  }
}

export function validatePattern(input: UrlPatternInput): string | null {
  try {
    compilePattern(input);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export function matchesAny(patterns: UrlPatternInput[], url: string): UrlPatternInput | null {
  for (const p of patterns) {
    try {
      if (compilePattern(p).test(url)) return p;
    } catch {
      /* invalid patterns never match */
    }
  }
  return null;
}

export function patternToString(p: UrlPatternInput): string {
  return typeof p === "string" ? p : `${p.type}:${p.value}`;
}

/* ------------------------------------------------------------------ */
/* Restricted URLs                                                     */
/* ------------------------------------------------------------------ */

const RESTRICTED_HOSTS = new Set(["chrome.google.com", "chromewebstore.google.com"]);

/** Pages extensions cannot (or must not) automate. */
export function restrictedReason(url: string | undefined): string | null {
  if (!url) return "Tab URL is not accessible";
  const u = normalizeUrl(url);
  if (!u) return "Invalid URL";
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "file:") {
    return `Browser-internal page (${u.protocol}) cannot be automated`;
  }
  if (RESTRICTED_HOSTS.has(u.hostname) && (u.hostname !== "chrome.google.com" || u.pathname.startsWith("/webstore"))) {
    return "The Chrome Web Store cannot be automated";
  }
  return null;
}
