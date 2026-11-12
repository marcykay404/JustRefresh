# Known limitations (Chrome platform)

- **Timing is best-effort.** Chrome alarms have a 30-second minimum for packed
  extensions (Chrome 120+), may be delayed under load, and fire late (once)
  after sleep. The extension never assumes a reload happened at an exact time.
- **Fast intervals (under 30 s) are opt-in** (Settings → Advanced, hard floor
  5 s). Below the alarm minimum the scheduler uses a service-worker timer, with
  a 30 s alarm as backstop: if Chrome terminates the worker, the next fast
  refresh can be up to 30 s late, then the timer resumes. A fast tab keeps the
  worker awake while it is scheduled. To limit load on sites, at most one fast
  automatic refresh per site (host) happens every 5 s across all tabs; tabs
  on the same site take turns, the one that has waited longest first.
  Turning the setting off keeps fast rules but runs them every 30 s.
- **Service-worker lifetime.** The worker is terminated when idle; all state
  is persisted and alarms wake it. The in-memory per-tab lock exists only
  while the worker is alive; the persisted `pendingReload` guard and
  generation tokens cover restarts.
- **Unsaved changes.** Detection covers native form controls the user
  actually edited (trusted input/change events) whose value differs from the
  default, and marks edited `contenteditable` regions as `unknown`. Values set
  by the page's own scripts are not the user's work and are ignored. When the
  content script was injected into an already-open page, earlier edits cannot
  be told apart from script-set values, so changed fields are `unknown` until
  the next load.
  Application-level state (e.g. editors with custom models, unsent chat
  drafts kept in JS) may not be detectable. Forms removed from the DOM or
  submitted are treated as saved.
- **Frames.** Conditions read frames from the page's own site only (a
  dashboard on `grafana.example.com` inside `erp.example.com`, not an ad or a
  widget from elsewhere, nor a page of the site that such a frame embeds),
  and only where JustRefresh has access to that site too. "Own site" is
  worked out without a public-suffix list: the last two parts of the
  address, or three under a country's second level (`example.com.sg`), so
  shared hosting domains (`github.io`, `cloudfront.net`, …) count as one
  site. Typing and unsaved changes count in every frame with access. A frame
  that can't be read yet (still loading) leaves conditions that depend on it
  "unknown: a frame couldn't be read yet": the rule neither matches nor
  pauses and tries again; after 3 such checks in a row the rule's "when the
  page can't be checked" setting applies. Empty `about:blank` / `srcdoc`
  frames and lazy frames not scrolled to yet are left out; ones with content
  (rich-text editors) are read. Frames are taken in the order Chrome numbers
  them, not their order on the page, for "the first frame where the selector
  matches". Picker, click, highlight and "keep scroll position" work in the
  top frame only.
- **Activity before monitoring.** On pages loaded before site access was
  granted, typing history is unknown; the monitor is conservative while
  focus is in an editable field during the first grace period.
- **Site access.** Without host permission for a page, activity protection
  and DOM conditions report `unknown`/unavailable and the configured fail-safe
  policy applies (default: pause).
- **Restricted pages.** `chrome://`, the Web Store, other extensions' pages,
  `view-source:` etc. cannot be automated. `file://` needs "Allow access to
  file URLs".
- **Tab identity across restarts.** Tab ids change. Per-tab settings are
  re-attached to restored tabs by URL (and tab index when several tabs share
  a URL); ambiguous matches are dropped rather than guessed. URL rules are
  unaffected. Closed tabs are never reopened.
- **Stalled pages.** Some browser calls into a tab can stall indefinitely,
  e.g. `chrome.scripting.executeScript` into a page paused at a DevTools
  breakpoint or a tab driven through `chrome.debugger` by another extension
  (browser-automation tools). Every such call is bounded: a page that does not
  answer counts as "activity unavailable" / `unknown` and the fail-safe policy
  applies; a reload call that does not return is tracked as pending. A cycle
  that still never finishes is re-run by a watchdog alarm.
