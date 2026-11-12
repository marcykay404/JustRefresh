# Chrome Web Store listing

Everything the Chrome Web Store developer dashboard asks for, kept next to the
code so it changes with it. Update this file whenever a permission, a feature
in the description, or the UI in the screenshots changes.

## Store listing

**Name:** JustRefresh

**Summary** (manifest `description`, 132 characters at most; this is 118):

> Auto refresh tabs on a timer or until something appears, without losing what you type. Free, open source, no tracking.

**Category:** Productivity → Tools (pick the closest match in the dashboard's list).

**Language:** English.

**Description:**

```
Refresh tabs on a timer, or until the thing you're waiting for appears, without ever losing what you're typing.

NEVER LOSE YOUR WORK
• Waits while you're typing, and never refreshes a form you've started filling in.
• Never refreshes a page you reached by submitting a form, so an order or payment is never sent twice.
• Optionally waits while you move the mouse or scroll.

REFRESH IN ONE TAP
• Pick an interval in the popup (30 seconds to an hour, or your own) and press Start.
• See the countdown, pause, stop or refresh now from the same place.

REFRESH UNTIL SOMETHING APPEARS
• "Tell me when tickets are available": say what to look for, and JustRefresh stops refreshing, notifies you with a sound, and highlights it on the page.
• Or when text disappears, or when a part of the page changes.

RULES AND TEMPLATES
• Ready-made templates: back in stock, status changes, failed builds, staying signed in.
• Rules for whole sites: schedules (weekdays, working hours), limits, exclusions, and conditions on what the page shows, also inside embedded dashboards.
• A visual rule builder with a dry run before anything is saved, and JSON import/export.

PRIVATE BY DESIGN
• No account, no servers, no ads, no tracking. Everything stays in your browser.
• Asks for access to a site only when you turn it on there.
• Never records what you type or what's in forms.

FOR AI AGENTS (OPTIONAL)
• AI apps on your computer can set up rules through an optional local bridge (MCP). Nothing an agent does takes effect until you approve it, and you choose what each agent may do.

Free and open source (MIT): https://github.com/marcykay404/JustRefresh
```

**Homepage URL:** https://github.com/marcykay404/JustRefresh
**Support URL:** https://github.com/marcykay404/JustRefresh/issues

## Images

All generated from the real built extension: `npm run build && npm run store:assets`
(the site in the screenshots is fictional, served locally as `lumenhall.example`).

| File                     | Store field                                   | Size                                               |
| ------------------------ | --------------------------------------------- | -------------------------------------------------- |
| `store/icon-128.png`     | Store icon                                    | 128×128 (96×96 artwork, 16 px transparent padding) |
| `store/screenshot-1.jpg` | Screenshot: refresh any tab in one tap        | 1280×800                                           |
| `store/screenshot-2.jpg` | Screenshot: refresh until something appears   | 1280×800                                           |
| `store/screenshot-3.jpg` | Screenshot: never lose what you're typing     | 1280×800                                           |
| `store/screenshot-4.jpg` | Screenshot: start from a template             | 1280×800                                           |
| `store/screenshot-5.jpg` | Screenshot: your AI app proposes, you approve | 1280×800                                           |
| `store/promo-small.png`  | Small promo tile (optional)                   | 440×280, no text                                   |

## Privacy practices

**Single purpose:**

> JustRefresh refreshes browser tabs automatically, on a timer or by rules the user sets, and stops or notifies the user when a page shows what they are waiting for, without refreshing over what they are typing.

**Permission justifications:**

| Permission                                                       | Why it's needed                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs`                                                           | Reads the address and title of open tabs to show them in the popup and dashboard and to decide which rule applies to which tab, and reloads tabs.                                                                                                                                       |
| `storage`                                                        | Keeps the user's rules, settings, run state and a local history in the browser. Nothing leaves the browser.                                                                                                                                                                             |
| `alarms`                                                         | Schedules refreshes so they happen on time even while the background worker is asleep.                                                                                                                                                                                                  |
| `notifications`                                                  | Tells the user when what they were waiting for appears, or when a watch stops.                                                                                                                                                                                                          |
| `scripting`                                                      | Runs JustRefresh's own content script on sites the user allowed, to check whether they are typing or have unsaved form changes before a refresh, and to check the page for the text or element a rule waits for.                                                                        |
| `offscreen`                                                      | Plays the optional alert sound (service workers can't play audio).                                                                                                                                                                                                                      |
| `nativeMessaging` (optional)                                     | Only if the user switches on "Allow desktop AI apps to connect": talks to the optional local bridge on the user's own computer, so AI apps the user approves can set up rules.                                                                                                          |
| Host access: `http://*/*`, `https://*/*`, `file:///*` (optional) | Requested one site at a time, when the user turns on refreshing there, to read activity and page content locally for the checks above. File URLs only if the user also allows them in Chrome.                                                                                           |
| `externally_connectable` (`ids: ["*"]`)                          | Lets another extension the user adds to the allowlist in Agent Integrations, such as an AI agent extension, propose rules. Every caller must also be approved by the user in Agent Integrations, with the permissions the user chooses; extensions that aren't allowlisted are refused. |

**Remote code:** No. All code is packaged with the extension (`script-src 'self'`).

**Data usage:** JustRefresh doesn't collect or transmit user data. In the form, tick none of the data types, and certify:

- it does not sell or transfer user data to third parties, outside the approved use cases;
- it does not use or transfer user data for purposes unrelated to its single purpose;
- it does not use or transfer user data to determine creditworthiness or for lending.

Page content (for conditions) and activity (typing, unsaved forms) are read on the user's device to decide whether to refresh, and never sent anywhere. The optional webhook action sends a short message only to `localhost`, and only when the user switches webhooks on.

**Privacy policy URL:** https://github.com/marcykay404/JustRefresh/blob/main/PRIVACY.md

## Notes for the reviewer

```
No account or login is needed. To try it: open any website, click the JustRefresh icon, choose an interval and press Start (Chrome asks for access to that site). "More → Refresh until something appears" stops and notifies when a word appears on the page. The AI agent features need an optional local program and are off by default.
```

## Before each upload

- Bump `version` in `package.json` (the build copies it into the manifest), then `npm run check`.
- Regenerate the images if the popup or dashboard changed: `npm run build && npm run store:assets`.
- Upload a zip of `dist/` (not the repo).
- Check this file still matches the manifest's permissions.
