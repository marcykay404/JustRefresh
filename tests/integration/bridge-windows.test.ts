// @ts-nocheck — drives the real bridge on Windows: the named pipe, icacls, reg and the .bat launcher.
// Runs only on Windows CI (.github/workflows/ci.yml), or with JUSTREFRESH_WINDOWS_TESTS=1:
// it writes the native host's registry entries under HKCU and removes them again,
// and uses this account's bridge pipe, so it would replace a real install.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLineDecoder, createNativeDecoder, encodeNative } from "../../bridge/lib.mjs";

const isWin = process.platform === "win32" && (process.env.CI === "true" || process.env.JUSTREFRESH_WINDOWS_TESTS === "1");
const BRIDGE = "bridge/justrefresh-bridge.mjs";
const ID = "abcdefghijklmnopabcdefghijklmnop";
const KEY_PATH = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.justrefresh.bridge";
const KEY = "cd".repeat(32);
const wait = async (ok: () => unknown, what: string) => {
  for (let i = 0; i < 400; i++) {
    const v = ok();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out: ${what}`);
};

/** A native host whose stdout is read as Chrome would, answering each call with an echo. */
function fakeChrome(host) {
  const seen = [];
  host.stdout.on(
    "data",
    createNativeDecoder((msg) => {
      seen.push(msg);
      const agentKey = msg.method === "listRules" && !msg.client.key ? { agentKey: KEY } : {};
      host.stdin.write(encodeNative({ id: msg.id, ok: true, result: { echo: msg.method, client: msg.client }, ...agentKey }));
    }),
  );
  let log = "";
  host.stderr.on("data", (d) => (log += d));
  host.stdout.on("error", () => undefined);
  return { seen, listening: () => log.includes("listening"), log: () => `exit ${host.exitCode}; stderr: ${log}` };
}

const stop = async (host) => {
  host.stdin.end();
  if (host.exitCode === null) await new Promise((r) => host.on("exit", r));
};

describe.runIf(isWin)("bridge on Windows", () => {
  it("relays MCP calls over the per-user named pipe, and locks the data folder to this account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "justrefresh-bridge-"));
    const env = { ...process.env, JUSTREFRESH_BRIDGE_DIR: dir };
    const host = spawn(process.execPath, [BRIDGE, "native-host"], { env });
    const chrome = fakeChrome(host);
    await wait(chrome.listening, "pipe listening").catch((e) => {
      throw new Error(`${e.message} (${chrome.log()})`);
    });

    // icacls: inheritance removed, and only this account has access (full control, inherited by what's inside).
    const acl = spawnSync("icacls", [dir], { encoding: "utf8" }).stdout;
    const entries = acl
      .replace(dir, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.includes(":("));
    expect(entries, acl).toHaveLength(1);
    expect(entries[0]).toMatch(new RegExp(`\\\\${process.env.USERNAME}:\\(OI\\)\\(CI\\)\\(F\\)$`, "i"));
    expect(acl).not.toMatch(/\(I\)|SYSTEM|Administrators|BUILTIN\\Users|Everyone/);

    const mcp = spawn(process.execPath, [BRIDGE, "mcp"], { env: { ...env, JUSTREFRESH_AGENT_ID: "win-agent" } });
    const replies = [];
    mcp.stdout.on(
      "data",
      createLineDecoder((m) => replies.push(m)),
    );
    const send = (m) => mcp.stdin.write(JSON.stringify(m) + "\n");
    const reply = (id) => wait(() => replies.find((x) => x.id === id), `reply ${id}`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "Win Agent" } } });
    await reply(1);
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "refresh_list_rules", arguments: {} } });
    expect((await reply(2)).result.structuredContent).toEqual({ echo: "listRules", client: { id: "win-agent", name: "Win Agent" } });
    expect(readFileSync(join(dir, "agents", "win-agent.key"), "utf8")).toBe(KEY);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "refresh_list_rules", arguments: {} } });
    expect((await reply(3)).result.structuredContent.client.key).toBe(KEY);
    mcp.kill();
    await stop(host);
    expect(existsSync(join(dir, "token"))).toBe(false);
  }, 30_000);

  it("installs into HKCU, starts through the .bat launcher from a folder with a space, a quote and a %, and uninstalls", async () => {
    const root = mkdtempSync(join(tmpdir(), "jr-"));
    const dataDir = join(root, "o'neil 100% x", ".justrefresh");
    const env = { ...process.env, JUSTREFRESH_BRIDGE_DIR: dataDir, LOCALAPPDATA: join(root, "AppData") };
    const run = (...args) => spawnSync(process.execPath, args, { env, encoding: "utf8" });
    const out = run(BRIDGE, "install", "--extension-id", ID);
    expect(out.status, out.stderr).toBe(0);
    try {
      const query = spawnSync("reg", ["query", KEY_PATH, "/ve"], { encoding: "utf8" });
      expect(query.status, query.stderr).toBe(0);
      const manifestFile = join(dataDir, "bin", "com.justrefresh.bridge.json");
      expect(query.stdout).toContain(manifestFile);
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      expect(manifest.path).toBe(join(dataDir, "bin", "justrefresh-native-host.bat"));
      expect(manifest.allowed_origins).toEqual([`chrome-extension://${ID}/`]);
      writeFileSync(join(dataDir, "bin", "mine.txt"), "keep me");

      // Start it the way Chrome does: cmd /d /s /c ""<launcher>" <origin>".
      const host = spawn("cmd.exe", ["/d", "/s", "/c", `""${manifest.path}" chrome-extension://${ID}/"`], { env, windowsVerbatimArguments: true });
      const chrome = fakeChrome(host);
      await wait(chrome.listening, "host started via the .bat launcher").catch((e) => {
        throw new Error(`${e.message} (${chrome.log()}; launcher: ${readFileSync(manifest.path, "utf8")})`);
      });
      expect(existsSync(join(dataDir, "token"))).toBe(true);
      await stop(host);
    } finally {
      expect(run(BRIDGE, "uninstall").status).toBe(0);
    }
    expect(spawnSync("reg", ["query", KEY_PATH, "/ve"]).status).not.toBe(0);
    expect(readFileSync(join(dataDir, "bin", "mine.txt"), "utf8")).toBe("keep me");
    expect(existsSync(join(dataDir, "bin", "justrefresh-bridge.mjs"))).toBe(false);
  }, 30_000);
});
