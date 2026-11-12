// @ts-nocheck — imports the bridge's plain ESM JavaScript.
/** "Copy setup for your AI app": the steps an AI app can carry out, matching what the bridge accepts. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseInstallArgs } from "../../bridge/install-lib.mjs";
import { agentSetupPrompt, BRIDGE_FILE, platformOf, portableInstallCommand } from "@/ui/dashboard/agent-setup";

const ID = "abcdefghijklmnopabcdefghijklmnop";

describe("setup for an AI app", () => {
  it("runs one install command that the shells agents use read as written, and the installer understands", () => {
    const command = portableInstallCommand(ID);
    for (const platform of ["mac", "windows", "linux"] as const) expect(agentSetupPrompt(ID, platform)).toContain(command);
    expect(existsSync(`bridge/${BRIDGE_FILE}`)).toBe(true);
    // What bash makes of it: no redirects or mangled paths, $HOME expanded.
    if (process.platform !== "win32") {
      const r = spawnSync("bash", ["-c", `set -- ${command}; printf '%s\\n' "$@"`], { encoding: "utf8", env: { ...process.env, HOME: "/home/me" } });
      expect(r.status, r.stderr).toBe(0);
      const argv = r.stdout.trim().split("\n");
      expect(argv).toEqual(["node", `/home/me/Downloads/${BRIDGE_FILE}`, "install", "--extension-id", ID]);
      expect(parseInstallArgs(argv.slice(3))).toMatchObject({ extensionId: ID });
    }
  });

  it("has no paths to fill in: the app uses the settings the installer prints, exactly", () => {
    for (const platform of ["mac", "windows", "linux"] as const) {
      const prompt = agentSetupPrompt(ID, platform);
      expect(prompt).not.toContain("<you>");
      expect(prompt).toMatch(/using that command and those args exactly as printed/);
    }
  });

  it("names where each app keeps its settings, and changes only the justrefresh entry", () => {
    const mac = agentSetupPrompt(ID, "mac");
    expect(mac).toContain("claude mcp add --scope user justrefresh --");
    expect(mac).toContain("~/Library/Application Support/Claude/claude_desktop_config.json");
    expect(mac).toContain("~/.cursor/mcp.json");
    expect(mac).toMatch(/Change only the justrefresh entry and leave everything else as it is/);
    expect(mac).toMatch(/already there, tell me instead of replacing it/);
    expect(agentSetupPrompt(ID, "windows")).toContain("AppData\\Roaming\\Claude\\claude_desktop_config.json");
    // There is no Claude Desktop for Linux.
    expect(agentSetupPrompt(ID, "linux")).not.toContain("Claude Desktop");
  });

  it("asks which download to use when there are several", () => {
    expect(agentSetupPrompt(ID, "mac")).toMatch(/If there are several .*ask me which one to use/);
  });

  it("leaves the user's steps to the user", () => {
    const prompt = agentSetupPrompt(ID, "mac");
    expect(prompt).toMatch(/restart JustRefresh if its dashboard asks for it/);
    expect(prompt).toMatch(/restart you/);
    expect(prompt).toMatch(/approve you in the JustRefresh dashboard → Agent Integrations/);
    expect(prompt).toMatch(/Don't change JustRefresh's settings or try to approve yourself/);
    expect(prompt).toMatch(/Node\.js 18 or later/);
    expect(prompt).toContain("refresh_get_capabilities");
  });

  it("the installer prints the command and args the text refers to", async () => {
    const src = readFileSync("bridge/install-lib.mjs", "utf8");
    expect(src).toMatch(/mcpServers: \{ justrefresh: \{ command: node, args: \[script, "mcp"\] \} \}/);
  });

  it("names the platform from the browser", () => {
    expect(platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130")).toBe("mac");
    expect(platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130")).toBe("windows");
    expect(platformOf("Mozilla/5.0 (X11; Linux x86_64) Chrome/130")).toBe("linux");
  });
});
