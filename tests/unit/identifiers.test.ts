// @ts-nocheck — imports the bridge's plain ESM JavaScript.
/**
 * The published identifiers, confirmed before the first store upload (#4).
 * Changing any of them breaks installs, saved exports or agents set up by
 * users, so this test fails on purpose: change it only with a migration plan.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentKeyPath, BRIDGE_FILE, createMcpHandler, DATA_DIR_NAME, eventsFilePath, MCP_SERVER_KEY, TOOLS } from "../../bridge/lib.mjs";
import { HOST, locations } from "../../bridge/install-lib.mjs";
import { agentSetupPrompt, BRIDGE_FILE as DASHBOARD_BRIDGE_FILE, bridgePaths, mcpSettings } from "@/ui/dashboard/agent-setup";
import { AGENT_PROTOCOL } from "@/integrations/external-messaging";
import { BUNDLE_FORMAT } from "@/integrations/json-import";
import { NATIVE_HOST } from "@/integrations/native-bridge";

describe("published identifiers (fixed once published)", () => {
  it("native messaging host: com.justrefresh.bridge, the same in the extension and the installer", () => {
    expect(NATIVE_HOST).toBe("com.justrefresh.bridge");
    expect(HOST).toBe(NATIVE_HOST);
  });

  it("the bridge's folder: ~/.justrefresh, for the installer and the running bridge alike", () => {
    expect(DATA_DIR_NAME).toBe(".justrefresh");
    expect(locations({ home: "/home/me", platform: "linux", env: {} }).dataDir).toBe(join("/home/me", ".justrefresh"));
    expect(readFileSync("bridge/justrefresh-bridge.mjs", "utf8")).toContain("path.join(os.homedir(), DATA_DIR_NAME)");
  });

  it("the bridge file: justrefresh-bridge.mjs, as built, downloaded and installed (users' MCP settings point at it)", () => {
    expect(BRIDGE_FILE).toBe("justrefresh-bridge.mjs");
    expect(DASHBOARD_BRIDGE_FILE).toBe(BRIDGE_FILE);
    expect(readFileSync("scripts/build.mjs", "utf8")).toContain(`entryFileNames: "${BRIDGE_FILE}"`);
    expect(mcpSettings(bridgePaths("mac"))).toContain(`/.justrefresh/bin/${BRIDGE_FILE}`);
  });

  it("files users and their scripts rely on: events/<agent>.jsonl and agents/<agent>.key", () => {
    expect(eventsFilePath("/d", "claude-code")).toBe(join("/d", "events", "claude-code.jsonl"));
    expect(agentKeyPath("/d", "claude-code")).toBe(join("/d", "agents", "claude-code.key"));
  });

  it("agent protocol: justrefresh-agent/1", () => expect(AGENT_PROTOCOL).toBe("justrefresh-agent/1"));

  it("export format tag: justrefresh", () => expect(BUNDLE_FORMAT).toBe("justrefresh"));

  it("MCP: the server is justrefresh in users' settings and in its own name; its tool names", async () => {
    expect(MCP_SERVER_KEY).toBe("justrefresh");
    const handle = createMcpHandler({ callApi: async () => ({ ok: true, result: {} }) });
    const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(init.result.serverInfo.name).toBe("justrefresh");
    expect(Object.keys(JSON.parse(mcpSettings(bridgePaths("mac"))).mcpServers)).toEqual(["justrefresh"]);
    expect(agentSetupPrompt("a".repeat(32), "mac")).toContain("claude mcp add --scope user justrefresh --");
    // Agents' prompts, skills and permission settings name these; new tools may be added, none renamed or removed.
    const published = [
      "refresh_get_capabilities",
      "refresh_get_schema",
      "refresh_list_tabs",
      "refresh_list_rules",
      "refresh_get_rule",
      "refresh_validate_rule",
      "refresh_test_rule",
      "refresh_create_rule",
      "refresh_update_rule",
      "refresh_delete_rule",
      "refresh_enable_rule",
      "refresh_disable_rule",
      "refresh_get_status",
      "refresh_wait_for_event",
      "refresh_get_history",
    ];
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(published));
  });

  it('webhook messages say source: "justrefresh"', () => {
    expect(readFileSync("src/actions/page.ts", "utf8")).toContain('source: "justrefresh"');
  });

  it("npm package and extension name: justrefresh / JustRefresh", () => {
    expect(JSON.parse(readFileSync("package.json", "utf8")).name).toBe("justrefresh");
    expect(JSON.parse(readFileSync("manifest.json", "utf8")).name).toBe("JustRefresh");
  });
});
