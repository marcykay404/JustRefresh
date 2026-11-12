#!/usr/bin/env node
// JustRefresh local bridge.
//
//   justrefresh-bridge.mjs install --extension-id <id>   set it up (see install-lib.mjs)
//   justrefresh-bridge.mjs uninstall
//   justrefresh-bridge.mjs native-host   (started by Chrome via Native Messaging)
//   justrefresh-bridge.mjs mcp           (started by an MCP client, stdio transport)
//
// Chrome ⇄ native-host ⇄ local socket ⇄ mcp ⇄ agent. Nothing listens on a
// network port. The socket is owner-only (a per-user pipe on Windows); both
// ends prove they know a fresh token without sending it (lib.mjs), and each
// approved agent then identifies itself with its own key, issued by the
// extension on approval and kept in ~/.justrefresh/agents.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  appendEventLine,
  createLineDecoder,
  createMcpHandler,
  createNativeDecoder,
  DEFAULT_TIMEOUT_MS,
  encodeNative,
  eventsFilePath,
  isNonce,
  newNonce,
  proofOf,
  sameSecret,
  sanitizeClientId,
} from "./lib.mjs";
import { install, parseInstallArgs, restrictToUser, uninstall } from "./install-lib.mjs";

const DIR = process.env.JUSTREFRESH_BRIDGE_DIR ?? path.join(os.homedir(), ".justrefresh");
const isWin = process.platform === "win32";
const SOCKET = isWin ? `\\\\.\\pipe\\justrefresh-${os.userInfo().username}` : path.join(DIR, "bridge.sock");
const TOKEN_FILE = path.join(DIR, "token");
const log = (...a) => process.stderr.write(`[justrefresh-bridge] ${a.join(" ")}\n`);
const line = (msg) => JSON.stringify(msg) + "\n";
/** Handshake version: 2 = the client identifies itself only after the bridge's proof. */
const PROTOCOL = 2;
/** Both ends must finish the handshake within this time. */
const HANDSHAKE_MS = 10_000;

/** The folder holds the token and agent keys: only this user may read it (see restrictToUser). */
function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  restrictToUser(DIR, { log });
}

/* ------------------------------------------------------------------ */
/* Native host: started by Chrome, relays socket clients ⇄ extension   */
/* ------------------------------------------------------------------ */

/** Whether a client's hello proves it knows the token, for the challenge we sent. */
const admit = (msg, token, challenge) => msg?.type === "hello" && sameSecret(msg.proof, proofOf(token, "client", challenge)) && isNonce(msg.nonce);

/**
 * The client's id and name, sent only after it has checked our proof (so it
 * never tells a program squatting on the socket name which agent it is), or null.
 */
function identified(msg) {
  if (msg?.type !== "identify") return null;
  return { id: sanitizeClientId(msg.client?.id ?? msg.client?.name), name: String(msg.client?.name ?? "MCP client").slice(0, 80) };
}

function runNativeHost() {
  ensureDir();
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  if (!isWin && fs.existsSync(SOCKET)) fs.unlinkSync(SOCKET);

  const pending = new Map(); // relay id → { socket, id }
  let seq = 0;
  const toChrome = (msg) => process.stdout.write(encodeNative(msg));

  process.stdin.on(
    "data",
    createNativeDecoder((msg) => {
      if (msg?.type === "event") return writeEvent(msg);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      const { id: _id, ...rest } = msg;
      p.socket.write(line({ id: p.id, ...rest }));
    }),
  );
  process.stdin.on("end", () => {
    server.close();
    if (!isWin) fs.rmSync(SOCKET, { force: true });
    fs.rmSync(TOKEN_FILE, { force: true });
    process.exit(0);
  });

  // An agent's event, for its file (the extension sends these only with "write events to a file" on).
  const writeEvent = (msg) => {
    if (typeof msg.agent !== "string" || !msg.event || typeof msg.event !== "object") return;
    try {
      appendEventLine(DIR, msg.agent, msg.event, { log });
    } catch (e) {
      log(`Could not write an event to its file: ${e.message}`);
    }
  };

  const relay = (socket, client, msg) => {
    const relayId = `r${++seq}`;
    pending.set(relayId, { socket, id: msg.id });
    const key = typeof msg.key === "string" ? msg.key.slice(0, 128) : undefined;
    toChrome({ id: relayId, client: key ? { ...client, key } : client, method: String(msg.method), params: msg.params });
  };

  const server = net.createServer((socket) => {
    const challenge = newNonce();
    let proven = false;
    let closed = false;
    let client = null;
    // A client that doesn't finish the handshake (through identify) in time is dropped.
    const unproven = setTimeout(() => socket.destroy(), HANDSHAKE_MS);
    socket.write(line({ type: "challenge", nonce: challenge }));
    socket.on(
      "data",
      createLineDecoder(
        (msg) => {
          if (client) return relay(socket, client, msg);
          if (closed) return; // lines after a refusal in the same chunk
          if (proven) {
            client = identified(msg);
            if (client) return void clearTimeout(unproven);
            closed = true;
            return void socket.end(line({ type: "error", error: "Expected the client's identity" }));
          }
          if (!admit(msg, token, challenge)) {
            closed = true;
            return void socket.end(line({ type: "error", error: "Invalid token" }));
          }
          proven = true;
          // A client from before identify (it named itself in hello) still works.
          if (msg.client) client = identified({ type: "identify", client: msg.client });
          if (client) clearTimeout(unproven);
          socket.write(line({ type: "ready", v: PROTOCOL, proof: proofOf(token, "server", msg.nonce) }));
        },
        undefined,
        () => socket.destroy(), // garbage on the socket: drop that client
      ),
    );
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(unproven);
      for (const [k, v] of pending) if (v.socket === socket) pending.delete(k);
    });
  });
  server.on("error", (e) => {
    log(e.code === "EADDRINUSE" ? "Another program is using the bridge's socket name; not starting." : `Socket error: ${e.message}`);
    process.exit(1);
  });
  server.listen({ path: SOCKET, readableAll: false, writableAll: false }, () => {
    if (!isWin) fs.chmodSync(SOCKET, 0o600);
    log("native host listening (local socket)");
  });
}

