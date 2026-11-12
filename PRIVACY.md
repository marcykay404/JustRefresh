# JustRefresh privacy policy

JustRefresh is a browser extension that refreshes tabs for you. It has no
account, no servers and no analytics. Nothing is sent to the developer, and
nothing is sent to anyone else unless you switch on one of the options under
[What leaves your browser](#what-leaves-your-browser).

## What it stores, and where

Your rules, settings, which tabs are refreshing, a history of recent refreshes
(which rule ran on which page, and when), a log of what AI agents asked it to
do, and the last week's events about each agent's own rules are stored in your
browser (`chrome.storage`), on your device. Tabs you set to refresh are
remembered by address and title, so they resume after a restart; the rest of
the state of running tabs is kept only until Chrome closes.

- Clear the history on the History page, and the agent activity log in Agent
  Integrations. **Reset to defaults** in Dashboard → Settings deletes all of
  it: your rules, exclusions, settings, tab timers and paired agents (with no
  backup of them kept), what it remembers about each tab, the history, the
  agent log and agents' events. Removing an agent deletes its events.
  Uninstalling the extension removes all of it too.
- **Export** in Settings saves your rules, exclusions and (if you choose)
  settings as a file in your downloads. That file is yours: uninstalling
  doesn't remove it.
- **Notifications** show the rule's name and, by default, the page's address.
  Your system may keep them in its notification history.
- To protect pages reached by submitting a form, JustRefresh leaves a small
  marker (a time and the page address) in that site's own session storage,
  which the browser clears when the tab closes.

## What it reads

- **Open tabs:** their address and title, to match your rules and show them in
  the popup and dashboard.
- **Pages you allow it on:** whether you're typing or have unsaved form
  changes (never what you typed), and the text or elements your rules look
  for. This is checked on your device. (A "content changed" rule keeps a short
  fingerprint of the part of the page it watches, in your browser, to compare
  with the next load.)

It asks for access to a site when you turn refreshing on there (or for several
selected tabs at once), and for every site only if you press "Allow access to
all sites" in Settings. You can remove access in Settings or in Chrome at any
time.

## What leaves your browser

Nothing, unless you switch on one of these yourself:

- **Local webhook:** a rule can send a short message to a program on your own
  computer (`localhost` only): the rule's name, the tab's number, whether its
  condition was met and your own message, plus the page's address only if the
  rule asks for it.
- **AI apps and extensions you approve:** an optional bridge on your computer
  lets AI apps manage rules, and extensions you add to the allowlist in Agent
  Integrations can too. Depending on what you let each one do, they can see
  the titles and addresses of your open tabs (query strings hidden unless you
  allow them), your rules, and the refresh history (every rule's pages and
  times). They don't get page text, though testing a rule on a tab tells them
  whether the page matches it and which element it found. What an AI app or
  extension does with this is up to it: many AI apps send what they read to
  their own online service.
- If you switch on "Also write each app's events to a file", events about an
  app's own rules are also written to a file in the `.justrefresh` folder in
  your home folder, readable only by your account. These files are yours:
  neither reset nor uninstalling the extension removes them (uninstalling the
  bridge does not either; delete the `events` folder to remove them).
- **Links you click**, such as "Buy me a coffee" or "Source code", open those
  websites in a new tab, like any link.

## Contact

Questions or problems: https://github.com/marcykay404/JustRefresh/issues
