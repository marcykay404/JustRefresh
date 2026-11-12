// @ts-nocheck — imports the bridge's plain ESM JavaScript.
/** "Copy setup for your AI app": the steps an AI app can carry out, matching what the bridge accepts. */
import { existsSync } from "node:fs";
import { parseInstallArgs } from "../../bridge/install-lib.mjs";
import { agentSetupPrompt, BRIDGE_FILE, bridgePaths, installCommand, mcpSettings, platformOf } from "@/ui/dashboard/agent-setup";

const ID = "abcdefghijklmnopabcdefghijklmnop";

describe("setup for an AI app", () => {
  it("runs the same install command the dashboard shows, which the installer understands", () => {
    for (const platform of ["mac", "windows", "linux"] as const) {
      const command = installCommand(ID, bridgePaths(platform));
      const prompt = agentSetupPrompt(ID, platform);
      expect(prompt).toContain(command);
      const [node, file, mode, ...args] = command.split(" ");
      expect([node, mode]).toEqual(["node", "install"]);
      expect(file.endsWith(BRIDGE_FILE)).toBe(true);
      expect(parseInstallArgs(args)).toMatchObject({ extensionId: ID });
    }
    expect(existsSync(`bridge/${BRIDGE_FILE}`)).toBe(true);
  });

  it("adds the server the way each app takes it, with the full path, keeping the servers already there", () => {
    const mac = agentSetupPrompt(ID, "mac");
    expect(mac).toContain("claude mcp add --scope user justrefresh -- node /Users/<you>/.justrefresh/bin/justrefresh-bridge.mjs mcp");
    expect(mac).toContain("~/Library/Application Support/Claude/claude_desktop_config.json");
    expect(mac).toContain(mcpSettings(bridgePaths("mac")));
    expect(mac).toMatch(/keeping the servers already there/);
    expect(mac).toMatch(/full path the install command printed, not ~ or \$HOME/);

    const win = agentSetupPrompt(ID, "windows");
    expect(win).toContain("node $HOME\\Downloads\\justrefresh-bridge.mjs install");
    expect(win).toContain("C:\\Users\\<you>\\.justrefresh\\bin\\justrefresh-bridge.mjs mcp");
    expect(win).toContain("%APPDATA%\\Claude\\claude_desktop_config.json");
    // There is no Claude Desktop for Linux.
    expect(agentSetupPrompt(ID, "linux")).not.toContain("Claude Desktop");
  });

  it("leaves the user's steps to the user", () => {
    const prompt = agentSetupPrompt(ID, "mac");
    expect(prompt).toMatch(/tell me to restart you/);
    expect(prompt).toMatch(/approve you in the JustRefresh dashboard → Agent Integrations/);
    expect(prompt).toMatch(/Don't change JustRefresh's settings or try to approve yourself/);
    expect(prompt).toMatch(/Node\.js 18 or later/);
    expect(prompt).toContain("refresh_get_capabilities");
  });

  it("names the platform from the browser", () => {
    expect(platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130")).toBe("mac");
    expect(platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130")).toBe("windows");
    expect(platformOf("Mozilla/5.0 (X11; Linux x86_64) Chrome/130")).toBe("linux");
  });
});
