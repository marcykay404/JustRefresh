# JustRefresh — local MCP bridge (optional)

The Chrome extension works without this. The bridge lets local MCP clients
(desktop AI agents) call the extension's Rule Management API.

```
MCP client ──stdio──▶ justrefresh-bridge.mjs mcp ──local socket + token──▶ justrefresh-bridge.mjs native-host ◀──Native Messaging── extension
```

- No network port is opened. The socket lives in `~/.justrefresh/`
  (directory `0700`, socket `0600`; on Windows a per-user named pipe, and the
  folder is limited to your account with `icacls`).
- Both ends prove they know a random token, rewritten every time Chrome starts
  the host, without sending it: each signs the other's challenge (HMAC-SHA256).
  So a program that takes the socket or pipe name first learns nothing useful,
  and the MCP side sends nothing until the bridge has proved itself.
- Every MCP client is a separate agent in the extension and must be approved
  by the user (Dashboard → Agent Integrations), with explicit scopes.
- Once approved, an agent gets its own key from the extension, kept in
  `~/.justrefresh/agents/<agent>.key` (`0600`). Every later call must carry
  it, so another program can't take over an approved agent by using its name
  (set with `JUSTREFRESH_AGENT_ID`, or the MCP client's name). If the key is
  lost, remove the agent in the dashboard and approve it again. Agents
  approved before keys existed get theirs on their next call.
- Agent-created rules are drafts; activation needs user approval unless the
  user grants that agent "trusted activation". All calls are audited.
- Requires Node.js 18+. No npm dependencies.

## Setup

The dashboard walks you through it (Dashboard → Agent Integrations → Desktop
AI apps → Set up), with the commands ready to copy:

1. Switch on **Allow desktop AI apps to connect** (grants the optional
   `nativeMessaging` permission). The first time, click **Restart JustRefresh**
   when asked: Chrome only exposes native messaging to a service worker that
   started with the permission. Rules and schedules are kept.
2. **Download the bridge**: one file, `justrefresh-bridge.mjs`, shipped inside
   the extension.
3. Install it with one command:
   ```bash
   node ~/Downloads/justrefresh-bridge.mjs install --extension-id <EXTENSION_ID>
   ```
   It copies itself to `~/.justrefresh/bin/`, writes the launcher Chrome
   starts, registers the native host with every Chromium browser it finds
   (Chrome and its Beta/Dev/Canary channels, Chromium, Edge, Brave, Vivaldi,
   Arc; or the one given with `--browser`), and on
   Windows adds the registry entries (HKCU, no admin). It prints the MCP
   settings with the full path filled in.
4. Add them to your MCP client:
   ```json
   { "mcpServers": { "justrefresh": { "command": "node", "args": ["/Users/you/.justrefresh/bin/justrefresh-bridge.mjs", "mcp"] } } }
   ```
5. Start the agent; approve it in the dashboard when the pairing request appears.

After installing a newer bridge, turn desktop apps off and on in
JustRefresh → Agent Integrations (or restart Chrome), so Chrome starts the
new copy; a newer AI-app side refuses an older one with a message saying
so. Restarting your AI app as well picks up the new copy on its side.

From a checkout of this repository, `node bridge/justrefresh-bridge.mjs install --extension-id <id>`
(or `node bridge/install.mjs --extension-id <id>`) does the same.

## Tools

| Tool                       | API method            |
| -------------------------- | --------------------- |
| `refresh_get_capabilities` | getCapabilities       |
| `refresh_get_schema`       | getSchema             |
| `refresh_list_tabs`        | listTabs              |
| `refresh_list_rules`       | listRules             |
| `refresh_get_rule`         | getRule               |
| `refresh_validate_rule`    | validateRule          |
| `refresh_test_rule`        | testRule (dry run)    |
| `refresh_create_rule`      | createRule (draft)    |
| `refresh_update_rule`      | updateRule            |
| `refresh_delete_rule`      | deleteRule            |
| `refresh_enable_rule`      | enableRule (approval) |
| `refresh_disable_rule`     | disableRule           |
| `refresh_get_status`       | getRuleStatus         |
| `refresh_get_history`      | getHistory            |

Each tool has a `title` and MCP annotations: the read-only tools say so;
`refresh_update_rule`, `refresh_delete_rule`, `refresh_disable_rule` and
`refresh_enable_rule` (which switches a rule on at once for a trusted agent)
are marked destructive, so clients can ask before running them; and
`refresh_list_tabs`, `refresh_test_rule`, `refresh_get_status`,
`refresh_get_history` and `refresh_enable_rule` are marked open-world, since
they return text from web pages (titles, URLs, page errors) or make a rule act
on them. Results come back
as compact JSON text; a result up to 4 KB is also sent as `structuredContent`,
a larger one only once, as text. `refresh_get_capabilities` is a summary that
also carries the server instructions (for clients that don't show
`instructions` to the model); JSON Schemas come one piece at a time from
`refresh_get_schema`, or all at once with `includeSchemas: true`.

Unknown tool arguments are rejected. Uninstall with `node ~/.justrefresh/bin/justrefresh-bridge.mjs uninstall`.
