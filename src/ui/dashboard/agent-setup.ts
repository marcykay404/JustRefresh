/**
 * Setting up the desktop bridge: the commands the dashboard shows, and the
 * same steps written for an AI app that can run commands (Claude Code and
 * the like), to paste into it. The steps only the user can do stay with the
 * user: allowing desktop apps (Chrome's prompt), downloading the bridge,
 * restarting the app, and approving the agent.
 */

export type SetupPlatform = "mac" | "windows" | "linux";

export interface SetupPaths {
  /** Where the browser saves downloads, as typed in the default terminal. */
  download: string;
  /** Where the installer puts the bridge, as typed in the default terminal. */
  bin: string;
  /** The same as a full path, with <you> for the user name (MCP apps don't expand ~ or $HOME). */
  fullBin: string;
}

export const platformOf = (userAgent: string): SetupPlatform => (userAgent.includes("Windows") ? "windows" : userAgent.includes("Mac") ? "mac" : "linux");

/** Paths as typed in the default terminal: PowerShell on Windows ($HOME), a Unix shell elsewhere (~). */
export function bridgePaths(platform: SetupPlatform): SetupPaths {
  if (platform === "windows") {
    return { download: "$HOME\\Downloads\\", bin: "$HOME\\.justrefresh\\bin\\", fullBin: "C:\\Users\\<you>\\.justrefresh\\bin\\" };
  }
  const home = platform === "mac" ? "/Users/<you>" : "/home/<you>";
  return { download: "~/Downloads/", bin: "~/.justrefresh/bin/", fullBin: `${home}/.justrefresh/bin/` };
}

export const BRIDGE_FILE = "justrefresh-bridge.mjs";

export const installCommand = (extensionId: string, paths: SetupPaths) => `node ${paths.download}${BRIDGE_FILE} install --extension-id ${extensionId}`;

export const mcpSettings = (paths: SetupPaths) =>
  JSON.stringify({ mcpServers: { justrefresh: { command: "node", args: [`${paths.fullBin}${BRIDGE_FILE}`, "mcp"] } } });

/** Where Claude Desktop keeps its MCP settings (it has no Linux version). */
const CLAUDE_DESKTOP_CONFIG: Partial<Record<SetupPlatform, string>> = {
  mac: "~/Library/Application Support/Claude/claude_desktop_config.json",
  windows: "%APPDATA%\\Claude\\claude_desktop_config.json",
};

/** The setup written for an AI app to carry out, to paste into it. */
export function agentSetupPrompt(extensionId: string, platform: SetupPlatform): string {
  const paths = bridgePaths(platform);
  const server = `${paths.fullBin}${BRIDGE_FILE}`;
  const desktop = CLAUDE_DESKTOP_CONFIG[platform];
  return [
    "Please set up the JustRefresh MCP server on this computer, so you can manage auto-refresh rules in my Chrome.",
    "JustRefresh is a Chrome extension. Its MCP server is a small Node.js program (the bridge) that talks to the extension through Chrome Native Messaging; nothing listens on the network.",
    "",
    "1. Check that Node.js 18 or later is installed (node --version). If it isn't, stop and tell me.",
    `2. Install the bridge. I downloaded ${BRIDGE_FILE} from the JustRefresh dashboard to my Downloads folder. Run:`,
    `   ${installCommand(extensionId, paths)}`,
    `   If the file isn't there, ask me where I saved it, or to click "Download the bridge" in JustRefresh → Agent Integrations. The command copies the bridge to ${paths.bin}, registers it with my browsers, and prints the MCP settings with the full path.`,
    '3. Add an MCP server named "justrefresh" to your own MCP settings, keeping the servers already there. Use the full path the install command printed, not ~ or $HOME:',
    `   - Claude Code: claude mcp add --scope user justrefresh -- node ${server} mcp`,
    ...(desktop ? [`   - Claude Desktop: under "mcpServers" in ${desktop}`] : []),
    '   - Cursor: under "mcpServers" in ~/.cursor/mcp.json',
    `   - Other apps: ${mcpSettings(paths)}`,
    "4. Then tell me to restart you (or reconnect your MCP servers), and to approve you in the JustRefresh dashboard → Agent Integrations, where I choose what you may do. Don't change JustRefresh's settings or try to approve yourself.",
    "",
    "Once you're connected and approved, start with the refresh_get_capabilities tool.",
  ].join("\n");
}
