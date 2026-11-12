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

It asks for access to a site only when you turn refreshing on there, and you
can remove it in Settings or in Chrome at any time.

## What leaves your browser

Nothing, unless you switch on one of these yourself:

- **Local webhook:** a rule can send a short message to a program on your own
  computer (`localhost` only).
- **Desktop AI apps:** an optional bridge on your computer lets AI apps you
  approve manage rules. Page addresses given to them have their query strings
  hidden unless you allow otherwise; page text is never given to them.
- **Links you click**, such as "Buy me a coffee" or "Source code", open those
  websites in a new tab, like any link.

## Contact

Questions or problems: https://github.com/marcykay404/JustRefresh/issues
