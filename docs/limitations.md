# Known limitations (Chrome platform)

* **Timing is best-effort.** Chrome alarms have a 30-second minimum for packed
  extensions (Chrome 120+), may be delayed under load, and fire late (once)
  after sleep. The extension never assumes a reload happened at an exact time.
* **Service-worker lifetime.** The worker is terminated when idle; all state
  is persisted and alarms wake it. The in-memory per-tab lock exists only
  while the worker is alive; the persisted `pendingReload` guard and
  generation tokens cover restarts.
* **Unsaved changes.** Detection covers native form controls (value vs.
  default value) and marks edited `contenteditable` regions as `unknown`.
  Application-level state (e.g. editors with custom models, unsent chat
  drafts kept in JS) may not be detectable. Forms removed from the DOM or
  submitted are treated as saved.
* **Frames.** Content scripts run in the top frame only. Activity inside
  iframes and DOM inside cross-origin frames are not observed; DOM conditions
  only see the top document.
* **Activity before monitoring.** On pages loaded before site access was
  granted, typing history is unknown; the monitor is conservative while
  focus is in an editable field during the first grace period.
* **Site access.** Without host permission for a page, activity protection
  and DOM conditions report `unknown`/unavailable and the configured fail-safe
  policy applies (default: pause).
* **Restricted pages.** `chrome://`, the Web Store, other extensions' pages,
  `view-source:` etc. cannot be automated. `file://` needs "Allow access to
  file URLs".
* **Tab identity across restarts.** Tab ids change. Per-tab settings are
  re-attached to restored tabs by URL (and tab index when several tabs share
  a URL); ambiguous matches are dropped rather than guessed. URL rules are
  unaffected. Closed tabs are never reopened.
* **Stalled pages.** Some browser calls into a tab can stall indefinitely,
  e.g. `chrome.scripting.executeScript` into a page paused at a DevTools
  breakpoint or a tab driven through `chrome.debugger` by another extension
  (browser-automation tools). Every such call is bounded: a page that does not
  answer counts as "activity unavailable" / `unknown` and the fail-safe policy
  applies; a reload call that does not return is tracked as pending. A cycle
  that still never finishes is re-run by a watchdog alarm.
* **Discarded tabs** (Memory Saver) are skipped by default rather than woken.
* **Regex.** JavaScript has no regex timeout; potentially catastrophic
  patterns are rejected instead, and inputs are length-bounded.
* **Native bridge.** Requires Node.js and a one-time host registration;
  Chrome must be running with the bridge enabled. Chrome exposes
  `connectNative` only to a service worker that *started* with the
  `nativeMessaging` permission, so after granting it the first time the
  extension must restart (the dashboard offers a button).
