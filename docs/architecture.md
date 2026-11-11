# Architecture

```
 Popup · Dashboard · Rule Builder · JSON import · External extensions · MCP bridge
                                   │  (all clients of one API)
                         Rule Management API  (src/api/rule-api.ts)
             strict params · validation · authorization · audit · approvals
                                   │
                              Rule Engine  (src/core/rule-engine.ts)
      resolver · tri-state evaluator · state machine · safety · scheduling math
           │                    │                              │
     Registries           Scheduler port                 Page port
  conditions/triggers/    chrome.alarms                  content script:
  actions (src/registries)                               DOM evaluation, activity
           │                    │                              │
                 Chrome APIs: tabs · storage · alarms · scripting · notifications
```

## Layers

| Layer | Files | Notes |
|---|---|---|
| Types & schema | `src/core/types.ts`, `src/core/rule-schema.ts`, `schemas/rule.schema.json` | Rule envelope in zod; node types validated by registry handlers. JSON Schema generated from the same source (`npm run gen:schema`), a test keeps it in sync. |
| Registries | `src/registries/*`, `src/conditions/*`, `src/triggers/*`, `src/actions/*` | Adding a capability = implement a handler + register it. The engine, scheduler and UI pick it up (the builder renders forms from the published JSON Schema). |
| Engine | `src/core/rule-engine.ts` | Uses ports (`BrowserPort`, `AlarmPort`, `PagePort`, `ClockPort`, stores) — fully testable without Chrome. |
| API | `src/api/rule-api.ts`, `src/api/permissions.ts` | Single entry point; the UI uses actor `user`, agents use actor `agent`. |
| Background | `src/background/*` | Chrome adapters, event wiring, startup reconciliation, tab restoration. |
| Content | `src/content/*`, `src/conditions/dom-eval.ts` | Dependency-free (≈7 KB). Top frame only. |
| Storage | `src/storage/*` | Config (one atomic key + backup) in `storage.local`; runtime in `storage.session`; bounded history/audit logs. |
| UI | `src/ui/*` | React. No refresh logic lives in components. |

## Data separation

* **Rule definitions & configuration** — `chrome.storage.local["config"]`:
  settings, rules, exclusions, per-tab overrides, agents, approvals.
  Every write replaces the single key (atomic) and saves the previous value
  as `config.backup`. On load: migrate → validate → drop invalid rules →
  fall back to backup if unreadable.
* **Runtime execution state** — `chrome.storage.session["rt:<tabId>"]`:
  survives service-worker termination, cleared on browser restart (tab ids
  change). Contains status, generation, timestamps, counters, pending reload.
* **UI state** — React component state only. The popup and dashboard
  don't poll: they re-fetch when Chrome reports a change they show
  (`storage.onChanged` for `config`, `rt:*`, `history`, `audit` and
  `bridge.status`; `chrome.tabs` and `chrome.permissions` events), coalesced
  over 100 ms, and not while the page is hidden (`src/ui/shared/live.ts`).
  So an open dashboard no longer wakes the service worker every few seconds.

## Evaluation lifecycle (one cycle)

1. Trigger fires (alarm, navigation, URL change, startup, manual).
2. Per-tab lock acquired (one operation per tab at a time).
3. Resolve controller (see below); non-controllers → idle/excluded/paused.
4. Trigger filter, user pause, terminal states, **in-flight reload guard**
   (never overlap; navigation timeout 60 s).
5. Limits (`maxRefreshes`, `maxDurationSeconds`, `stopAt`), active window, discarded tab.
6. `evaluating`: stop condition evaluated. Page leaves are batched into one
   content-script round-trip; logical nodes use Kleene logic.
7. Stale-result check: generation and status must be unchanged.
8. `matched` → `onMatched` actions. `unknown` → `onUnknown` actions then the
   unknown policy (`pause` with bounded retries, `skip`, `refresh`, `stop`).
   `not_matched` → `onNotMatched` actions.
9. The `refresh` action passes the **safety gate** (typing, IME, unsaved
   changes, optional mouse/scroll, fail-safe if detection unavailable), the
   global **throttle** (≥750 ms between reloads), persists `refreshing` +
   `pendingReload` + next alarm **before** calling `tabs.reload`.
10. `tabs.onUpdated(status=complete)` for our reload → count the navigation,
    re-evaluate conditions (completion can happen right after the reload).

## State machine

```
idle → scheduled → evaluating ─┬─ matched → completed
                               ├─ unsafe/unknown → paused_*
                               ├─ failure → error (retry next interval)
                               └─ allowed → refreshing → scheduled
```

`refreshing` can only be entered from `evaluating`; `evaluating` is not
entered while a reload is pending. Generation tokens are bumped when the
controller, its revision, or the page URL (user navigation) changes, or the
user pauses/stops — late async results from an older generation are dropped.

## Rule resolution

Deterministic precedence (first applicable wins):

1. Restricted/inaccessible target → `excluded`
2. Global disabled (`idle`) / paused (`paused_global`)
3. Temporary tab exclusion
4. Matching global URL exclusion
5. Safety restrictions (applied at execution time)
6. Tab-specific configuration (`tab:<id>` controller, synthesized into a rule)
7. Highest `priority` matching enabled, non-draft rule; ties → older
   `meta.createdAt`, then lexicographic `id`
8. Nothing → `idle`

Exactly one controller per tab, so rules never cause duplicate reloads.

## Scheduling & recovery

* Only `chrome.alarms` (`sar:tab:<id>`), no long-lived timers.
* Worker start: if `storage.session` has no boot marker → **browser start**:
  re-associate tab overrides by URL (ambiguous matches dropped), register
  content scripts, reconcile with staggered first runs (≥30 s, +2 s per tab).
  Otherwise → **wake**: reconcile, recreate missing alarms, remove orphans.
* Overdue schedules (sleep/wake) are rescheduled into staggered slots; alarms
  that do fire together are serialized by the throttle → no refresh storm.
* Countdown UIs compute from persisted `nextDueAt`.

## Permissions

`tabs`, `storage`, `alarms`, `notifications`, `scripting`.
Host access is **optional** and requested per site (popup) or globally
(Settings). Content scripts are registered only for granted origins.
`nativeMessaging` is optional and requested only when enabling the bridge.
