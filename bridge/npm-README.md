# justrefresh

The local MCP bridge for [JustRefresh](https://github.com/marcykay404/JustRefresh),
the Chrome extension that refreshes tabs on a timer or until something
appears, without refreshing over what you're typing.

It lets AI apps on your computer that support MCP (Model Context Protocol),
such as Claude Code, Claude Desktop or Cursor, set up refresh rules in
JustRefresh. Rules they create stay off until you approve them in the
extension (unless you choose to trust that app), and you choose what each app
may see and do.

- No network port: the bridge talks to the extension through Chrome Native
  Messaging and a local socket (a per-user named pipe on Windows) that only
  your account can open.
- No dependencies: one file, Node.js 18 or later.

## Set up

1. Install JustRefresh in Chrome, open its dashboard → Agent Integrations, and
   switch on **Allow desktop AI apps to connect**.
2. Install the bridge (use the version JustRefresh's dashboard shows):

   ```bash
   npx -y justrefresh install
   ```

   It copies itself to `~/.justrefresh/bin`, registers with your Chromium
   browsers, and prints the MCP settings for your AI app, with a ready-made
   `claude mcp add` line for Claude Code. It's set up for JustRefresh from the
   Chrome Web Store; for another copy (unpacked, or from Edge Add-ons), add
   `--extension-id <id>` from its dashboard.

3. Add the printed settings to your AI app, restart it, and approve it in the
   JustRefresh dashboard when it asks to connect.

Or let your AI app do steps 2 and 3: the dashboard has **Copy setup for your
AI app** with the steps written for it.

To remove it: `node ~/.justrefresh/bin/justrefresh-bridge.mjs uninstall`.

More: [bridge documentation](https://github.com/marcykay404/JustRefresh/blob/main/bridge/README.md) ·
[privacy](https://github.com/marcykay404/JustRefresh/blob/main/PRIVACY.md) ·
[issues](https://github.com/marcykay404/JustRefresh/issues). MIT licensed.
