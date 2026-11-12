// @ts-nocheck — imports the bridge's plain ESM JavaScript.
/** "Copy setup for your AI app": the steps an AI app can carry out, matching what the bridge accepts. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseInstallArgs } from "../../bridge/install-lib.mjs";
import { agentSetupPrompt, BRIDGE_FILE, bridgeFromNpm, platformOf, portableInstallCommand, STORE_EXTENSION_ID } from "@/ui/dashboard/agent-setup";

const ID = "abcdefghijklmnopabcdefghijklmnop";

describe("setup for an AI app", () => {
  it("runs one install command that the shells agents use read as written, and the installer understands", () => {
    const command = portableInstallCommand(ID);
    for (const platform of ["mac", "windows", "linux"] as const) expect(agentSetupPrompt(ID, platform, "0.1.0")).toContain(command);
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
      const prompt = agentSetupPrompt(ID, platform, "0.1.0");
      expect(prompt).not.toContain("<you>");
      expect(prompt).toMatch(/using that command and those args exactly as printed/);
    }
  });

  it("names where each app keeps its settings, and changes only the justrefresh entry", () => {
    const mac = agentSetupPrompt(ID, "mac", "0.1.0");
    expect(mac).toContain("claude mcp add --scope user justrefresh --");
    expect(mac).toContain("~/Library/Application Support/Claude/claude_desktop_config.json");
    expect(mac).toContain("~/.cursor/mcp.json");
    expect(mac).toMatch(/Change only the justrefresh entry and leave everything else as it is/);
    expect(mac).toMatch(/already there, tell me instead of replacing it/);
    expect(agentSetupPrompt(ID, "windows", "0.1.0")).toContain("AppData\\Roaming\\Claude\\claude_desktop_config.json");
    // There is no Claude Desktop for Linux.
    expect(agentSetupPrompt(ID, "linux", "0.1.0")).not.toContain("Claude Desktop");
  });

  it("asks which download to use when there are several", () => {
    expect(agentSetupPrompt(ID, "mac", "0.1.0")).toMatch(/If there are several .*ask me which one to use/);
  });

  it("leaves the user's steps to the user", () => {
    const prompt = agentSetupPrompt(ID, "mac", "0.1.0");
    expect(prompt).toMatch(/restart JustRefresh if its dashboard asks for it/);
    expect(prompt).toMatch(/restart you/);
    expect(prompt).toMatch(/approve you in the JustRefresh dashboard → Agent Integrations/);
    expect(prompt).toMatch(/Don't change JustRefresh's settings or try to approve yourself/);
    expect(prompt).toMatch(/Node\.js 18 or later/);
    expect(prompt).toContain("refresh_get_capabilities");
  });

  it("in other shells and when it fails: says what to change, and never to escalate", () => {
    const prompt = agentSetupPrompt(ID, "windows", "0.1.0");
    expect(prompt).toMatch(/in cmd\.exe use %USERPROFILE% in place of \$HOME/);
    expect(prompt).toMatch(/Don't use sudo or an administrator shell: if it fails, show me the error/);
    expect(prompt).toMatch(/ask me which one to use, and run that one/);
    expect(agentSetupPrompt(ID, "linux", "0.1.0")).toContain("xdg-user-dir DOWNLOAD");
    expect(agentSetupPrompt(ID, "mac", "0.1.0")).not.toContain("xdg-user-dir");
  });

  it("names the platform from the browser", () => {
    expect(platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130")).toBe("mac");
    expect(platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130")).toBe("windows");
    expect(platformOf("Mozilla/5.0 (X11; Linux x86_64) Chrome/130")).toBe("linux");
  });
});

describe("setup for an AI app, JustRefresh from the Chrome Web Store", () => {
  it("installs the bridge of this exact version from npm, with nothing to download and no id to pass", () => {
    expect(bridgeFromNpm(STORE_EXTENSION_ID)).toBe(true);
    expect(bridgeFromNpm(ID)).toBe(false);
    for (const platform of ["mac", "windows", "linux"] as const) {
      const prompt = agentSetupPrompt(STORE_EXTENSION_ID, platform, "0.1.1");
      expect(prompt).toContain("   npx -y justrefresh@0.1.1 install\n");
      expect(prompt).not.toMatch(/I downloaded justrefresh-bridge\.mjs/);
      // If npm can't be used: the download, with this extension's id.
      expect(prompt).toContain(portableInstallCommand(STORE_EXTENSION_ID));
      // The rest is the same as for a download.
      expect(prompt).toMatch(/using that command and those args exactly as printed/);
      expect(prompt).toMatch(/Don't use sudo or an administrator shell/);
      expect(prompt).not.toContain("<you>");
    }
  });
});
