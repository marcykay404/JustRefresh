# Rule schema (v1)

Authoritative JSON Schema: [`schemas/rule.schema.json`](../schemas/rule.schema.json)
(also returned by the `getCapabilities` API as `ruleSchema`). Runtime
validation is stricter than the JSON Schema: it also checks URL pattern
syntax, regex safety, CSS selector syntax (where a DOM is available),
condition depth (≤ 6) and size (≤ 50 nodes), refresh loops, and
cross-field rules. Unknown fields and unknown types are rejected.

<!-- prettier-ignore -->
```jsonc
{
  "schemaVersion": 1,              // optional on input
  "id": "rule-001",                // optional; generated if absent. [A-Za-z0-9._-]{1,64}
  "name": "Monitor availability",  // required
  "description": "…",              // optional
  "enabled": true,                 // default true (forced false for agent/imported drafts)
  "priority": 100,                 // -1000…1000, default 0; higher wins
  "target": {
    "type": "url",
    "patterns":   ["https://example.com/products/*"],  // ≥1, see url-matching.md
    "exclusions": []                                    // rule-local exclusions
  },
  "trigger": { "type": "interval", "seconds": 30, "randomMaxSeconds": 90 },
  "stopWhen": { /* condition tree, optional */ },
  "actions": {
    "onMatched":    [{ "type": "stopRefresh" }, { "type": "notify" }],   // default when stopWhen set
    "onNotMatched": [{ "type": "refresh" }],                            // default for refreshing triggers
    "onUnknown":    []                                                   // optional
  },
  "safety": {
    "pauseWhileTyping": true,
    "protectUnsavedChanges": true,
    "inactivityGraceSeconds": 60,
    "pauseOnMouse": false,
    "pauseOnScroll": false,
    "onUnknown": "pause",              // pause | skip | refresh | stop
    "maxUnknownRetries": 3,
    "onActivityUnavailable": "pause"   // pause | refresh
  },
  "limits": { "maxRefreshes": 100, "maxDurationSeconds": 3600, "stopAt": "2026-12-01T09:00:00Z" },
  "schedule": { "days": [1,2,3,4,5], "startTime": "09:00", "endTime": "17:00" }
}
```

Omitted `safety` fields take the global defaults **at save time**.
When a monitor ends without its condition matching (`onUnknown: "pause"`
gives up after `maxUnknownRetries`, or `onUnknown: "stop"`), a
"Monitoring stopped" notification is shown (if notifications are enabled),
so an unattended "refresh until" never ends silently.
`limits.maxRefreshes` counts the rule's clicks as well as its refreshes; a
click or refresh that would go over it isn't made, and page changes after the rule's
click, until the page it opened has loaded (within 15 seconds), are that
click's: they stay in the same run, so its counts go on. A page change you
make after that starts a new run, as after the rule's own refresh.
`safety.maxRefreshes` is accepted for compatibility and normalized into
`limits.maxRefreshes`. The API adds a read-only `meta` object
(`createdAt`, `updatedAt`, `revision`, `origin`, `draft`).

## Triggers

| type         | Fields                                                               | Fires on                                  | Can refresh |
| ------------ | -------------------------------------------------------------------- | ----------------------------------------- | ----------- |
| `interval`   | `seconds` (≥30; ≥5 with fast intervals enabled), `randomMaxSeconds?` | chrome.alarms (+ worker timer below 30 s) | yes         |
| `navigation` | —                                                                    | page load completed                       | no (loop)   |
| `urlChange`  | —                                                                    | tab URL changed                           | no (loop)   |
| `startup`    | —                                                                    | extension start                           | yes         |
| `manual`     | —                                                                    | "Run now" only                            | yes         |

## Conditions

All return `matched`, `not_matched` or `unknown` (never silently false).

| type                         | Fields                                                              | Runs in |
| ---------------------------- | ------------------------------------------------------------------- | ------- |
| `dom.exists`                 | `selector`, `minCount?`                                             | page    |
| `dom.missing`                | `selector`                                                          | page    |
| `dom.text`                   | `selector?` (default `body`), `operator`, `value`, `caseSensitive?` | page    |
| `dom.attribute`              | `selector`, `attribute`, `operator`, `value?`                       | page    |
| `dom.changed`                | `selector?` (default `body`)                                        | page    |
| `dom.text_lost`              | `selector?` (default `body`), `value`, `caseSensitive?`             | page    |
| `url.match`                  | `pattern`                                                           | worker  |
| `time.after` / `time.before` | `at` (ISO timestamp or local `HH:MM`)                               | worker  |
| `refreshCount`               | `operator` (`>= > <= < == !=`), `value`                             | worker  |
| `tab.status`                 | `value` (`loading`/`complete`)                                      | worker  |
| `all` / `any`                | `conditions[]` (1–20)                                               | logical |
| `not`                        | `condition`                                                         | logical |

Text operators: `contains`, `not_contains`, `equals`, `not_equals`,
`starts_with`, `ends_with`, `matches` (safe regex). Text is the visible text
of the **first** matching element, whitespace-normalized, case-insensitive
unless `caseSensitive`. If no element matches, text/attribute conditions are
`not_matched`. Attribute operators: `exists`, `missing`, `equals`,
`not_equals`, `contains`, `matches`.

