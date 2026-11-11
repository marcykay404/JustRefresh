# Known limitations (Chrome platform)

* **Timing is best-effort.** Chrome alarms have a 30-second minimum for packed
  extensions (Chrome 120+), may be delayed under load, and fire late (once)
  after sleep. The extension never assumes a reload happened at an exact time.
* **Fast intervals (under 30 s) are opt-in** (Settings → Advanced, hard floor
  5 s). Below the alarm minimum the scheduler uses a service-worker timer, with
  a 30 s alarm as backstop: if Chrome terminates the worker, the next fast
  refresh can be up to 30 s late, then the timer resumes. A fast tab keeps the
  worker awake while it is scheduled. To limit load on sites, at most one fast
  automatic refresh per site (host) happens every 5 s across all tabs.
  Turning the setting off keeps fast rules but runs them every 30 s.
* **Service-worker lifetime.** The worker is terminated when idle; all state
  is persisted and alarms wake it. The in-memory per-tab lock exists only
  while the worker is alive; the persisted `pendingReload` guard and
  generation tokens cover restarts.
* **Unsaved changes.** Detection covers native form controls the user
  actually edited (trusted input/change events) whose value differs from the
  default, and marks edited `contenteditable` regions as `unknown`. Values set
  by the page's own scripts are not the user's work and are ignored. When the
  content script was injected into an already-open page, earlier edits cannot
  be told apart from script-set values, so changed fields are `unknown` until
  the next load.
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
* **Toolbar badge shows state, not a live countdown.** A ticking badge would
  need a timer keeping the service worker awake permanently. The badge shows
  each tab's state (ON / II / ✓ / !) and its tooltip the exact next refresh
  time; the popup shows the live countdown.
* **Pages reached by submitting a form** (an order, a payment, a sign-up) are
  never refreshed automatically: in Chrome a reload asks "Confirm Form
  Resubmission", which blocks an unattended tab and, if Continue is pressed,
  sends the form again. The tab pauses with that reason (notified once), with
  no timer running: it resumes by itself when the tab goes to another page
  (a time limit still ends a watch on time). The popup offers **Open this
  page fresh**, which loads the address as a normal visit. Detection runs in the page: a form submitted with POST that
  the page didn't handle with script, followed by a page that wasn't
  redirected (a redirected page was fetched with GET and is safe). It uses the
  site's sessionStorage, so a form that posts to a *different* site isn't
  detected, and it needs site access like activity protection does. Also not
  detected: forms sent from script with `form.submit()` (no submit event, e.g.
  ASP.NET postbacks) and 307/308 redirects (which keep the POST but count as
  a redirect). For those, Chrome still shows its resubmission prompt.
* **Discarded tabs** (Memory Saver) are skipped by default rather than woken.
* **Regex.** JavaScript has no regex timeout; potentially catastrophic
  patterns are rejected instead, and inputs are length-bounded.
* **Native bridge.** Requires Node.js and a one-time host registration;
  Chrome must be running with the bridge enabled. Chrome exposes
  `connectNative` only to a service worker that *started* with the
  `nativeMessaging` permission, so after granting it the first time the
  extension must restart (the dashboard offers a button).
