// Shared, dependency-free building blocks for the JustRefresh bridge.
// Kept pure so they can be unit tested (see tests/unit/bridge.test.ts).
import crypto from "node:crypto";

/* ---------------- Socket handshake ---------------- */
// Both sides prove they know the token without sending it: each signs the
// other's random challenge (HMAC-SHA256), labelled with its role so a proof
// can't be reflected back. A program that only pretends to be the bridge (for
// example one that took its Windows pipe name first) learns nothing it can use:
//   bridge → challenge · client → hello (its proof, its own challenge)
//   bridge → ready (its proof) · client → identify (agent id and name), then requests
// The MCP side says which agent it is, and sends its key, only after the
// bridge has proved itself.
export const newNonce = () => crypto.randomBytes(16).toString("hex");
export const proofOf = (token, role, nonce) => crypto.createHmac("sha256", token).update(`${role}:${nonce}`).digest("hex");
export function sameSecret(a, b) {
  return typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
/** A challenge nonce as sent by the other side: hex, of a sensible length. */
export const isNonce = (n) => typeof n === "string" && /^[0-9a-f]{16,128}$/.test(n);

/* ---------------- Chrome Native Messaging framing ---------------- */
// Each message: 4-byte little-endian length + UTF-8 JSON. Max 1 MB host→Chrome.
export const MAX_NATIVE_MESSAGE = 1024 * 1024;

export function encodeNative(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  if (body.length > MAX_NATIVE_MESSAGE) throw new Error("Native message too large");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder: feed chunks, get complete messages. */
export function createNativeDecoder(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > 64 * 1024 * 1024) throw new Error("Native message length out of range");
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len).toString("utf8");
      buf = buf.subarray(4 + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue; // one bad message from Chrome: skip it (the framing is still intact)
      }
      onMessage(msg);
    }
  };
}

/**
 * Newline-delimited JSON for the local socket and MCP stdio. A line that isn't
 * a JSON object, or one that grows past `maxLine`, is dropped and reported to
 * `onBad` instead of crashing the process.
 */
export function createLineDecoder(onMessage, maxLine = 4 * 1024 * 1024, onBad = () => undefined) {
  let buf = "";
  const parse = (line) => {
    try {
      const msg = JSON.parse(line);
      return msg && typeof msg === "object" && !Array.isArray(msg) ? msg : null;
    } catch {
      return null;
    }
  };
  return (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = parse(line);
      if (msg) onMessage(msg);
      else onBad("Not a JSON object");
    }
    if (buf.length > maxLine) {
      buf = "";
      onBad("Line too long");
    }
  };
}

/* ---------------- MCP tools ---------------- */
const ruleObject = { type: "object", description: "Rule JSON (see refresh_get_capabilities → ruleSchema)" };
const id = { type: "string", description: "Rule id" };
const tool = (name, method, description, properties = {}, required = []) => ({
  name,
  method,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
});

export const TOOLS = [
  tool(
    "refresh_get_capabilities",
    "getCapabilities",
    "Discover supported triggers, conditions, actions, limits and the full rule JSON Schema. Call this first.",
  ),
  tool("refresh_list_tabs", "listTabs", "List open browser tabs (id, title, URL; query strings redacted by default)."),
  tool("refresh_list_rules", "listRules", "List all rules."),
  tool("refresh_get_rule", "getRule", "Get one rule including meta.revision (needed for safe updates).", { id }, ["id"]),
  tool("refresh_validate_rule", "validateRule", "Validate a rule without saving. Returns diagnostics with JSON paths you can fix.", { rule: ruleObject }, [
    "rule",
  ]),
  tool(
    "refresh_test_rule",
    "testRule",
    "Dry-run a rule's conditions against a tab. No refresh, no actions, no side effects.",
    { rule: ruleObject, tabId: { type: "integer" } },
    ["rule", "tabId"],
  ),
  tool("refresh_create_rule", "createRule", "Save a rule as a disabled DRAFT. Use refresh_enable_rule to request activation.", { rule: ruleObject }, ["rule"]),
  tool(
    "refresh_update_rule",
    "updateRule",
    "Patch a rule you created. Pass expectedRevision to avoid overwriting concurrent edits. Updating returns the rule to draft state.",
    { id, patch: { type: "object" }, expectedRevision: { type: "integer" } },
    ["id", "patch"],
  ),
  tool("refresh_delete_rule", "deleteRule", "Delete a rule you created (active rules need user approval).", { id, expectedRevision: { type: "integer" } }, [
    "id",
  ]),
  tool("refresh_enable_rule", "enableRule", "Request activation. Usually returns pending_approval: the user approves in the extension.", { id }, ["id"]),
  tool("refresh_disable_rule", "disableRule", "Disable a rule.", { id }, ["id"]),
  tool("refresh_get_status", "getRuleStatus", "Execution status of a rule on each tab (status, next refresh, counts, last evaluation).", { id }, ["id"]),
  tool("refresh_get_history", "getHistory", "Recent execution history.", { limit: { type: "integer", minimum: 1, maximum: 500 }, ruleId: { type: "string" } }),
];

export const PROTOCOL_VERSION = "2025-06-18";

function checkArgs(t, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const props = t.inputSchema.properties;
  for (const k of Object.keys(args)) if (!(k in props)) throw new Error(`Unknown argument "${k}"`);
  for (const k of t.inputSchema.required) if (!(k in args)) throw new Error(`Missing required argument "${k}"`);
  return Object.keys(args).length ? args : undefined;
}

/**
 * Minimal MCP (JSON-RPC 2.0) request handler.
 * `callApi(method, params)` resolves to { ok, result } | { ok:false, error }.
 */
export function createMcpHandler({ callApi, serverName = "justrefresh", version = "0.1.0", onInitialize } = {}) {
  return async function handle(msg) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return msg?.id !== undefined ? { jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "Invalid request" } } : null;
    }
    const isNotification = msg.id === undefined || msg.id === null;
    const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, result });
    const fail = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, error: { code, message } });

    switch (msg.method) {
      case "initialize":
        await onInitialize?.(msg.params?.clientInfo ?? {});
        return reply({
          protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, version },
          instructions:
            "Controls the JustRefresh Chrome extension. Workflow: get capabilities → list tabs → validate → test (dry run) → create (draft) → enable (user approves in the extension) → get status.",
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS.map(({ method: _m, ...t }) => t) });
      case "tools/call": {
        const t = TOOLS.find((x) => x.name === msg.params?.name);
        if (!t) return fail(-32602, `Unknown tool "${msg.params?.name}"`);
        let params;
        try {
          params = checkArgs(t, msg.params?.arguments);
        } catch (e) {
          return reply({ isError: true, content: [{ type: "text", text: e.message }] });
        }
        try {
          const res = await callApi(t.method, params);
          if (!res?.ok) {
            const err = res?.error ?? { code: "internal", message: "No response" };
            const hint = err.code === "pairing_required" ? "\nOpen the extension dashboard → Agent Integrations and approve this agent." : "";
            return reply({ isError: true, content: [{ type: "text", text: JSON.stringify(err, null, 2) + hint }] });
          }
          return reply({ content: [{ type: "text", text: JSON.stringify(res.result, null, 2) }], structuredContent: wrap(res.result) });
        } catch (e) {
          return reply({ isError: true, content: [{ type: "text", text: `Bridge error: ${e.message}` }] });
        }
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  };
}

const wrap = (r) => (r && typeof r === "object" && !Array.isArray(r) ? r : { result: r });

export function sanitizeClientId(name) {
  return (
    String(name ?? "mcp-client")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .slice(0, 48) || "mcp-client"
  );
}
