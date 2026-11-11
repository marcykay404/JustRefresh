# JustRefresh

A Chrome (Manifest V3) extension that refreshes tabs on schedules, URL rules,
user activity and programmable conditions — with a declarative, versioned
rule engine that the popup, a visual rule builder, JSON import and external
AI agents all drive through **one** Rule Management API.

* **Quick controls** — per-tab refresh from the popup: one-tap intervals
  (30 s – 1 h; down to 5 s with the opt-in fast intervals setting) or a
  custom one, countdown, stop, refresh now, never-refresh this tab, and
  **refresh until text appears/disappears** (then stop and notify with a sound).
* **URL rules** — exact / domain / glob / regex patterns, exclusions,
  priorities with deterministic tie-breaking, conflict hints, pattern tester.
* **Conditional refresh** — "refresh until `#status` contains *Available*",
  element exists/missing, attributes, URL, time, refresh count, nested
  AND/OR/NOT with tri-state (`matched` / `not_matched` / `unknown`) logic.
* **Smart protection** — pauses while typing (incl. IME), protects unsaved
  forms, optional mouse/scroll pause, configurable grace period and fail-safe.
  Never records keystrokes or form values.
* **Reliable scheduling** — `chrome.alarms` only, persisted state, startup
  reconciliation, no duplicate/overlapping reloads, no refresh storms.
* **Visual rule builder** — WHEN → ON → UNTIL → THEN, simple/advanced modes,
  live validation, dry-run testing with an evaluation trace, selector tester,
  JSON view, import/export.
* **Agent-programmable** — capability discovery, validation diagnostics with
  JSON paths, dry runs, draft → approval workflow, scoped & revocable agent
  access, audit log, optional local MCP bridge.

Local-first: no account, no backend, no telemetry.

## Install (unpacked)

```bash
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, **Load unpacked**
and select `dist/`. Requires Chrome 120+.

The extension starts with no website access. Enabling refresh on a tab asks
for access to that site (needed for activity protection and page
conditions); you can also grant all sites in Dashboard → Settings.

## Using it

* **Popup** — tap an interval and Start; Stop or change it while it runs;
  Refresh now. Under **More**: "Refresh until something appears…" (creates a
  rule for this exact page), "Never auto-refresh this tab", and "Make a rule
  for this site…". A tab run by a rule shows the rule in words, with Check now.
* **Dashboard** (popup → Dashboard, or the extension's Options page):
  Tabs · Rules · Templates · Rule Builder · Exclusions · History · Agent Integrations · Settings.
* **Templates** — ready-made rules you fill in (back in stock, a status page
  that changes, a dashboard during work hours, failed builds, stay signed
  in). Each shows the rule in words before it's created, or opens it in the
  Rule Builder to customise.
* **Welcome page** — opens once after install with three short steps; open it
  again from Settings → Help.
* Example rules as JSON: [`examples/`](examples) — import them in Settings.

## Development

```bash
npm test            # unit + integration tests (vitest)
npm run typecheck
npm run build       # → dist/
npm run test:e2e    # builds, loads dist/ into Chromium via Playwright
npm run gen:schema  # regenerate schemas/rule.schema.json after changing handlers
npm run check       # typecheck + tests + build
```

## Documentation

* [Architecture](docs/architecture.md) — layers, lifecycle, state machine, precedence, recovery
* [Rule schema](docs/rule-schema.md) — triggers, conditions, actions, safety, limits
* [URL matching](docs/url-matching.md) — exact semantics of every pattern type
* [Agent integration](docs/agent-integration.md) — JSON, extension messaging, MCP, security model
* [MCP bridge](bridge/README.md) — optional local bridge setup
* [Limitations](docs/limitations.md) — Chrome platform constraints

## Extending

Add a condition, trigger or action by implementing the contract in
`src/registries/contracts.ts` and registering it in `src/registries/index.ts`.
Validation, the JSON Schema, capability discovery, the engine and the rule
builder's forms pick it up automatically; the scheduler does not change.

## Project layout

```
src/core/          types, schema/validation, URL patterns, resolver, evaluator, engine, state machine, safety, scheduling
src/registries/    registry + handler contracts
src/conditions/    dom.*, url.match, time.*, refreshCount, tab.status, all/any/not
src/triggers/      interval, navigation, urlChange, startup, manual
src/actions/       refresh, stopRefresh, pauseRefresh, resumeRefresh, notify, log
src/background/    service worker, Chrome adapters, host access, tab restoration
src/content/       activity monitor + DOM evaluation (top frame)
src/api/           Rule Management API, authorization, capabilities, JSON Schema
src/integrations/  JSON import/export, external messaging, native bridge client
src/storage/       repositories, migrations
src/ui/            popup, dashboard, rule builder (React)
bridge/            optional MCP ⇄ Native Messaging bridge (Node, no deps)
schemas/           generated JSON Schema
tests/             unit, integration, e2e
```
