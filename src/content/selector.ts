/**
 * A short CSS selector that matches one element and nothing else on its page,
 * for the element picker. Prefers what survives a reload: an id, then
 * test/ARIA/name attributes, then a path of tags and readable classes
 * (generated-looking ids and classes, like `css-1x2y3z`, are skipped).
 */

/** Attributes worth anchoring on, best first. */
const STABLE_ATTRS = ["data-testid", "data-test", "data-qa", "data-cy", "aria-label", "name"];
const MAX_CLASSES = 2;

/** A run of 6+ hex characters with a digit in it (a hash), but not words like "feedback". */
const hasHash = (s: string) => (s.match(/[0-9a-f]{6,}/gi) ?? []).some((run) => /\d/.test(run));

/** Ids and classes from build tools, counters or React's useId (`:r1:`, `«r1»`) change between loads. */
const looksGenerated = (s: string) =>
  s.length > 40 || /\d{3,}/.test(s) || hasHash(s) || /^(css|sc|jsx|emotion|svelte|_)-?[a-z0-9]{4,}$/i.test(s) || /^(:r[0-9a-z]*:|«r[0-9a-z]*»)$/i.test(s);

/** CSS.escape for identifiers (not available in every environment). */
export function cssEscape(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = ch.charCodeAt(0);
    const leadingDigit = /\d/.test(ch) && (i === 0 || (i === 1 && s[0] === "-"));
    if (leadingDigit || code < 0x20 || code === 0x7f) out += `\\${code.toString(16)} `;
    else if (ch === "-" && s.length === 1) out += "\\-";
    else if (/[\w-]/.test(ch) || code >= 0x80) out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

const quote = (v: string) => `"${v.replace(/["\\]/g, "\\$&")}"`;

function matchesOnly(el: Element, selector: string): boolean {
  try {
    const found = el.ownerDocument.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

/** Selectors that name the element directly: #id, then tag[attr="…"]. */
function directSelectors(el: Element): string[] {
  const out: string[] = [];
  const id = el.getAttribute("id");
  if (id && !looksGenerated(id)) out.push(`#${cssEscape(id)}`);
  const tag = el.localName; // SVG keeps its case (foreignObject); HTML is lower case
  for (const attr of STABLE_ATTRS) {
    const v = el.getAttribute(attr);
    if (v && v.length <= 80 && !looksGenerated(v)) out.push(`${tag}[${attr}=${quote(v)}]`);
  }
  return out;
}

/** tag.class.class, plus :nth-of-type when siblings look the same. */
function segment(el: Element): string {
  const classes = [...el.classList]
    .filter((c) => !looksGenerated(c))
    .slice(0, MAX_CLASSES)
    .map((c) => `.${cssEscape(c)}`)
    .join("");
  const base = el.localName + classes;
  const parent = el.parentElement;
  if (!parent) return base;
  const alike = [...parent.children].filter((s) => s.tagName === el.tagName && safeMatches(s, base));
  if (alike.length < 2) return base;
  const sameTag = [...parent.children].filter((s) => s.tagName === el.tagName);
  return `${base}:nth-of-type(${sameTag.indexOf(el) + 1})`;
}

function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/** The shortest unique selector found, walking up from the element. */
export function selectorFor(el: Element): string {
  const direct = directSelectors(el).find((s) => matchesOnly(el, s));
  if (direct) return direct;
  const path: string[] = [];
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    path.unshift(segment(cur));
    const candidate = path.join(" > ");
    if (matchesOnly(el, candidate)) return candidate;
    const anchor = cur.parentElement && directSelectors(cur.parentElement).find((s) => matchesOnly(cur!.parentElement!, s));
    if (anchor && matchesOnly(el, `${anchor} > ${candidate}`)) return `${anchor} > ${candidate}`;
  }
  return path.join(" > ");
}
