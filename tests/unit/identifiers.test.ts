// @ts-nocheck — imports the bridge's plain ESM JavaScript.
/**
 * The published identifiers, confirmed before the first store upload (#4).
 * Changing any of them breaks installs, saved exports or agents set up by
 * users, so this test fails on purpose: change it only with a migration plan.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMcpHandler } from "../../bridge/lib.mjs";
import { HOST, locations } from "../../bridge/install-lib.mjs";
import { AGENT_PROTOCOL } from "@/integrations/external-messaging";
import { BUNDLE_FORMAT } from "@/integrations/json-import";
import { NATIVE_HOST } from "@/integrations/native-bridge";

describe("published identifiers (fixed once published)", () => {
  it("native messaging host: com.justrefresh.bridge, the same in the extension and the installer", () => {
    expect(NATIVE_HOST).toBe("com.justrefresh.bridge");
    expect(HOST).toBe(NATIVE_HOST);
  });

  it("the bridge's folder: ~/.justrefresh", () => {
    expect(locations({ home: "/home/me", platform: "linux", env: {} }).dataDir).toBe(join("/home/me", ".justrefresh"));
  });

  it("agent protocol: justrefresh-agent/1", () => expect(AGENT_PROTOCOL).toBe("justrefresh-agent/1"));

  it("export format tag: justrefresh", () => expect(BUNDLE_FORMAT).toBe("justrefresh"));

  it("MCP server name: justrefresh", async () => {
    const handle = createMcpHandler({ callApi: async () => ({ ok: true, result: {} }) });
    const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(init.result.serverInfo.name).toBe("justrefresh");
  });

  it("npm package and extension name: justrefresh / JustRefresh", () => {
    expect(JSON.parse(readFileSync("package.json", "utf8")).name).toBe("justrefresh");
    expect(JSON.parse(readFileSync("manifest.json", "utf8")).name).toBe("JustRefresh");
  });
});
