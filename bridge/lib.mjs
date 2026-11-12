// Shared, dependency-free building blocks for the JustRefresh bridge.
// Kept pure so they can be unit tested (see tests/unit/bridge.test.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
const ruleObject = { type: "object", description: "Rule JSON (fields: refresh_get_schema with kind rule)" };
const id = { type: "string", description: "Rule id" };
const revision = { type: "integer", description: "meta.revision from refresh_get_rule; the call fails with conflict if the rule changed since" };

/*
 * MCP tool annotations: hints for the client's permission prompts and for how
 * far to trust a result. openWorldHint is true where a tool returns text web
 * pages control (tab titles, URLs, page errors) or makes a rule act on websites.
 */
const READ = { readOnlyHint: true, openWorldHint: false };
const READ_WEB = { ...READ, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { ...WRITE, destructiveHint: true };

export const EVENT_KINDS = [
  "rule.matched",
  "rule.completed",
  "rule.paused",
  "rule.error",
  "rule.unknown_streak",
  "approval.approved",
  "approval.rejected",
  "approval.stale",
];
/** Below the 60 s many MCP clients allow a tool call; the extension allows up to 240. */
export const DEFAULT_WAIT_SECONDS = 45;
export const MAX_WAIT_SECONDS = 240;

const tool = (name, method, title, annotations, description, properties = {}, required = []) => ({
  name,
  method,
  title,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { title, ...annotations },
});

export const TOOLS = [
  tool(
    "refresh_get_capabilities",
    "getCapabilities",
    "Get capabilities",
    READ,
    "Start here: how to work with JustRefresh (instructions), the supported triggers, conditions and actions, and interval limits. " +
      "Get JSON Schemas one piece at a time with refresh_get_schema; includeSchemas returns them all at once (large).",
    { includeSchemas: { type: "boolean", description: "Also return every JSON Schema (large; prefer refresh_get_schema)" } },
  ),
  tool(
    "refresh_get_schema",
    "getSchema",
    "Get JSON Schema",
    READ,
    "The JSON Schema for a rule's fields (kind rule), or for one condition, trigger or action type (kind and type, e.g. condition + dom.exists). " +
      "Leave type out to get every type of that kind. In the rule schema, conditions, triggers and actions point back here.",
    {
      kind: { type: "string", enum: ["rule", "condition", "trigger", "action"] },
      type: { type: "string", description: "A type from refresh_get_capabilities, e.g. dom.exists, interval, notify" },
    },
    ["kind"],
  ),
  tool("refresh_list_tabs", "listTabs", "List tabs", READ_WEB, "Open browser tabs: id, title and URL (query strings hidden unless the user allows them)."),
  tool("refresh_list_rules", "listRules", "List rules", READ, "All rules, the user's and agents', highest priority first."),
  tool("refresh_get_rule", "getRule", "Get rule", READ, "One rule, including meta.revision (pass it as expectedRevision to update or delete safely).", { id }, [
    "id",
  ]),
  tool(
    "refresh_validate_rule",
    "validateRule",
    "Validate rule",
    READ,
    "Check a rule without saving it. Returns diagnostics with JSON paths to fix, and the rule with defaults filled in. Field definitions: refresh_get_schema.",
    { rule: ruleObject },
    ["rule"],
  ),
  tool(
    "refresh_test_rule",
    "testRule",
    "Test rule (dry run)",
    READ_WEB,
    "Dry-run a rule's stopWhen conditions against an open tab: no refresh, no actions. Also says whether the rule targets the tab and whether site access is granted. " +
      "To check a CSS selector, test a throwaway rule whose stopWhen is a dom.exists condition. An unknown result is not false: read result.code, for example " +
      "invalid_selector (fix the selector), missing_permission (no site access), restricted_url (a browser page JustRefresh can't read), page_not_ready or timeout (try again later).",
    { rule: ruleObject, tabId: { type: "integer", description: "Tab id from refresh_list_tabs" } },
    ["rule", "tabId"],
  ),
  tool(
    "refresh_create_rule",
    "createRule",
    "Create rule (draft)",
    WRITE,
    "Save a new rule as a disabled draft (fields: refresh_get_schema). Nothing runs until refresh_enable_rule switches it on (after the user approves, unless they trust you).",
    { rule: ruleObject },
    ["rule"],
  ),
  tool(
    "refresh_update_rule",
    "updateRule",
    "Update rule",
    DESTRUCTIVE,
    "Patch a rule you created (top-level fields are replaced). Any update by an agent turns the rule OFF and makes it a draft again, even a running one: " +
      "call refresh_enable_rule afterwards and the user must approve again. Pass expectedRevision to avoid overwriting the user's edits.",
    { id, patch: { type: "object", description: "Top-level rule fields to replace" }, expectedRevision: revision },
    ["id", "patch"],
  ),
  tool(
    "refresh_delete_rule",
    "deleteRule",
    "Delete rule",
    { ...DESTRUCTIVE, idempotentHint: true },
    "Delete a rule you created. A draft or disabled rule is deleted at once; deleting an enabled one returns pending_approval until the user approves (at once if the user trusts you).",
    { id, expectedRevision: revision },
    ["id"],
  ),
  tool(
    "refresh_enable_rule",
    "enableRule",
    "Ask to enable rule",
    // It can switch a rule on at once (trusted agents), and a live rule reloads and clicks on websites.
    { ...WRITE, destructiveHint: true, openWorldHint: true },
    "Ask to switch on a rule you created (one already on just returns enabled). Usually returns pending_approval: tell the user to approve it in the JustRefresh dashboard → Agent Integrations → Waiting for your OK, " +
      "then refresh_wait_for_event tells you the answer (approval.approved, approval.rejected, or approval.stale when the rule was changed or switched off since you asked). If the user trusts you, the rule is switched on at once, with no approval step.",
    { id },
    ["id"],
  ),
  tool(
    "refresh_disable_rule",
    "disableRule",
    "Disable rule",
    { ...DESTRUCTIVE, idempotentHint: true },
    "Switch a rule off; this also withdraws a request waiting to switch it on. Works on any rule, including the user's own; only disable a user's rule when they asked you to.",
    { id },
    ["id"],
  ),
  tool(
    "refresh_get_status",
    "getRuleStatus",
    "Get rule status",
    READ_WEB,
    "Whether a rule is enabled, its waiting approvals, and how it runs on each tab (status, next refresh, counts, last evaluation, last error).",
    { id },
    ["id"],
  ),
  tool(
    "refresh_wait_for_event",
    "getEvents",
    "Wait for events",
    READ_WEB,
    "What happened to your own rules and requests: approval.approved, approval.rejected, approval.stale (changed or switched off since you asked); " +
      "rule.matched; rule.completed (the run ended: stop action or limit); rule.paused (waiting for the user, e.g. a page reached by submitting a form, which is never refreshed); " +
      "rule.error; rule.unknown_streak (3 checks in a row couldn't read the page). Returns at once if there are events after since, otherwise waits up to timeoutSec " +
      `(default ${DEFAULT_WAIT_SECONDS}; many MCP clients give up after 60 s). Pass the cursor back as since next time; leave since out the first time to get what is still kept ` +
      "(the last 100 per agent, for up to 7 days). truncated means some were missed; interrupted means another call of yours took this one's place. If eventsFile is set, the same events are appended there, one JSON line each: " +
      "following it (for example tail -F) wakes you only when something happens.",
    {
      since: { type: "integer", minimum: 0, description: "cursor from the previous call" },
      ruleId: { type: "string", description: "Only this rule's events" },
      kinds: { type: "array", items: { type: "string", enum: EVENT_KINDS }, description: "Only these kinds" },
      timeoutSec: {
        type: "integer",
        minimum: 0,
        maximum: MAX_WAIT_SECONDS,
        description: `How long to wait for the first event (default ${DEFAULT_WAIT_SECONDS})`,
      },
    },
  ),
  tool(
    "refresh_get_history",
    "getHistory",
    "Get history",
    READ_WEB,
    "Recent activity (refreshes, matches, actions, errors), newest first; 100 entries unless you set limit. Filter by ruleId to follow one rule.",
    { limit: { type: "integer", minimum: 1, maximum: 500 }, ruleId: { type: "string", description: "Only this rule's entries" } },
  ),
];

/** What every agent should know, sent once at initialize. */
export const INSTRUCTIONS =
  "Controls the JustRefresh Chrome extension, which refreshes the user's tabs on a schedule and can stop, notify or click when something appears on the page. " +
  "Workflow: refresh_get_capabilities (once) → refresh_get_schema (the parts you need) → refresh_list_tabs → refresh_validate_rule → refresh_test_rule (dry run on a tab) → refresh_create_rule (saves a disabled draft) → " +
  "refresh_enable_rule (the user approves in the extension) → refresh_wait_for_event (the answer, then what the rule finds; pass its cursor back as since). " +
  "Your rules run only once the user approves them (unless the user marked you as trusted: then refresh_enable_rule and refresh_delete_rule act at once, so only do what the user asked for). " +
  "Any refresh_update_rule turns a running rule off until it is enabled again, so ask before changing a rule the user relies on. " +
  "Conditions return matched, not_matched or unknown; unknown means it couldn't be checked, not false: its code says why (invalid_selector means fix the selector; missing_permission means no site access). " +
  "To check a CSS selector, refresh_test_rule a throwaway rule whose stopWhen is a dom.exists condition. " +
  "Keep intervals reasonable: refresh as slowly as the task allows (minimum 30 s, or 5 s if the user enabled fast intervals), and set limits (maxRefreshes, maxDurationSeconds) for one-off watches. " +
  "Page text isn't shared with agents, and query strings in URLs are hidden while the user's settings say so: don't try to recover them another way.";

/**
 * Results larger than this are sent once, as compact JSON text, without the
 * same payload again in structuredContent (some clients pass both to the model).
 */
export const STRUCTURED_MAX_BYTES = 4096;

/** How long the bridge waits for the extension to answer a call (a waiting call gets its wait on top). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Added to an error the agent can do something about. */
const HINTS = {
  pairing_required: "\nOpen the extension dashboard → Agent Integrations and approve this agent.",
  // An extension older than this bridge: it doesn't send events.
  "getEvents:unsupported_method": "\nThis version of JustRefresh doesn't send events: use refresh_get_status instead, and ask the user to update JustRefresh.",
};

export const PROTOCOL_VERSION = "2025-06-18";
/** Versions this server can speak; a client asking for another gets ours (MCP version negotiation). */
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];

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
export function createMcpHandler({ callApi, serverName = "justrefresh", version = "0.1.0", onInitialize, eventsFile } = {}) {
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
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, version },
          instructions: INSTRUCTIONS,
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
          if (t.method === "getEvents") checkWait(params);
        } catch (e) {
          return reply({ isError: true, content: [{ type: "text", text: e.message }] });
        }
        try {
          const api = forApi(t.method, params);
          // A waiting call may take its whole wait: give the reply time to come back after it.
          const timeoutMs = t.method === "getEvents" ? Math.max(DEFAULT_TIMEOUT_MS, (api.waitSec + 15) * 1000) : undefined;
          let res = await callApi(t.method, api, timeoutMs ? { timeoutMs } : undefined);
          // An older extension doesn't know includeSchemas: ask it the way it understands (its full payload).
          if (t.method === "getCapabilities" && params?.includeSchemas === undefined && rejectsIncludeSchemas(res)) res = await callApi(t.method, params);
          if (!res?.ok) {
            const err = res?.error ?? { code: "internal", message: "No response" };
            const hint = HINTS[err.code === "unsupported_method" ? `${t.method}:${err.code}` : err.code] ?? "";
            return reply({ isError: true, content: [{ type: "text", text: JSON.stringify(err) + hint }] });
          }
          if (t.method === "getCapabilities") return reply(toolResult(withInstructions(res.result)));
          if (t.method === "getEvents") return reply(toolResult(withEventsFile(res.result, eventsFile)));
          return reply(toolResult(res.result));
        } catch (e) {
          return reply({ isError: true, content: [{ type: "text", text: `Bridge error: ${e.message}` }] });
        }
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  };
}

