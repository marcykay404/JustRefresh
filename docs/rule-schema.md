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

## Actions

| type            | Fields                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `refresh`       | `bypassCache?`, `keepScroll?`        | Passes the safety gate first. `keepScroll: true` scrolls back to where the page was after it reloads, while the page fills in, until you scroll yourself                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `stopRefresh`   | `as?` (`completed`/`stopped`)        | Terminal; later non-disruptive actions still run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pauseRefresh`  | `minutes?`                           | Auto-resume after `minutes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `resumeRefresh` | —                                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `notify`        | `title?`, `message?`, `sound?`       | Desktop notification (click focuses the tab); `sound: true` also plays a short chime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `log`           | `message?`, `level?`                 | Writes to history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `click`         | `selector`                           | Clicks the first matching element. Never clicks something that would submit a form (a submit button, an image input, its text or its label), because sending a form again can repeat an order or a payment; the refusal is recorded in History. Waits like a refresh while you type or have unsaved changes. Not allowed on page-load triggers (a click that loads a page would loop). Needs site access                                                                                                                                                                       |
| `webhook`       | `url`, `message?`, `includePageUrl?` | POSTs a JSON message to a program on this computer only (`http(s)://localhost`, `127.0.0.1` or `[::1]`, any port). Off until **Settings → Allow rules to call local webhooks** is on. The body is `{ source: "justrefresh", event, rule: { id, name }, tab: { id, url? }, message?, at }`; the page address only with `includePageUrl: true`. Sent as `text/plain` without credentials, so it needs no site access or CORS setup, and the reply can't be read: History records whether it was delivered, not the program's answer. Runs after a terminal action, like `notify` |

Pick a selector in the Rule Builder with **Pick** next to a selector field: point at an element in the tab chosen under Test (↑ widens to the parent, Esc cancels) and click it. While picking, the page doesn't receive the click.
