# JustRefresh — local MCP bridge (optional)

The Chrome extension works without this. The bridge lets local MCP clients
(desktop AI agents) call the extension's Rule Management API.

```
MCP client ──stdio──▶ sar-bridge.mjs mcp ──local socket + token──▶ sar-bridge.mjs native-host ◀──Native Messaging── extension
```

* No network port is opened. The socket lives in `~/.smart-auto-refresh/`
  (directory `0700`, socket `0600`); a random token, rewritten every time
  Chrome starts the host, must be presented on connect.
* Every MCP client is a separate agent in the extension and must be approved
  by the user (Dashboard → Agent Integrations), with explicit scopes.
* Agent-created rules are drafts; activation needs user approval unless the
  user grants that agent "trusted activation". All calls are audited.
* Requires Node.js 18+. No npm dependencies.

## Setup

1. Load the extension and copy its ID (Dashboard → Agent Integrations).
2. Register the native host:
   ```bash
   node bridge/install.mjs --extension-id <EXTENSION_ID> --browser chrome
   ```
3. Dashboard → Agent Integrations → **Enable native bridge** (grants the
   optional `nativeMessaging` permission). The first time, click **Restart
   extension to finish**: Chrome only exposes native messaging to a service
   worker that started with the permission. Rules and schedules are kept.
4. Add the MCP server printed by the installer to your MCP client config:
   ```json
   { "mcpServers": { "smart-auto-refresh": { "command": "node", "args": ["/path/to/bridge/sar-bridge.mjs", "mcp"] } } }
   ```
5. Start the agent; approve it in the dashboard when the pairing request appears.

## Tools

| Tool | API method |
|---|---|
| `refresh_get_capabilities` | getCapabilities |
| `refresh_list_tabs` | listTabs |
| `refresh_list_rules` | listRules |
| `refresh_get_rule` | getRule |
| `refresh_validate_rule` | validateRule |
| `refresh_test_rule` | testRule (dry run) |
| `refresh_create_rule` | createRule (draft) |
| `refresh_update_rule` | updateRule |
| `refresh_delete_rule` | deleteRule |
| `refresh_enable_rule` | enableRule (approval) |
| `refresh_disable_rule` | disableRule |
| `refresh_get_status` | getRuleStatus |
| `refresh_get_history` | getHistory |

Unknown tool arguments are rejected. Uninstall with `node bridge/install.mjs --uninstall`.
