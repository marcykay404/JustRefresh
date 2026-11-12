# JustRefresh privacy policy

JustRefresh is a browser extension that refreshes tabs for you. It has no
account, no servers and no analytics.

## What it stores, and where

Your rules, settings, which tabs are refreshing, a history of recent refreshes,
and a log of what AI agents asked it to do are stored in your browser
(`chrome.storage`), on your device. Nothing is sent to the developer or anyone
else. You can export it or reset everything in Dashboard → Settings, clear the
history on the History page, and uninstalling the extension removes it all.

## What it reads

- **Open tabs:** their address and title, to match your rules and show them in
  the popup and dashboard.
- **Pages you allow it on:** whether you're typing or have unsaved form
  changes (never what you typed), and the text or elements your rules look
  for. This is checked on your device and never sent anywhere. (A "content
  changed" rule keeps a short fingerprint of the part of the page it watches,
  in your browser, to compare with the next load.)

It asks for access to a site when you turn refreshing on there (or for several
selected tabs at once), and for every site only if you press "Allow access to
all sites" in Settings. You can remove access in Settings or in Chrome at any
time.

## What leaves your browser

Nothing, unless you switch on one of these yourself:

- **Local webhook:** a rule can send a short message to a program on your own
  computer (`localhost` only).
- **AI apps and extensions you approve:** an optional bridge on your computer
  lets AI apps manage rules, and extensions you add to the allowlist in Agent
  Integrations can too. Depending on what you let each one do, they can see
  the titles and addresses of your open tabs (query strings hidden unless you
  allow them), your rules, and their history; never page content. If you
  switch on "Also write each app's events to a file", events about an app's
  own rules are also written to a file in the `.justrefresh` folder in your
  home folder, readable only by your account.
- **Links you click**, such as "Buy me a coffee" or "Source code", open those
  websites in a new tab, like any link.

## Contact

Questions or problems: https://github.com/marcykay404/JustRefresh/issues
