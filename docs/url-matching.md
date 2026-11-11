# URL matching semantics

Patterns appear in rule targets (`target.patterns`, `target.exclusions`),
global exclusions, and the `url.match` condition. A pattern is either a
string (type auto-detected) or an object `{ "type": "exact" | "domain" | "glob" | "regex", "value": "…" }`.

## Auto-detection (strings)

| String | Type |
|---|---|
| starts with `regex:`, `exact:`, `glob:`, `domain:` | that type (prefix removed) |
| starts with `^` | regex |
| contains `://` and `*` | glob |
| contains `://` | exact |
| anything else | domain |

## Normalization (all types)

The tab URL is parsed with the WHATWG URL parser before matching:
scheme and host are lowercased, default ports (`:80`, `:443`) are removed,
internationalized hosts become punycode, and paths are percent-normalized.
URLs longer than 8192 characters never match.

**Fragments (`#…`) are ignored** unless the pattern itself contains `#`.

## exact

`https://example.com/dashboard`

* Equal after normalization (scheme, host, port, path **and query** must all match).
* `https://example.com/a` does **not** match `https://example.com/a?x=1`.
* Some sites change the query on every load (`?t=1731…`), and the tab then
  drops out of an exact rule. To match a page whatever its query, use two
  patterns: `https://example.com/a` (exact) and `https://example.com/a?*`
  (glob). The popup's "Refresh until…", the page templates and the Rule
  Builder offer this as "whatever comes after “?”" when the address has a
  query, and the popup says when a tab doesn't run under a rule only because
  of its query.

## domain — `host[:port][/path-glob]`

| Pattern | Matches | Does not match |
|---|---|---|
| `example.com` | `http(s)://example.com/anything` | `https://www.example.com/` |
| `*.example.com` | `example.com` **and** any subdomain (`a.b.example.com`) | `badexample.com` |
| `localhost:3000` | `http://localhost:3000/x` | `http://localhost:4000/` |
| `example.com/reports/*` | `https://example.com/reports/q1?x=1` | `https://example.com/other` |

* Scheme: `http` and `https` only.
* Port: any port unless given; `:*` means any port explicitly.
* Path part (optional) is a glob over `pathname + search` (query included).
* `*` in the host is only allowed as a leading `*.`.

## glob — full URL with `*`

`https://example.com/reports/*`, `*://*.example.com/app/*`

* Structure: `scheme://host[:port]rest`.
* `*` matches **any sequence of characters, including `/`, `?` and `&`** (may be empty).
* `?` is a **literal** question mark (URLs use it for queries), not a single-char wildcard.
* Scheme `*` means `http` or `https`.
* Host follows the domain rules above (`*.example.com` includes the apex).
* `rest` is matched against `pathname + search` (+ `hash` if the pattern contains `#`),
  anchored at both ends. An empty `rest` is `/`.

## regex

`^https://example\.com/orders/.*$` or `regex:example\.com/(a|b)/`

* JavaScript `RegExp` (no flags) tested against the full normalized URL (`href`, fragment included).
* Not anchored automatically — use `^`/`$`.
* Rejected for safety (JavaScript has no regex timeouts): nested quantifiers
  (`(a+)+`, `(.*a){3}`), repeated alternation groups (`(a|aa)+`), backreferences,
  patterns longer than 1000 characters.

## Restricted URLs

Never automated regardless of rules: `chrome://`, `chrome-extension://`,
`edge://`, `about:`, `view-source:`, `data:`, `javascript:`, `devtools://`,
and the Chrome Web Store. `file://` pages can be refreshed, but page
conditions and activity protection require "Allow access to file URLs".

## Precedence

See [architecture.md](architecture.md#rule-resolution). In short:
restricted → global disabled/paused → tab exclusion → URL exclusion →
(safety, at run time) → tab-specific settings → highest-priority rule
(tie-break: older `createdAt`, then lexicographic `id`) → nothing.
