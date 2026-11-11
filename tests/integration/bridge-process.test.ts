// @ts-nocheck — drives the real bridge processes over stdio and a local socket.
import { spawn } from "node:child_process";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLineDecoder, createNativeDecoder, encodeNative } from "../../bridge/lib.mjs";

const isWin = process.platform === "win32";

describe.skipIf(isWin)("bridge processes", () => {
  it("relays MCP tool calls to the extension and back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "justrefresh-bridge-"));
    const env = { ...process.env, JUSTREFRESH_BRIDGE_DIR: dir };
    // Fake Chrome: the native host's stdin/stdout.
    const host = spawn(process.execPath, ["bridge/justrefresh-bridge.mjs", "native-host"], { env });
    const seen: any[] = [];
    host.stdout.on(
      "data",
      createNativeDecoder((msg) => {
        seen.push(msg);
        host.stdin.write(encodeNative({ id: msg.id, ok: true, result: { echo: msg.method, client: msg.client } }));
      }),
    );
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (existsSync(join(dir, "bridge.sock"))) {
          clearInterval(t);
          resolve();
        }
      }, 25);
    });
    expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "bridge.sock")).mode & 0o077).toBe(0);

    const mcp = spawn(process.execPath, ["bridge/justrefresh-bridge.mjs", "mcp"], { env });
    const replies: any[] = [];
    mcp.stdout.on(
      "data",
      createLineDecoder((m) => replies.push(m)),
    );
    const send = (m: unknown) => mcp.stdin.write(JSON.stringify(m) + "\n");
    const waitReply = async (id: number) => {
      for (let i = 0; i < 200; i++) {
        const r = replies.find((x) => x.id === id);
        if (r) return r;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`no reply ${id}`);
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "Test Agent" } } });
    expect((await waitReply(1)).result.serverInfo.name).toBe("justrefresh");
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "refresh_list_rules", arguments: {} } });
    const r = await waitReply(2);
    expect(r.result.structuredContent).toEqual({ echo: "listRules", client: { id: "test-agent", name: "Test Agent" } });
    expect(seen.map((s) => s.method)).toEqual(["pair", "listRules"]);
    mcp.kill();
    host.stdin.end();
    await new Promise((r) => host.on("exit", r));
    expect(existsSync(join(dir, "token"))).toBe(false);
  }, 15_000);

  it("rejects socket clients without the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "justrefresh-bridge-"));
    const host = spawn(process.execPath, ["bridge/justrefresh-bridge.mjs", "native-host"], { env: { ...process.env, JUSTREFRESH_BRIDGE_DIR: dir } });
    const net = await import("node:net");
    for (let i = 0; i < 100 && !existsSync(join(dir, "bridge.sock")); i++) await new Promise((r) => setTimeout(r, 25));
    const sock = net.createConnection(join(dir, "bridge.sock"));
    const msgs: any[] = [];
    sock.on(
      "data",
      createLineDecoder((m) => msgs.push(m)),
    );
    sock.write(JSON.stringify({ type: "hello", token: "nope", client: { id: "x" } }) + "\n");
    await new Promise((r) => sock.on("close", r));
    expect(msgs[0]).toEqual({ type: "error", error: "Invalid token" });
    host.stdin.end();
  });
});