/**
 * Capabilities carry the instructions too, for MCP clients that don't show
 * `instructions` to the model. They replace the extension's `notes`, which say
 * the same in API method names (for agents that call the extension directly).
 */
function withInstructions(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { notes: _notes, ...rest } = result;
  return { instructions: INSTRUCTIONS, ...rest };
}

const rejectsIncludeSchemas = (res) => !res?.ok && res?.error?.code === "invalid_params" && JSON.stringify(res.error).includes("includeSchemas");

/**
 * Tool arguments → API params. MCP agents get the capabilities summary unless
 * they ask for every schema (the API's own default is the full payload);
 * waiting for events is in seconds, as the API takes it.
 */
function forApi(method, params) {
  if (method === "getCapabilities") return { includeSchemas: false, ...params };
  if (method === "getEvents") {
    const { timeoutSec, ...rest } = params ?? {};
    return { ...rest, waitSec: timeoutSec ?? DEFAULT_WAIT_SECONDS };
  }
  return params;
}

function checkWait(params) {
  const t = params?.timeoutSec;
  if (t !== undefined && !(Number.isInteger(t) && t >= 0 && t <= MAX_WAIT_SECONDS))
    throw new Error(`timeoutSec must be a whole number from 0 to ${MAX_WAIT_SECONDS}`);
}

