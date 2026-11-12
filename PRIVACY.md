# JustRefresh privacy policy

JustRefresh is a browser extension that refreshes tabs for you. It has no
account, no servers and no analytics. Nothing is sent to the developer, and
nothing is sent to anyone else unless you switch on one of the options under
[What leaves your browser](#what-leaves-your-browser).

## What it stores, and where

Your rules, settings, which tabs are refreshing, a history of recent refreshes
(which rule ran on which page, and when), and a log of what AI agents asked it
to do are stored in your browser (`chrome.storage`), on your device. The state
of running tabs is kept only until Chrome closes.

- Clear the history on the History page, and the agent log in Agent
  Integrations; reset everything in Dashboard → Settings. Uninstalling the
  extension removes all of it.
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
  computer (`localhost` only): the rule, the tab and what it found, and the
  page's address only if the rule asks for it.
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
  your home folder, readable only by your account.
- **Links you click**, such as "Buy me a coffee" or "Source code", open those
  websites in a new tab, like any link.

## Contact

Questions or problems: https://github.com/marcykay404/JustRefresh/issues