/* ------------------------------------------------------------------ */
/* MCP server: stdio JSON-RPC ⇄ local socket                           */
/* ------------------------------------------------------------------ */

/** This agent's key from the extension (null until it has been approved and issued one). */
function agentKeys(agentId) {
  const file = () => path.join(DIR, "agents", `${sanitizeClientId(agentId())}.key`);
  return {
    read() {
      try {
        return fs.readFileSync(file(), "utf8").trim() || undefined;
      } catch {
        return undefined;
      }
    },
    save(key) {
      try {
        ensureDir();
        fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file(), key, { mode: 0o600 });
        if (!isWin) fs.chmodSync(file(), 0o600); // an existing file keeps its old mode otherwise
      } catch (e) {
        // Not fatal: until a key is used, the extension issues a new one on the next call.
        log(`Could not save this agent's key: ${e.message}`);
      }
    },
  };
}

function runMcp() {
  let socket = null;
  let ready = null;
  let seq = 0;
  const waiting = new Map();
  let clientInfo = { name: process.env.JUSTREFRESH_AGENT_NAME ?? "MCP client" };
  const agentId = () => process.env.JUSTREFRESH_AGENT_ID ?? clientInfo.name;
  const keys = agentKeys(agentId);

  function onMessage(msg, handshake) {
    if (msg.type) return handshake(msg);
    // A key from the extension is kept even if the call it came with already timed out.
    if (typeof msg.agentKey === "string" && /^[0-9a-f]{64}$/.test(msg.agentKey)) keys.save(msg.agentKey);
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    const { agentKey: _k, ...reply } = msg;
    w(reply);
  }

  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      let token;
      try {
        token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
      } catch {
        reject(new Error("The extension bridge is not running. In the extension: Dashboard → Agent Integrations → allow desktop AI apps to connect."));
        return;
      }
      const ours = newNonce();
      let proven = false;
      const fail = (message) => {
        socket.destroy();
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail("The bridge didn't answer in time."), HANDSHAKE_MS);
      const handshake = (msg) => {
        if (msg.type === "challenge" && isNonce(msg.nonce)) {
          return socket.write(line({ type: "hello", proof: proofOf(token, "client", msg.nonce), nonce: ours }));
        }
        clearTimeout(timer);
        if (msg.type === "ready" && sameSecret(msg.proof, proofOf(token, "server", ours)) && !(msg.v >= PROTOCOL)) {
          // An older bridge, still running in Chrome after an update: it doesn't know identify.
          return fail(
            "The JustRefresh bridge running in Chrome is older than this one. Turn desktop apps off and on in JustRefresh → Agent Integrations, or restart Chrome.",
          );
        }
        if (msg.type === "ready" && sameSecret(msg.proof, proofOf(token, "server", ours))) {
          proven = true;
          // Only now, talking to JustRefresh's own bridge, say which agent this is.
          socket.write(line({ type: "identify", client: { id: agentId(), name: clientInfo.name } }));
          return resolve();
        }
        fail(msg.type === "error" ? msg.error : "The bridge couldn't prove it is JustRefresh's; not connecting.");
      };
      socket = net.createConnection(SOCKET);
      socket.on("error", (e) => {
        ready = null;
        clearTimeout(timer);
        reject(new Error(`Cannot reach the extension bridge: ${e.message}`));
      });
      socket.on("close", () => {
        ready = null;
        clearTimeout(timer);
        if (!proven) reject(new Error("The bridge closed the connection before it was ready."));
        for (const w of waiting.values()) w({ ok: false, error: { code: "internal", message: "Bridge disconnected" } });
        waiting.clear();
      });
      socket.on(
        "data",
        createLineDecoder((msg) => onMessage(msg, handshake)),
      );
    });
    return ready;
  }

  async function callApi(method, params, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    await connect();
    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({ ok: false, error: { code: "internal", message: "Timed out waiting for the extension" } });
      }, timeoutMs);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      socket.write(line({ id, method, params, key: keys.read() }));
    });
  }

  const handle = createMcpHandler({
    callApi,
    eventsFile: () => eventsFilePath(DIR, agentId()),
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
    createLineDecoder(
      async (msg) => {
        const res = await handle(msg);
        if (res) process.stdout.write(line(res));
      },
      undefined,
      (why) => process.stdout.write(line({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${why}` } })),
    ),
  );
  process.stdin.on("end", () => process.exit(0));
}

function runInstall(argv) {
  try {
    if (argv[0] === "uninstall") uninstall();
    else install({ ...parseInstallArgs(argv), sourceDir: path.dirname(fileURLToPath(import.meta.url)), entry: fileURLToPath(import.meta.url) });
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}

const mode = process.argv[2];
// Chrome launches native hosts with the caller origin as an argument.
if (mode === "native-host" || (mode ?? "").startsWith("chrome-extension://")) runNativeHost();
else if (mode === "mcp") runMcp();
else if (mode === "install" || mode === "uninstall") runInstall(process.argv.slice(2));
else {
  console.error("Usage: justrefresh-bridge.mjs install --extension-id <id> | uninstall | native-host | mcp");
  process.exit(2);
}