`unknown` happens when: no site access, page still loading, restricted URL,
content script unavailable, timeout (3 s), invalid selector, unsafe regex.
Logic: `all` → any `not_matched` wins, else any `unknown` → `unknown`;
`any` → any `matched` wins, else any `unknown` → `unknown`; `not` keeps `unknown`.

"Refresh **while** X" = `stopWhen: { "type": "not", "condition": X }`.

### Pages with frames

Page conditions read the page and its frames from the same site (with
access) as one page. A selector is looked up in the page first, then in each frame, and the
first place it matches is compared; `dom.exists` / `dom.missing` count
matches in every frame. Text conditions without a selector read every
frame: `contains` and `matches` match when any frame does, `not_contains`
only when none does, and `dom.changed` watches every frame. Other
comparisons without a selector (`equals`, `starts_with`, …) read the page
itself only. While a frame can't be read yet, conditions that depend on it
(`dom.missing`, `not_contains`, `dom.text_lost`, `dom.changed`, or a selector
not found in the page itself) are `unknown` with code `frame_not_ready`, so
`not` can't turn them into a match. A check that is unknown only for that
reason counts as "not this time" (the `onUnknown` policy isn't applied),
up to 3 checks in a row; after that the frame counts as the page not being
readable, and `onUnknown` applies. Typing and unsaved changes in
any frame with access protect the page like its own.

### Conditions that remember the previous check

`dom.changed` and `dom.text_lost` compare the page with what they saw at the
previous check of the same run. A run starts again (forgetting it) when the
rule is edited, another rule takes over the tab, you go to another page, or
a finished run is started again; a refresh by the rule keeps it.

They compare only on the page they remember (its origin and path; what
comes after "?" may differ): a refresh that lands on another page, such as a
login redirect, is neither a change nor "gone", and the page is compared
again when it's back. They don't compare at the check right after the
rule's own refresh, when a page that fills itself in later may not show its
content yet; the next check (before the next refresh) compares. So a change
is reported one interval after the load that brought it.

- **`dom.changed`** matches when the text of the first matching element (or
  the whole page) differs from the previous check, whitespace-normalized. The
  first check only remembers it (`not_matched`). Only a fingerprint of the
  text leaves the page and is kept, never the text itself, and it isn't shown
  by the API. An element that isn't there changes nothing and keeps the
  previous fingerprint, so a page that didn't load fully isn't a change. It
  matches once per change: a rule that keeps running alerts again only on the
  next change. Pick a selector for the part you care about: the whole page
  often holds a clock, a counter or ads.
- **`dom.text_lost`** is "text gone" that only counts text it has seen: it
  matches when `value` was there at an earlier check of the run and isn't
  now (also when the element holding it was removed). A page that never
  showed it (a login page, a typo) never matches. After matching, it must
  see the text again before it can match again. The popup's "Refresh until
  … disappears" uses it, and refuses to start when the text isn't on the page.

## Actions

| type            | Fields                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refresh`       | `bypassCache?`, `keepScroll?`        | Passes the safety gate first. `keepScroll: true` scrolls back to where the page was after it reloads, while the page fills in, until you scroll yourself                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `stopRefresh`   | `as?` (`completed`/`stopped`)        | Terminal; later non-disruptive actions still run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pauseRefresh`  | `minutes?`                           | Auto-resume after `minutes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `resumeRefresh` | —                                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `notify`        | `title?`, `message?`, `sound?`       | Desktop notification (click focuses the tab); `sound: true` also plays a short chime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `log`           | `message?`, `level?`                 | Writes to history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `click`         | `selector`                           | Clicks the first matching element. Never clicks something that would submit or reset a form (a submit or reset button, an image input, a custom element marked `type="submit"`, text inside one, or a label for one), because sending a form again can repeat an order or a payment; any submission a click still sets off is cancelled. A click that doesn't happen is recorded in History and notified. Waits like a refresh while you type or have unsaved changes. Not allowed on page-load triggers (a click that loads a page would loop). Needs site access                     |
| `highlight`     | `selector?`, `text?` (at least one)  | Marks the first element matching `selector`, or the first place `text` appears in it (or on the page), and scrolls to it, so what the rule found is easy to spot. Text is matched ignoring case and extra whitespace, across elements. Uses the CSS Custom Highlight API, so the page's own content isn't changed; a reload removes it. Doesn't scroll while you're typing or have used the page in the last 10 seconds. Runs after a terminal action, like `notify`, and on page-load triggers. The popup's "Refresh until … appears" highlights the text it found. Needs site access |
| `webhook`       | `url`, `message?`, `includePageUrl?` | POSTs a JSON message to a program on this computer only (`http(s)://localhost`, `127.0.0.1` or `[::1]`, any port). Off until **Settings → Allow rules to call local webhooks** is on. The body is `{ source: "justrefresh", event, rule: { id, name }, tab: { id, url? }, message?, at }`; the page address only with `includePageUrl: true`. Sent as `text/plain` without credentials, so it needs no site access or CORS setup, and the reply can't be read: History records whether it was delivered, not the program's answer. Runs after a terminal action, like `notify`         |

Pick a selector in the Rule Builder with **Pick** next to a selector field: point at an element in the tab chosen under Test (↑ widens to the parent, Esc cancels) and click it. While picking, the page (and its frames) doesn't receive the click. A selector that counts position (`:nth-of-type`) is flagged, since it can point at another item when a list changes.
