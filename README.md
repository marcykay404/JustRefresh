# JustRefresh

A Chrome (Manifest V3) extension that refreshes tabs on schedules, URL rules,
user activity and programmable conditions — with a declarative, versioned
rule engine that the popup, a visual rule builder, JSON import and external
AI agents all drive through **one** Rule Management API.

- **Quick controls** — per-tab refresh from the popup: one-tap intervals
  (30 s – 1 h; down to 5 s with the opt-in fast intervals setting) or a
  custom one, countdown, stop, refresh now, never-refresh this tab, and
  **refresh until text appears/disappears** (then stop and notify with a sound).
- **URL rules** — exact / domain / glob / regex patterns, exclusions,
  priorities with deterministic tie-breaking, conflict hints, pattern tester.
- **Conditional refresh** — "refresh until `#status` contains _Available_",
  element exists/missing, attributes, URL, time, refresh count, nested
  AND/OR/NOT with tri-state (`matched` / `not_matched` / `unknown`) logic.
- **Smart protection** — pauses while typing (incl. IME), protects unsaved
  forms, optional mouse/scroll pause, configurable grace period and fail-safe.
  Never records keystrokes or form values.
- **Reliable scheduling** — `chrome.alarms` only, persisted state, startup
  reconciliation, no duplicate/overlapping reloads, no refresh storms.
- **Visual rule builder** — WHEN → ON → UNTIL → THEN, simple/advanced modes,
  live validation, dry-run testing with an evaluation trace, an in-page
  element picker and selector tester, JSON view, import/export.
- **Page actions** — keep the scroll position across a refresh, click an
  element (never one that would submit a form), and an opt-in webhook to a
  program on this computer (localhost only).
- **Agent-programmable** — capability discovery, validation diagnostics with
  JSON paths, dry runs, draft → approval workflow, scoped & revocable agent
  access, audit log, optional local MCP bridge (one-command install, a key
  per approved agent).

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

- **Popup** — tap an interval and Start; Stop or change it while it runs;
  Refresh now. Under **More**: "Refresh until something appears…" (creates a
  rule for this page: exactly this address, or whatever comes after "?"), "Never auto-refresh this tab", and "Make a rule
  for this site…". A tab run by a rule shows the rule in words, with Check now.
- **Dashboard** (popup → Dashboard, or the extension's Options page):
  Tabs · Rules · Templates · Rule Builder · Exclusions · History · Agent Integrations · Settings.
- **Templates** — ready-made rules you fill in (back in stock, a status page
  that changes, a dashboard during work hours, failed builds, stay signed
  in). Each shows the rule in words before it's created, or opens it in the
  Rule Builder to customise.
- **Welcome page** — opens once after install with three short steps; open it
  again from Settings → Help.
- Example rules as JSON: [`examples/`](examples) — import them in Settings.

## Development

```bash
npm test                  # unit + integration tests (vitest), including the complexity and format checks
npm run typecheck
npm run build             # → dist/
npm run test:e2e          # builds, loads dist/ into Chromium via Playwright
npm run gen:schema        # regenerate schemas/*.json after changing handlers
npm run complexity        # cyclomatic + cognitive complexity (max 15 each)
npm run complexity:update # lower the baseline after simplifying a listed function
npm run format            # format everything with Prettier (npm run format:check to only check)
npm run bundle:report     # what the service worker bundle is made of (budget 200 KB)
npm run check             # typecheck + tests + build + bundle budget
```

**Complexity.** Every function in `src/` stays at or below 15 for both
cyclomatic complexity (ESLint `complexity`) and cognitive complexity
(`sonarjs/cognitive-complexity`); see `eslint.config.js`. `npm test` fails
on any function over the limit, and the limits can't be switched off with an
inline comment. `complexity-baseline.json` is a ratchet for exceptions: a
listed function may only get simpler, and `complexity:update` only lowers or
removes entries, never adds one. A test keeps it empty, so every function is
within the limits.

**Formatting.** Prettier (pinned in `package.json`, settings in
`.prettierrc.json`, generated files skipped in `.prettierignore`) formats
every file it understands; `npm test` fails on an unformatted file. The
commit that first formatted the codebase is listed in
`.git-blame-ignore-revs`: run
`git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame`
skips it (GitHub does this on its own).

**Bundle.** The service worker uses `zod/mini` (via `src/core/zod.ts`) and
ships the generated JSON Schemas as package files read on demand, instead of
zod's JSON Schema converter.

## Documentation

- [Architecture](docs/architecture.md) — layers, lifecycle, state machine, precedence, recovery
- [Rule schema](docs/rule-schema.md) — triggers, conditions, actions, safety, limits
- [URL matching](docs/url-matching.md) — exact semantics of every pattern type
- [Agent integration](docs/agent-integration.md) — JSON, extension messaging, MCP, security model
- [MCP bridge](bridge/README.md) — optional local bridge setup
- [Limitations](docs/limitations.md) — Chrome platform constraints

## Extending

Add a condition, trigger or action by implementing the contract in
`src/registries/contracts.ts` and registering it in `src/registries/index.ts`.
Validation, the JSON Schema, capability discovery, the engine and the rule
builder's forms pick it up automatically; the scheduler does not change.

## Project layout

```
src/core/          types, schema/validation, URL patterns, resolver, evaluator, state machine, safety, scheduling
src/core/engine/   the engine in layers: ports, base (locks, sync), cycle (one refresh cycle), fast-site limit
src/registries/    registry + handler contracts
src/conditions/    dom.*, url.match, time.*, refreshCount, tab.status, all/any/not
src/triggers/      interval, navigation, urlChange, startup, manual
src/actions/       refresh, stopRefresh, pauseRefresh, resumeRefresh, notify, log
src/background/    service worker, Chrome adapters, host access, tab restoration
src/content/       activity monitor + DOM evaluation (top frame)
src/api/           Rule Management API (dispatch, permissions), capabilities, JSON Schema (build time)
src/api/methods/   the API's methods by area: rules, tabs, settings, agents
src/integrations/  JSON import/export, external messaging, native bridge client
src/storage/       repositories, migrations
src/ui/            popup, dashboard, rule builder (React)
bridge/            optional MCP ⇄ Native Messaging bridge (Node, no deps)
schemas/           generated JSON Schemas (rule, and each condition/trigger/action)
tests/             unit, integration, e2e
```
