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

/** What the installer prints, with placeholders for the parts only it knows. */
export const mcpSettings = (paths: SetupPaths) =>
  JSON.stringify({ mcpServers: { justrefresh: { command: "<full path to node>", args: [`${paths.fullBin}${BRIDGE_FILE}`, "mcp"] } } });

/**
 * The install command for an AI app to run: the same in bash, zsh and
 * PowerShell (Claude Code on Windows runs Git Bash), so forward slashes and a
 * quoted $HOME, which all three expand.
 */
export const portableInstallCommand = (extensionId: string) => `node "$HOME/Downloads/${BRIDGE_FILE}" install --extension-id ${extensionId}`;

/** Where Claude Desktop keeps its MCP settings, in words (it has no Linux version). */
const CLAUDE_DESKTOP_CONFIG: Partial<Record<SetupPlatform, string>> = {
  mac: "~/Library/Application Support/Claude/claude_desktop_config.json",
  windows: "AppData\\Roaming\\Claude\\claude_desktop_config.json in my user folder",
};

/**
 * The setup written for an AI app to carry out, to paste into it. It has no
 * paths to fill in: the app runs one command, then uses the MCP settings the
 * installer prints, which have the full paths to Node and the bridge.
 */
export function agentSetupPrompt(extensionId: string, platform: SetupPlatform): string {
  const desktop = CLAUDE_DESKTOP_CONFIG[platform];
  return [
    "Please set up the JustRefresh MCP server on this computer, so you can manage auto-refresh rules in my Chrome.",
    "JustRefresh is a Chrome extension. Its MCP server is a small Node.js program (the bridge) that talks to the extension through Chrome Native Messaging; nothing listens on the network.",
    "",
    "1. Check that Node.js 18 or later is installed (node --version). If it isn't, stop and tell me.",
    `2. Install the bridge. I downloaded ${BRIDGE_FILE} from the JustRefresh dashboard to my Downloads folder. Run this (it works as written in bash, zsh and PowerShell; in cmd.exe use %USERPROFILE% in place of $HOME):`,
    `   ${portableInstallCommand(extensionId)}`,
    `   If the file isn't there, ask me where I saved it${platform === "linux" ? " (xdg-user-dir DOWNLOAD names my Downloads folder)" : ""}. If there are several (Chrome names a second download "justrefresh-bridge (1).mjs"), ask me which one to use, and run that one. The command copies the bridge to the .justrefresh folder in my home folder, registers it with my browsers, and prints MCP settings: a "command" (the full path to Node) and "args" (the full path to the bridge, then mcp). Don't use sudo or an administrator shell: if it fails, show me the error.`,
    '3. Add an MCP server named "justrefresh" to your own MCP settings, using that command and those args exactly as printed. Change only the justrefresh entry and leave everything else as it is; if a justrefresh server is already there, tell me instead of replacing it.',
    "   - Claude Code: claude mcp add --scope user justrefresh -- followed by the printed command and args, each in double quotes.",
    ...(desktop ? [`   - Claude Desktop: under "mcpServers" in ${desktop}.`] : []),
    '   - Cursor: under "mcpServers" in ~/.cursor/mcp.json.',
    '   - Other apps: the printed settings as they are ({"mcpServers": {"justrefresh": {"command": …, "args": […]}}}).',
    "4. Then tell me to: restart JustRefresh if its dashboard asks for it; restart you (or reconnect your MCP servers); and approve you in the JustRefresh dashboard → Agent Integrations, where I choose what you may do. Don't change JustRefresh's settings or try to approve yourself.",
    "",
    "Once you're connected and approved, start with the refresh_get_capabilities tool.",
  ].join("\n");
}
