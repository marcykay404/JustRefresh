# Agent integration

Agents use the **same Rule Management API** as the extension UI. Three levels:

## Level 1 — JSON import/export (no running service)

1. The agent generates rule JSON (single rule, array, or export bundle) —
   see [rule-schema.md](rule-schema.md) and `schemas/rule.schema.json`.
2. Dashboard → Settings → Import. Rules are validated; errors show JSON paths.
3. Imported rules are disabled drafts by default. Open them in the Rule
   Builder, **Test rule** (dry run), then enable.

## Level 2 — Extension messaging

Other extensions can call `chrome.runtime.sendMessage(JUSTREFRESH_ID, msg)`,
but **only if the user has added the calling extension's ID** under Dashboard →
Agent Integrations → Browser extensions that may connect. The list is empty by default; any
other extension is rejected with `forbidden` before anything is recorded, so
unknown extensions cannot file pairing requests. The allowlist is never
exported or imported. (The manifest's `externally_connectable.ids` stays `*`
because a manifest list cannot change at runtime; the allowlist is enforced in
code.) Pairing requests start with no scopes selected.

```js
// 1. Pair (creates a pending agent the user must approve, with scopes)
await chrome.runtime.sendMessage(ID, { protocol: "justrefresh-agent/1", method: "pair", name: "My Agent" });
// 2. After approval:
await chrome.runtime.sendMessage(ID, { protocol: "justrefresh-agent/1", method: "validateRule", params: { rule } });
```

Responses: `{ ok: true, result }` or `{ ok: false, error: { code, message, diagnostics? } }`.
Error codes: `invalid_params`, `validation_failed`, `not_found`, `conflict`,
`forbidden`, `pairing_required`, `unsupported_method`, `internal`.

Web pages cannot call the extension (no `externally_connectable.matches`),
and arbitrary desktop applications cannot use `chrome.runtime.sendMessage`
— use Level 3 for local agents.

## Level 3 — MCP via local bridge

See [`bridge/README.md`](../bridge/README.md). Chrome Native Messaging +
a local socket; nothing listens on the network. Each MCP client is a
separate agent requiring approval; once approved it gets its own key, which
every later call must carry. The dashboard (Agent Integrations → Desktop AI
apps → Set up) offers the bridge as one file and the install command.

## Agent API

| Method                  | Scope          | Params                                                                 |
| ----------------------- | -------------- | ---------------------------------------------------------------------- |
| `getCapabilities`       | rules:read     | `{ includeSchemas? }` (`false`: a summary without JSON Schemas)        |
| `getSchema`             | rules:read     | `{ kind: "rule" \| "condition" \| "trigger" \| "action", type? }`      |
| `listTabs`              | tabs:read      | —                                                                      |
| `listRules` / `getRule` | rules:read     | `{ id }`                                                               |
| `validateRule`          | rules:read     | `{ rule }`                                                             |
| `testRule`              | rules:test     | `{ rule, tabId }` — dry run, no side effects                           |
| `createRule`            | rules:write    | `{ rule }` → always a disabled draft                                   |
| `updateRule`            | rules:write    | `{ id, patch, expectedRevision? }` — own rules only; returns to draft  |
| `deleteRule`            | rules:delete   | `{ id, expectedRevision? }` — own rules; enabled rules need approval   |
| `enableRule`            | rules:activate | `{ id }` → `{ status: "pending_approval", approvalId }` unless trusted |
| `disableRule`           | rules:activate | `{ id }`                                                               |
| `getRuleStatus`         | status:read    | `{ id }`                                                               |
| `getHistory`            | status:read    | `{ limit?, ruleId? }`                                                  |

## Security model

- Pairing creates a **pending** agent with **no scopes**; the user approves
  and chooses scopes in Dashboard → Agent Integrations. Revocable anytime.
- Unknown methods and unknown parameters are rejected; all inputs pass the
  same validation as the UI.
- Agent-created/updated rules are drafts. Activation and deletion of active
  rules go through an approval queue (badge on the toolbar icon). An approval
  becomes **stale** if the rule changes after the request, when the rule is
  switched on or off with enable/disable or deleted before it is approved,
  or when the agent asks again (the newer request replaces it). The user may grant
  an agent _trusted activation_ for its own rules.
- Agents can only modify rules they created; they can never call user-only
  methods (global controls, settings, exclusions, agent management, import).
- Agents cannot expand site permissions (`chrome.permissions.request` needs
  a user gesture in the extension UI).
- URLs given to agents have query strings redacted by default; dry-run
  results never include page text previews — only match status, counts and
  tag/id/class names. Form values, cookies and keystrokes are never read.
- Every agent call is written to the audit log with its outcome.
- Rate limits: 60 calls/min per extension agent, 120/min via the bridge.

## Typical workflow (FR-18)

1. `getCapabilities({ includeSchemas: false })` (a summary: types, limits,
   notes; left out, it returns every schema as before; the MCP tool sends
   the summary unless asked) → `getSchema` for the
   parts you need (`{ kind: "rule" }` for a rule's fields, `{ kind, type }`
   for one condition, trigger or action) → `listTabs` → pick the tab.
2. Draft a rule; `validateRule`; fix diagnostics by path.
3. `testRule` against the tab — check `result`, `trace`, `explanations`.
4. `createRule` (draft) → `enableRule` → tell the user to approve.
5. `getRuleStatus` to monitor.

Things agents wouldn't expect:

- An agent's `updateRule` always turns the rule off and makes it a draft
  again, even when it was running: it needs `enableRule` and the user's
  approval again.
- For an agent the user marked as trusted, `enableRule` and `deleteRule` act
  at once, with no approval step.
- `unknown` is not `false`: it means the condition couldn't be checked. Its
  `code` says why: `invalid_selector` (fix the selector; agent rules are
  validated where there is no page, so a bad selector shows up here),
  `missing_permission` (no site access), `restricted_url` (a browser page
  JustRefresh can't read), `page_not_ready` or `timeout` (try again later);
  the full list is `UnknownCode` in `src/core/types.ts`.
- `disableRule` also withdraws a request waiting to switch the rule on, whoever
  disables it (agents may disable any rule). Wait for `enableRule` to answer
  before disabling: calls sent together may arrive in either order.
- `enableRule` on a rule that is already on returns `enabled` without asking
  for approval again, and disabling a rule that is already off changes
  nothing (its revision stays the same).
- `testSelector` isn't available to agents. They check a selector by
  running `testRule` with a throwaway rule whose `stopWhen` is a `dom.exists`
  condition.

MCP agents get this at runtime: the server's `instructions` (sent at
`initialize`, `INSTRUCTIONS` in `bridge/lib.mjs`) and each tool's description
cover the workflow and the points above, and every tool has a `title` and
annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) for the client's permission prompts. The instructions
don't suggest recovering hidden query strings or page text by other means.