- **Toolbar badge shows state, not a live countdown.** A ticking badge would
  need a timer keeping the service worker awake permanently. The badge shows
  each tab's state (ON / II / ✓ / !) and its tooltip the exact next refresh
  time; the popup shows the live countdown.
- **Pages reached by submitting a form** (an order, a payment, a sign-up) are
  never refreshed automatically: in Chrome a reload asks "Confirm Form
  Resubmission", which blocks an unattended tab and, if Continue is pressed,
  sends the form again. The tab pauses with that reason (notified once), with
  no timer running: it resumes by itself when the tab goes to another page
  (a time limit still ends a watch on time). It stays paused if Memory Saver
  unloads and restores the tab. The popup offers **Open this page fresh**,
  which loads the address as a normal visit. Detection runs in the page: a
  form submitted with POST that the page didn't handle with script, followed
  by a page that wasn't redirected (a redirected page was fetched with GET
  and is safe). It uses the
  site's sessionStorage, so a form that posts to a _different_ site isn't
  detected, and it needs site access like activity protection does. Also not
  detected: forms sent from script with `form.submit()` (no submit event, e.g.
  ASP.NET postbacks) and 307/308 redirects (which keep the POST but count as
  a redirect). For those, Chrome still shows its resubmission prompt.
- **Discarded tabs** (Memory Saver) are skipped by default rather than woken.
- **Regex.** JavaScript has no regex timeout; potentially catastrophic
  patterns are rejected instead, and inputs are length-bounded.
- **Click action.** A click is never sent to anything that would submit a
  form (a submit button, an image input, text inside one, or its label). A
  button that sends an order with script (fetch/XHR) instead of a form looks
  like any other button and can't be recognised: choose what a rule clicks
  with care. Any form submission a click still sets off is cancelled, also
  inside open shadow roots; closed shadow roots can't be watched. Clicks run
  in the top frame only.
- **Picked selectors** that count position (`:nth-of-type`) are flagged: on a
  list that gains items they can point at a different item later.
- **Webhooks** are sent as simple `text/plain` requests without credentials,
  so the reply can't be read: History shows whether the program was reached,
  not what it answered. Only `localhost`, `127.0.0.1` and `[::1]` are allowed.
  Such requests can't refuse redirects: a local program that redirects the
  message is passing it on, which it could do anyway once it has it.
- **Keep scroll position** restores the position for up to 10 seconds while
  the page fills in, and stops as soon as you scroll, click or type. Pages
  that rebuild themselves later than that, or keep the scroll inside an inner
  panel rather than the page, may not end up in the same place.
- **Content changed** compares the visible text of one element (or the
  page): a change in an attribute, an image or styling alone isn't a change.
  Whole-page watching changes on every load where the page shows a clock,
  a counter or rotating ads; pick the part you care about. Changes are seen
  at each check, so text that changes and changes back between two checks
  goes unnoticed.
- **Text gone (after being seen)** can't tell a real change from an error
  page at the same address that also lacks the text, once the text has been
  seen; it rules out pages that never showed it and redirects to another
  page (a login page).
- **Page-load triggers** check stateful conditions as each page finishes
  loading, so on a page that fills itself in later they can compare a page
  that isn't complete yet.
- **Highlight** works in the top frame, and only where the CSS Custom
  Highlight API exists (Chrome 105+; elsewhere it only scrolls). Text inside
  hidden elements is skipped, but text hidden by CSS alone may be picked first.
  The page itself can see the highlight (and its style element), so it can
  tell that something marked the text. Its smooth scroll counts as scrolling
  for "Wait while I scroll" on a refresh right after it.
- **Element picker** works in the top frame of the tab chosen under Test,
  and needs site access for it.
- **Native bridge.** Requires Node.js and a one-time host registration;
  Chrome must be running with the bridge enabled. Chrome exposes
  `connectNative` only to a service worker that _started_ with the
  `nativeMessaging` permission, so after granting it the first time the
  extension must restart (the dashboard offers a button).