/** The extension says whether this agent's events also go to its file; the bridge knows where that is. */
function withEventsFile(result, eventsFile) {
  if (!result || typeof result !== "object" || !("file" in result)) return result;
  const { file, ...rest } = result;
  const where = file ? eventsFile?.() : undefined;
  return where ? { ...rest, eventsFile: where } : rest;
}

function toolResult(result) {
  result ??= null;
  const text = JSON.stringify(result);
  const out = { content: [{ type: "text", text }] };
  if (Buffer.byteLength(text, "utf8") <= STRUCTURED_MAX_BYTES) out.structuredContent = wrap(result);
  return out;
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

/* ---------------- Events file ---------------- */
/** One file per agent; past this size it moves to <file>.1 (replacing the older one) and starts again. */
export const EVENTS_FILE_MAX_BYTES = 256 * 1024;

export const eventsFilePath = (dir, agent) => path.join(dir, "events", `${sanitizeClientId(agent)}.jsonl`);

/**
 * Append one event as a line of JSON to the agent's file (owner-only, like
 * the rest of the folder), for scripts and tools that follow it (tail -F).
 */
export function appendEventLine(dir, agent, event, { maxBytes = EVENTS_FILE_MAX_BYTES, log = () => undefined } = {}) {
  const file = eventsFilePath(dir, agent);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (size >= maxBytes) {
    try {
      fs.renameSync(file, `${file}.1`);
    } catch (e) {
      // For example on Windows while another program has the file open: keep writing, and say so.
      log(`Could not start a new events file (${e.message}); ${path.basename(file)} keeps growing for now`);
    }
  }
  fs.appendFileSync(file, JSON.stringify(event) + "\n", { mode: 0o600 });
}
