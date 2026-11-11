#!/usr/bin/env node
// JustRefresh local bridge.
//
//   sar-bridge.mjs native-host   (started by Chrome via Native Messaging)
//   sar-bridge.mjs mcp           (started by an MCP client, stdio transport)
//
// Chrome ⇄ native-host ⇄ local socket (owner-only permissions + token) ⇄ mcp ⇄ agent.
// Nothing listens on a network port.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createLineDecoder, createMcpHandler, createNativeDecoder, encodeNative, sanitizeClientId } from "./lib.mjs";

const DIR = process.env.SAR_BRIDGE_DIR ?? path.join(os.homedir(), ".smart-auto-refresh");
const SOCKET = process.platform === "win32" ? `\\\\.\\pipe\\smart-auto-refresh-${os.userInfo().username}` : path.join(DIR, "bridge.sock");
const TOKEN_FILE = path.join(DIR, "token");
const log = (...a) => process.stderr.write(`[sar-bridge] ${a.join(" ")}\n`);

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(DIR, 0o700);
  } catch {
    /* windows */
  }
}

/* ------------------------------------------------------------------ */
/* Native host: started by Chrome, relays socket clients ⇄ extension   */
/* ------------------------------------------------------------------ */
function runNativeHost() {
  ensureDir();
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  if (process.platform !== "win32" && fs.existsSync(SOCKET)) fs.unlinkSync(SOCKET);

  const pending = new Map(); // relay id → { socket, id }
  let seq = 0;
  const toChrome = (msg) => process.stdout.write(encodeNative(msg));

  process.stdin.on(
    "data",
    createNativeDecoder((msg) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      const { id: _id, ...rest } = msg;
      p.socket.write(JSON.stringify({ id: p.id, ...rest }) + "\n");
    }),
  );
  process.stdin.on("end", () => {
    server.close();
    if (process.platform !== "win32") fs.rmSync(SOCKET, { force: true });
    fs.rmSync(TOKEN_FILE, { force: true });
    process.exit(0);
  });

  const server = net.createServer((socket) => {
    let client = null;
    socket.on(
      "data",
      createLineDecoder((msg) => {
        if (!client) {
          const ok =
            msg?.type === "hello" &&
            typeof msg.token === "string" &&
            msg.token.length === token.length &&
            crypto.timingSafeEqual(Buffer.from(msg.token), Buffer.from(token));
          if (!ok) {
            socket.end(JSON.stringify({ type: "error", error: "Invalid token" }) + "\n");
            return;
          }
          client = { id: sanitizeClientId(msg.client?.id ?? msg.client?.name), name: String(msg.client?.name ?? "MCP client").slice(0, 80) };
          socket.write(JSON.stringify({ type: "ready" }) + "\n");
          return;
        }
        const relayId = `r${++seq}`;
        pending.set(relayId, { socket, id: msg.id });
        toChrome({ id: relayId, client, method: String(msg.method), params: msg.params });
      }),
    );
    socket.on("error", () => undefined);
    socket.on("close", () => {
      for (const [k, v] of pending) if (v.socket === socket) pending.delete(k);
    });
  });
  server.listen(SOCKET, () => {
    if (process.platform !== "win32") fs.chmodSync(SOCKET, 0o600);
    log("native host listening (local socket)");
  });
}

/* ------------------------------------------------------------------ */
/* MCP server: stdio JSON-RPC ⇄ local socket                           */
/* ------------------------------------------------------------------ */
function runMcp() {
  let socket = null;
  let ready = null;
  let seq = 0;
  const waiting = new Map();
  let clientInfo = { name: process.env.SAR_AGENT_NAME ?? "MCP client" };

  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      let token;
      try {
        token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
      } catch {
        reject(new Error("The extension bridge is not running. In the extension: Dashboard → Agent Integrations → enable the native bridge."));
        return;
      }
      socket = net.createConnection(SOCKET);
      socket.on("error", (e) => {
        ready = null;
        reject(new Error(`Cannot reach the extension bridge: ${e.message}`));
      });
      socket.on("close", () => {
        ready = null;
        for (const w of waiting.values()) w({ ok: false, error: { code: "internal", message: "Bridge disconnected" } });
        waiting.clear();
      });
      socket.on(
        "data",
        createLineDecoder((msg) => {
          if (msg.type === "ready") return resolve();
          if (msg.type === "error") return reject(new Error(msg.error));
          const w = waiting.get(msg.id);
          if (w) {
            waiting.delete(msg.id);
            w(msg);
          }
        }),
      );
      socket.on("connect", () => {
        const id = process.env.SAR_AGENT_ID ?? clientInfo.name;
        socket.write(JSON.stringify({ type: "hello", token, client: { id, name: clientInfo.name } }) + "\n");
      });
    });
    return ready;
  }

  async function callApi(method, params) {
    await connect();
    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({ ok: false, error: { code: "internal", message: "Timed out waiting for the extension" } });
      }, 30_000);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  const handle = createMcpHandler({
    callApi,
    onInitialize: async (info) => {
      if (info?.name) clientInfo = { name: String(info.name) };
      // Register (pair) right away so the user sees the request.
      try {
        await callApi("pair");
      } catch (e) {
        log(e.message);
      }
    },
  });

  process.stdin.on(
    "data",
    createLineDecoder(async (msg) => {
      const res = await handle(msg);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    }),
  );
  process.stdin.on("end", () => process.exit(0));
}

const mode = process.argv[2];
// Chrome launches native hosts with the caller origin as an argument.
if (mode === "native-host" || (mode ?? "").startsWith("chrome-extension://")) runNativeHost();
else if (mode === "mcp") runMcp();
else {
  console.error("Usage: sar-bridge.mjs native-host | mcp");
  process.exit(2);
}
