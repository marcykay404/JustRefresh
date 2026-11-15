# Microsoft Edge Add-ons listing

What Partner Center asks for, for the same extension on the
[Microsoft Edge Add-ons](https://microsoftedge.microsoft.com) website. Most
answers are the same as for the Chrome Web Store; this file says where Edge
differs and points to [CHROMEWEBSTORE.md](CHROMEWEBSTORE.md) for the rest.
Keep the two in step.

## Account

Register at [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/public/login)
with a Microsoft account (a GitHub sign-in creates one). There's no fee.
Choose **Individual**: it's verified sooner, and neither the account type nor
the country can be changed later. The **publisher display name** (at most 50
characters) is shown on the listing. Use the same name as on the Chrome Web
Store; the name must be free on Edge, so have a second choice ready.

## Package

The same zip as the Chrome Web Store for that version (`dist/`, attached to
the GitHub release). Edge reads the name and short description from the
manifest, so they can't be edited in Partner Center.

## Availability

- **Visibility:** Public.
- **Markets:** all markets (the default).

## Properties

- **Category:** Productivity.
- **Website:** https://github.com/marcykay404/JustRefresh
- **Support contact detail:** https://github.com/marcykay404/JustRefresh/issues
- **Mature content:** no.

## Privacy

The same questions as the Chrome Web Store, so the same answers. Copy them from
[CHROMEWEBSTORE.md → Privacy practices](CHROMEWEBSTORE.md#privacy-practices):

- **Single purpose:** the same text.
- **Permission justification:** the same text for each permission (Edge lists
  them from the manifest), except the host access row: end it with "File URLs
  only if the user also allows them in the browser." instead of "in Chrome".
- **Remote code:** No, I am not using remote code.
- **Data usage:** tick **Web history**, for the same reason as on Chrome, and
  the certifications. Microsoft's docs only show this form as a picture, so
  check that its options match Chrome's; if they don't, ask before choosing.
- **Privacy policy URL:** https://github.com/marcykay404/JustRefresh/blob/main/PRIVACY.md
  (on `main`, so the browser-neutral wording must be merged before submitting).

## Store listing (English)

**Description** (250 to 10,000 characters). This is the Chrome Web Store text
with "Chrome" taken out:

```
Refresh tabs on a timer, or until the thing you're waiting for appears, without refreshing over what you're typing.

PROTECTS WHAT YOU'RE TYPING
• Waits while you're typing, and won't refresh a form you've started filling in (you can switch this off).
• Won't refresh a page you reached by submitting a form, so the browser doesn't send it again (on sites you've given it access to).
• Optionally waits while you move the mouse or scroll.

REFRESH IN ONE TAP
• Pick an interval in the popup (30 seconds to an hour, or your own) and press Start.
• See the countdown, pause, stop or refresh now from the same place.

REFRESH UNTIL SOMETHING APPEARS
• "Tell me when tickets are available": say what to look for, and JustRefresh stops refreshing, notifies you with a sound, and highlights it on the page.
• Or when text disappears, or when a part of the page changes.

RULES AND TEMPLATES
• Ready-made templates: back in stock, status changes, a dashboard during work hours, failed builds, staying signed in.
• Rules for whole sites: schedules (weekdays, working hours), limits, exclusions, and conditions on what the page shows, also inside embedded dashboards.
• A visual rule builder with a dry run you can do before saving, and JSON import/export.

PRIVATE BY DESIGN
• No account, no servers, no ads, no tracking. Everything stays in your browser, unless you switch on local webhooks, AI apps or allow an extension.
• Asks for access to a site only when you click to allow it (for example by turning refreshing on there), and to all sites only with "Allow access to all sites".
• Never records what you type or what's in forms.

FOR AI AGENTS (OPTIONAL)
• AI apps on your computer can set up rules through an optional local bridge (MCP). Rules an agent creates stay off until you approve them, unless you choose to trust that agent, and you choose what each agent may see and do.

Free and open source (MIT): https://github.com/marcykay404/JustRefresh
```

Don't use **Generate with AI** for this: it sends the package to Microsoft's AI
service, and the text above is already checked against what the extension does.

**Search terms** (at most 7, 30 characters each and 21 words in all; not shown
to users): `auto refresh`, `auto reload`, `tab reloader`, `reload timer`,
`page monitor`, `refresh until text`, `back in stock`.

**Images:**

| File                                          | Field                     | Size                                       |
| --------------------------------------------- | ------------------------- | ------------------------------------------ |
| `store/edge-logo-300.png`                     | Extension logo (required) | 300×300 (`node scripts/make-icons.mjs`)    |
| `store/screenshot-1.jpg` … `screenshot-5.jpg` | Screenshots (at most 6)   | 1280×800, the same as the Chrome Web Store |
| `store/promo-small.png`                       | Small promotional tile    | 440×280                                    |

There's no large promotional tile (1400×560, optional) or YouTube video.
Edge would show both, but neither is needed.

## Notes for certification

```
No account or login is needed. To try it: open any website, click the JustRefresh icon (pin it from the Extensions menu if it's hidden), choose an interval and press Start (Edge asks for access to that site). "More → Refresh until something appears" stops and notifies when a word appears on the page. The AI agent features need an optional local program and are off by default.
```

For an update, add a line about what changed.

## Differences from the Chrome Web Store copy

- **Another extension ID.** Edge gives the extension its own ID, shown at the
  end of the listing's address once it's published. The dashboard only offers
  `npx -y justrefresh@<version> install` to the Chrome Web Store copy, so on
  Edge it offers the bridge as a download instead (that works the same way).
  Once the Edge ID is known, Edge can get the `npx` command too. That takes
  more than adding the ID to the dashboard: the installer defaults to the
  Chrome Web Store ID, so either the command shown on Edge adds
  `--extension-id <edge id>`, or the installer registers both store IDs.
- **"Chrome" in the extension's own text.** Some messages say "Chrome" (for
  example "Chrome asks you once per site", or "open chrome://extensions" in
  Agent Integrations, which Edge opens as edge://extensions). On Edge they mean
  Edge. The setup text copied for an AI app also calls JustRefresh "a Chrome
  extension"; the installer still registers it with Edge.
- **Edge Add-ons pages** (`microsoftedge.microsoft.com`): Edge doesn't let
  extensions read them, so conditions and typing protection can't work there,
  though a plain timer may still refresh them. JustRefresh doesn't know this
  site yet (it only knows the Chrome Web Store's), and on Edge it still refuses
  Chrome Web Store pages, which Edge doesn't block.
- **Review** can take up to seven business days. The status changes to
  **In the Store** when it's published.

## Before each upload

Upload the same version as the Chrome Web Store, after it's on npm (see
[CHROMEWEBSTORE.md → Before each upload](CHROMEWEBSTORE.md#before-each-upload)).
For an update, open the extension in Partner Center → **Packages** → upload
the new zip → **Publish**.
