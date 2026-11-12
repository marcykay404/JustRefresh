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
| `getCapabilities`       | rules:read     | —                                                                      |
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
  becomes **stale** if the rule changes after the request. The user may grant
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

1. `getCapabilities` → `listTabs` → pick the tab.
2. Draft a rule; `validateRule`; fix diagnostics by path.
3. `testRule` against the tab — check `result`, `trace`, `explanations`.
4. `createRule` (draft) → `enableRule` → tell the user to approve.
5. `getRuleStatus` to monitor.
