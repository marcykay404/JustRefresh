// @ts-nocheck — drives the real bridge processes over stdio and a local socket.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLineDecoder, createNativeDecoder, encodeNative, newNonce, proofOf } from "../../bridge/lib.mjs";

const isWin = process.platform === "win32";
const BRIDGE = "bridge/justrefresh-bridge.mjs";
const KEY = "ab".repeat(32);
const wait = async (ok: () => unknown, what: string) => {
  for (let i = 0; i < 200; i++) {
    const v = ok();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out: ${what}`);
};

/** An MCP client process talking JSON-RPC over stdio. */
function startMcp(env) {
  const mcp = spawn(process.execPath, [BRIDGE, "mcp"], { env });
  const replies: any[] = [];
  mcp.stdout.on(
    "data",
    createLineDecoder((m) => replies.push(m)),
  );
  return {
    proc: mcp,
    replies,
    send: (m: unknown) => mcp.stdin.write(JSON.stringify(m) + "\n"),
    reply: (id: number) => wait(() => replies.find((x) => x.id === id), `reply ${id}`),
  };
}

describe.skipIf(isWin)("bridge processes", () => {
  it("relays MCP tool calls to the extension and back, and keeps the agent key the extension issues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "justrefresh-bridge-"));
    const env = { ...process.env, JUSTREFRESH_BRIDGE_DIR: dir };
    // Fake Chrome: the native host's stdin/stdout. It issues a key on the first call after pairing.
    const host = spawn(process.execPath, [BRIDGE, "native-host"], { env });
    const seen: any[] = [];
    host.stdout.on(
      "data",
      createNativeDecoder((msg) => {
        seen.push(msg);
        const agentKey = msg.method === "listRules" && !msg.client.key ? { agentKey: KEY } : {};
        host.stdin.write(encodeNative({ id: msg.id, ok: true, result: { echo: msg.method, client: msg.client }, ...agentKey }));
      }),
    );
    await wait(() => existsSync(join(dir, "bridge.sock")), "socket");
    expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "bridge.sock")).mode & 0o077).toBe(0);
    expect(statSync(dir).mode & 0o077).toBe(0);

    const mcp = startMcp(env);
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "Test Agent" } } });
    expect((await mcp.reply(1)).result.serverInfo.name).toBe("justrefresh");
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "refresh_list_rules", arguments: {} } });
    expect((await mcp.reply(2)).result.structuredContent).toEqual({ echo: "listRules", client: { id: "test-agent", name: "Test Agent" } });
    // The issued key is kept privately and sent with every later call.
    const keyFile = join(dir, "agents", "test-agent.key");
    expect(readFileSync(keyFile, "utf8")).toBe(KEY);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "refresh_list_rules", arguments: {} } });
    expect((await mcp.reply(3)).result.structuredContent.client).toEqual({ id: "test-agent", name: "Test Agent", key: KEY });
    expect(seen.map((s) => s.method)).toEqual(["pair", "listRules", "listRules"]);
    expect(JSON.stringify(seen)).not.toContain(readFileSync(join(dir, "token"), "utf8")); // the token itself never travels

    mcp.proc.kill();
    host.stdin.end();
    await new Promise((r) => host.on("exit", r));
    expect(existsSync(join(dir, "token"))).toBe(false);
  }, 15_000);

  it("rejects socket clients that can't prove they know the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "justrefresh-bridge-"));
    const host = spawn(process.execPath, [BRIDGE, "native-host"], { env: { ...process.env, JUSTREFRESH_BRIDGE_DIR: dir } });
    await wait(() => existsSync(join(dir, "bridge.sock")), "socket");
    const sock = net.createConnection(join(dir, "bridge.sock"));
    const msgs: any[] = [];
    sock.on(
      "data",
      createLineDecoder((m) => msgs.push(m)),
    );
    await wait(() => msgs.length, "challenge");
    expect(msgs[0]).toMatchObject({ type: "challenge", nonce: expect.stringMatching(/^[0-9a-f]{32}$/) });
    // A proof made with the wrong token (or the right token for another challenge) is refused.
    sock.write(JSON.stringify({ type: "hello", proof: proofOf("wrong", "client", msgs[0].nonce), nonce: newNonce() }) + "\n");
    await new Promise((r) => sock.on("close", r));
    expect(msgs[1]).toEqual({ type: "error", error: "Invalid token" });
    host.stdin.end();
  });

  it("a proven client must say who it is before its first request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "justrefresh-bridge-"));
    const host = spawn(process.execPath, [BRIDGE, "native-host"], { env: { ...process.env, JUSTREFRESH_BRIDGE_DIR: dir }, stdio: ["pipe", "pipe", "pipe"] });
    await wait(() => existsSync(join(dir, "bridge.sock")) && existsSync(join(dir, "token")), "socket");
    const token = readFileSync(join(dir, "token"), "utf8").trim();
    const sock = net.createConnection(join(dir, "bridge.sock"));
    const msgs: any[] = [];
    sock.on(
      "data",
      createLineDecoder((m) => msgs.push(m)),
    );
    await wait(() => msgs.length, "challenge");
    sock.write(JSON.stringify({ type: "hello", proof: proofOf(token, "client", msgs[0].nonce), nonce: newNonce() }) + "\n");
    await wait(() => msgs.length > 1, "ready");
    expect(msgs[1].type).toBe("ready");
    sock.write(JSON.stringify({ id: 1, method: "listRules" }) + "\n");
    await new Promise((r) => sock.on("close", r));
    expect(msgs[2]).toEqual({ type: "error", error: "Expected the client's identity" });
    host.stdin.end();
  });

  it("won't talk to a program posing as the bridge: no request, no agent key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "justrefresh-bridge-"));
    writeFileSync(join(dir, "token"), "the-real-token", { mode: 0o600 });
    const received: any[] = [];
    // Took the socket first and answers the handshake, but doesn't know the token.
    const impostor = net.createServer((s) => {
      s.write(JSON.stringify({ type: "challenge", nonce: newNonce() }) + "\n");
      s.on(
        "data",
        createLineDecoder((m) => {
          received.push(m);
          s.write(JSON.stringify({ type: "ready", proof: proofOf("guess", "server", m.nonce) }) + "\n");
        }),
      );
    });
    await new Promise<void>((r) => impostor.listen(join(dir, "bridge.sock"), r));
    const mcp = startMcp({ ...process.env, JUSTREFRESH_BRIDGE_DIR: dir, JUSTREFRESH_AGENT_ID: "test-agent" });
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "Test Agent" } } });
    await mcp.reply(1);
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "refresh_list_rules", arguments: {} } });
    const r = await mcp.reply(2);
    expect(JSON.stringify(r)).toMatch(/couldn't prove/);
    expect(received.every((m) => m.type === "hello")).toBe(true);
    // It never learns which agent was connecting: the identity is sent only after the bridge's proof checks out.
    expect(JSON.stringify(received)).not.toMatch(/test-agent|Test Agent/);
    mcp.proc.kill();
    impostor.close();
  }, 15_000);

  it("installs with one command: copies itself, registers with the browser, and uninstalls", () => {
    const home = mkdtempSync(join(tmpdir(), "justrefresh-home-"));
    const env = { ...process.env, HOME: home, JUSTREFRESH_BRIDGE_DIR: join(home, ".justrefresh") };
    const run = (...args: string[]) => spawnSync(process.execPath, args, { env, encoding: "utf8" });
    expect(run(BRIDGE, "install").status).toBe(2); // needs the extension id
    const out = run(BRIDGE, "install", "--extension-id", "abcdefghijklmnopabcdefghijklmnop");
    expect(out.status, out.stderr).toBe(0);
    const bin = join(home, ".justrefresh", "bin");
    const hostsDir =
      process.platform === "darwin" ? "Library/Application Support/Google/Chrome/NativeMessagingHosts" : ".config/google-chrome/NativeMessagingHosts";
    const manifest = JSON.parse(readFileSync(join(home, hostsDir, "com.justrefresh.bridge.json"), "utf8"));
    expect(manifest).toMatchObject({
      name: "com.justrefresh.bridge",
      path: join(bin, "justrefresh-native-host.sh"),
      allowed_origins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
    });
    expect(readFileSync(manifest.path, "utf8")).toContain(join(bin, "justrefresh-bridge.mjs"));
    expect(out.stdout).toContain(`"${join(bin, "justrefresh-bridge.mjs")}"`);
    // The installed copy runs on its own.
    expect(run(join(bin, "justrefresh-bridge.mjs")).stderr).toMatch(/Usage/);
    expect(run(BRIDGE, "uninstall").status).toBe(0);
    expect(existsSync(join(home, hostsDir, "com.justrefresh.bridge.json"))).toBe(false);
    expect(existsSync(bin)).toBe(false);
  });

  it("doesn't hang when the other end drops the connection mid-handshake", async () => {
    const dir = mkdtempSync(join(tmpdir(), "justrefresh-bridge-"));
    writeFileSync(join(dir, "token"), "t", { mode: 0o600 });
    const dropper = net.createServer((s) => {
      s.write(JSON.stringify({ type: "challenge", nonce: newNonce() }) + "\n");
      s.on("data", () => s.destroy());
    });
    await new Promise<void>((r) => dropper.listen(join(dir, "bridge.sock"), r));
    const mcp = startMcp({ ...process.env, JUSTREFRESH_BRIDGE_DIR: dir });
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "A" } } });
    expect((await mcp.reply(1)).result).toBeDefined();
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "refresh_list_rules", arguments: {} } });
    expect(JSON.stringify(await mcp.reply(2))).toMatch(/closed the connection/);
    // Garbage from the MCP app gets a JSON-RPC parse error, not a crash.
    mcp.proc.stdin.write("not json\n");
    const parseError = await wait(() => mcp.replies.find((r) => r.error?.code === -32700), "parse error");
    expect(parseError.id).toBeNull();
    mcp.proc.kill();
    dropper.close();
  }, 15_000);

  it("drops a socket client that sends garbage, and keeps serving others", async () => {
    const dir = mkdtempSync(join(tmpdir(), "justrefresh-bridge-"));
    const host = spawn(process.execPath, [BRIDGE, "native-host"], { env: { ...process.env, JUSTREFRESH_BRIDGE_DIR: dir } });
    await wait(() => existsSync(join(dir, "bridge.sock")), "socket");
    const bad = net.createConnection(join(dir, "bridge.sock"));
    bad.resume(); // read (and ignore) the challenge, so the close is reported
    bad.write("{not json\n");
    await new Promise((r) => bad.on("close", r));
    const good = net.createConnection(join(dir, "bridge.sock"));
    const msgs: any[] = [];
    good.on(
      "data",
      createLineDecoder((m) => msgs.push(m)),
    );
    await wait(() => msgs.length, "challenge from the same host");
    expect(host.exitCode).toBeNull();
    good.destroy();
    host.stdin.end();
  }, 15_000);

  it("the launcher works from a home folder with a space, a quote and a $ in its name; uninstall leaves other files alone", async () => {
    // Under /tmp: a Unix socket path must stay under ~104 characters.
    const home = join(mkdtempSync("/tmp/jr-"), "o'neil $HOME x");
    const dataDir = join(home, ".justrefresh");
    const env = { ...process.env, HOME: home, JUSTREFRESH_BRIDGE_DIR: dataDir };
    const run = (...args: string[]) => spawnSync(process.execPath, args, { env, encoding: "utf8" });
    expect(run(BRIDGE, "install", "--extension-id", "abcdefghijklmnopabcdefghijklmnop").status).toBe(0);
    const bin = join(dataDir, "bin");
    writeFileSync(join(bin, "mine.txt"), "keep me");
    // Start the native host the way Chrome does: through the launcher.
    const host = spawn(join(bin, "justrefresh-native-host.sh"), ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"], { env });
    await wait(() => existsSync(join(dataDir, "bridge.sock")), "host started via launcher");
    host.stdin.end();
    await new Promise((r) => host.on("exit", r));
    expect(run(BRIDGE, "uninstall").status).toBe(0);
    expect(readFileSync(join(bin, "mine.txt"), "utf8")).toBe("keep me");
    expect(existsSync(join(bin, "justrefresh-bridge.mjs"))).toBe(false);
  }, 15_000);
});
