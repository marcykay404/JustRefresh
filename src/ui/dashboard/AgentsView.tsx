import { useState } from "react";
import { api } from "../shared/api";
import { useApi } from "../shared/hooks";
import { formatTime } from "../shared/format";
import { Empty, ErrorBox, Toggle } from "../shared/components";
import type { AgentRecord, AgentScope, ApprovalRequest, AuditEntry, Rule, Settings } from "../../core/types";
import { useDialog } from "../shared/dialog";
import { describeRule } from "../popup/describe";
import { matchesAny, patternToString } from "../../core/url-pattern";

interface AgentsData {
  agents: AgentRecord[];
  approvals: ApprovalRequest[];
  allScopes: AgentScope[];
}

/** Nothing is pre-selected: the user grants each permission deliberately. */
const DEFAULT_SCOPES: AgentScope[] = [];

/** Plain-language permission labels; the API scope name is kept as a tooltip. */
const SCOPE_LABEL: Record<AgentScope, string> = {
  "tabs:read": "See your open tabs (page addresses hide query strings by default)",
  "rules:read": "See your rules",
  "rules:write": "Create and edit its own rules (they're saved switched off)",
  "rules:test": "Test rules against your tabs (nothing is refreshed)",
  "rules:activate": "Ask to switch its rules on or off",
  "rules:delete": "Ask to delete its own rules",
  "status:read": "See rule status and history",
};

const STATUS_LABEL: Record<AgentRecord["status"], string> = { pending: "Waiting for approval", approved: "Approved", revoked: "Access revoked" };
const TRANSPORT_LABEL: Record<AgentRecord["transport"], string> = { native: "desktop app (MCP bridge)", extension: "browser extension", internal: "built in" };

/** "createRule" → "Create rule". */
export const operationLabel = (op: string) => {
  if (op === "pair") return "Ask to connect";
  const words = op.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const OUTCOME_LABEL: Record<AuditEntry["outcome"], string> = { ok: "Done", pending_approval: "Waiting for your OK", denied: "Refused", error: "Failed" };

export function AgentsView() {
  const dialog = useDialog();
  const { data, error, reload } = useApi<AgentsData>("listAgents", undefined, { pollMs: 3000 });
  const audit = useApi<AuditEntry[]>("getAudit", undefined, { pollMs: 5000 });
  const rules = useApi<Rule[]>("listRules", undefined, { pollMs: 5000 });
  const overview = useApi<{ settings: Settings }>("getOverview");
  const bridge = useApi<{ connected: boolean; wanted: boolean; restartRequired: boolean }>("bridgeStatus", undefined, { pollMs: 3000 });
  const [actionError, setActionError] = useState<unknown>(null);

  const act = async (method: string, params: unknown) => {
    setActionError(null);
    try {
      await api(method, params);
      await Promise.all([reload(), audit.reload(), rules.reload(), overview.reload()]);
    } catch (e) {
      setActionError(e);
    }
  };

  const pendingApprovals = data?.approvals.filter((a) => a.status === "pending") ?? [];
  const ruleById = new Map((rules.data ?? []).map((r) => [r.id, r]));
  const pendingAgents = data?.agents.filter((a) => a.status === "pending").length ?? 0;
  const agentName = (id: string) => data?.agents.find((a) => a.id === id)?.name ?? id;

  return (
    <>
      <h1>Agent Integrations</h1>
      <p className="muted">
        AI agents, such as AI apps on your computer or other browser extensions, can set up refresh rules for you. Nothing they do takes effect on its
        own: rules they create are saved switched off, and switching a rule on or deleting it waits for your OK here, unless you choose to trust that
        agent. You can take an agent's access away at any time.
      </p>
      <ErrorBox error={error ?? actionError} />

      <div className="card col">
        <h2>Waiting for your OK {pendingApprovals.length > 0 && <span className="badge">{pendingApprovals.length}</span>}</h2>
        {pendingApprovals.length === 0 ? (
          <span className="muted">
            {pendingAgents > 0
              ? `No rule changes are waiting. ${pendingAgents === 1 ? "1 agent is" : `${pendingAgents} agents are`} asking to connect: see Agents below.`
              : "Nothing is waiting for your OK."}
          </span>
        ) : (
          pendingApprovals.map((a) => {
            const rule = ruleById.get(a.ruleId);
            return (
              <div key={a.id} className="info col">
                <div className="row">
                  <strong>{a.kind === "activate" ? "Switch on" : "Delete"} rule “{rule?.name ?? a.ruleId}”</strong>
                  <span className="muted small" title={`Rule version ${a.ruleRevision}`}>asked by {agentName(a.agentId)} · {formatTime(a.createdAt)}</span>
                  <span className="spacer" />
                  <a className="btn small" href={`#/builder/${a.ruleId}`} style={{ textDecoration: "none" }}>Review & test</a>
                  <button className="small primary" onClick={() => act("resolveApproval", { id: a.id, approve: true })}>Approve</button>
                  <button className="small danger" onClick={() => act("resolveApproval", { id: a.id, approve: false })}>Reject</button>
                </div>
                {rule && <RuleInWords rule={rule} />}
                {rule && (
                  <details>
                    <summary className="small">Show the rule's full definition (JSON)</summary>
                    <pre>{JSON.stringify({ ...rule, meta: undefined }, null, 2)}</pre>
                  </details>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="card col">
        <h2>Agents</h2>
        {!data?.agents.length ? (
          <Empty>No agents have asked for access yet.</Empty>
        ) : (
          data.agents.map((a) => <AgentCard key={a.id} agent={a} allScopes={data.allScopes} act={act} />)
        )}
      </div>

      <AllowedExtensions ids={overview.data?.settings.allowedExtensionIds ?? []} save={(ids) => act("updateSettings", { allowedExtensionIds: ids })} />

      <div className="card col">
        <h2>Desktop AI apps (MCP bridge)</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Optional. Lets AI apps on this computer that support MCP (Model Context Protocol) connect to JustRefresh. It needs a small helper program
          installed from the <code>bridge/</code> folder; see <code>docs/agent-integration.md</code>. Everything stays on this computer, and each app has to
          be approved above before it can do anything.
        </p>
        <div className="row">
          <Toggle
            checked={!!overview.data?.settings.nativeBridgeEnabled}
            label="Allow desktop AI apps to connect"
            onChange={(on) => {
              const ask = on ? chrome.permissions.request({ permissions: ["nativeMessaging"] }).catch(() => false) : Promise.resolve(true);
              void ask.then((granted) => { if (granted) void act("updateSettings", { nativeBridgeEnabled: on }); });
            }}
          />
          <span className={`pill pill-${bridge.data?.connected ? "ok" : "muted"}`}>{bridge.data?.connected ? "Connected" : "Not connected"}</span>
          <span className="small muted">Extension ID (used when installing the helper): <code>{chrome.runtime.id}</code></span>
        </div>
        {bridge.data?.restartRequired && (
          <div className="row">
            <span className="small">
              One more step: Chrome only allows this connection after JustRefresh restarts. Your rules and schedules are kept; open JustRefresh pages
              (like this one) will close.
            </span>
            <button className="small primary" onClick={() => chrome.runtime.reload()}>
              Restart JustRefresh
            </button>
          </div>
        )}
      </div>

      <div className="card col">
        <div className="row">
          <h2>Activity log</h2>
          <span className="spacer" />
          <button className="small" onClick={async () =>
              (await dialog.confirm({ title: "Clear the activity log?", message: "The record of what agents asked JustRefresh to do is deleted.", confirmLabel: "Clear log", danger: true })) &&
              act("clearAudit", undefined)
            }>Clear</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Everything agents have asked JustRefresh to do, newest first.</p>
        {!audit.data?.length ? (
          <Empty>No agent activity yet.</Empty>
        ) : (
          <table>
            <thead><tr><th>Time</th><th>Agent</th><th>Request</th><th>Rule</th><th>Result</th><th>Details</th></tr></thead>
            <tbody>
              {audit.data.slice(0, 300).map((e, i) => (
                <tr key={i}>
                  <td className="small">{formatTime(e.at)}</td>
                  <td className="small" title={e.agentId}>{agentName(e.agentId)}</td>
                  <td className="small" title={e.operation}>{operationLabel(e.operation)}</td>
                  <td className="small" title={e.ruleId}>{e.ruleId ? (ruleById.get(e.ruleId)?.name ?? e.ruleId) : "—"}</td>
                  <td><span className={`pill pill-${e.outcome === "ok" ? "ok" : e.outcome === "pending_approval" ? "warn" : "error"}`}>{OUTCOME_LABEL[e.outcome] ?? e.outcome}</span></td>
                  <td className="small muted">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/** Extensions allowed to call the agent API (empty = none; others are rejected before pairing). */
function AllowedExtensions({ ids, save }: { ids: string[]; save: (ids: string[]) => Promise<void> }) {
  const [draft, setDraft] = useState("");
  const candidate = draft.trim().toLowerCase();
  const valid = /^[a-p]{32}$/.test(candidate);
  return (
    <div className="card col">
      <h2>Browser extensions that may connect</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Another browser extension can act as an agent only if you add its ID here, and it still has to be approved above before it can do anything. To
        find an extension's ID, open <code>chrome://extensions</code> and turn on Developer mode.
      </p>
      {ids.length === 0 ? (
        <span className="small muted">None added. Other extensions can't connect.</span>
      ) : (
        ids.map((id) => (
          <div key={id} className="row">
            <code>{id}</code>
            <span className="spacer" />
            <button className="small" onClick={() => void save(ids.filter((x) => x !== id))}>Remove</button>
          </div>
        ))
      )}
      <div className="row">
        <input aria-label="Extension ID" placeholder="32-letter extension ID" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ minWidth: 300 }} />
        <button className="small" disabled={!valid || ids.includes(candidate)} onClick={() => void save([...ids, candidate]).then(() => setDraft(""))}>Add</button>
        {draft && !valid && <span className="small muted">An extension ID is 32 letters, each from a to p.</span>}
      </div>
    </div>
  );
}

function AgentCard({ agent, allScopes, act }: { agent: AgentRecord; allScopes: AgentScope[]; act: (m: string, p: unknown) => Promise<void> }) {
  const [scopes, setScopes] = useState<AgentScope[]>(agent.status === "pending" ? DEFAULT_SCOPES : agent.scopes);
  const dialog = useDialog();
  return (
    <div className="info col">
      <div className="row">
        <strong>{agent.name}</strong>
        <code className="small">{agent.id}</code>
        <span className={`pill pill-${agent.status === "approved" ? "ok" : agent.status === "pending" ? "warn" : "muted"}`}>{STATUS_LABEL[agent.status]}</span>
        <span className="small muted">{TRANSPORT_LABEL[agent.transport]} · last seen {formatTime(agent.lastSeenAt)}</span>
        <span className="spacer" />
        {/* Kept together so the buttons wrap as a pair, never one per line. */}
        <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
        {agent.status !== "revoked" && (
          <button className="small danger" title="Keep it listed but refuse everything it asks; you can approve it again later" onClick={() => act("updateAgent", { id: agent.id, status: "revoked" })}>
            {agent.status === "pending" ? "Decline" : "Revoke access"}
          </button>
        )}
        <button className="small" onClick={async () =>
            (await dialog.confirm({
              title: `Remove ${agent.name}?`,
              message: "It loses access to JustRefresh and has to ask for approval again to reconnect.",
              confirmLabel: "Remove agent",
              danger: true,
            })) && act("removeAgent", { id: agent.id })
          }>Remove</button>
        </span>
      </div>
      <div className="col small" style={{ gap: 4 }}>
        <strong>{agent.status === "pending" ? "What may this agent do?" : "This agent may:"}</strong>
        {allScopes.map((s) => (
          <label key={s} title={s} className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />
            {SCOPE_LABEL[s] ?? s}
          </label>
        ))}
      </div>
      <div className="row">
        <Toggle
          checked={agent.trustedActivation}
          label={<span className="small">Trust this agent <span className="muted">(switch on and delete its own rules without asking me each time)</span></span>}
          onChange={async (on) =>
            (!on ||
              (await dialog.confirm({
                title: `Trust ${agent.name} to activate rules?`,
                message: "Its rules will start refreshing without asking you each time. You can turn this off again here.",
                confirmLabel: "Trust agent",
              }))) &&
            act("updateAgent", { id: agent.id, trustedActivation: on })
          }
        />
        <span className="spacer" />
        {agent.status === "pending" && scopes.length === 0 && <span className="small muted">Tick at least one thing it may do.</span>}
        <button
          className="small primary"
          disabled={agent.status === "pending" && scopes.length === 0}
          onClick={() => act("updateAgent", { id: agent.id, status: "approved", scopes })}
        >
          {agent.status === "approved" ? "Save changes" : "Approve"}
        </button>
      </div>
    </div>
  );
}

/** What an agent's rule would do, in words, so it can be approved without reading JSON. */
export function RuleInWords({ rule }: { rule: Rule }) {
  const pages = rule.target.patterns.map(patternToString);
  const except = (rule.target.exclusions ?? []).map(patternToString);
  const limits = rule.limits ?? {};
  const extras = [
    rule.schedule && (rule.schedule.startTime || rule.schedule.days?.length) ? "only during its active hours" : null,
    limits.maxRefreshes ? `at most ${limits.maxRefreshes} refreshes` : null,
    limits.maxDurationSeconds ? `stops after ${Math.round(limits.maxDurationSeconds / 60)} min` : null,
    limits.stopAt ? `stops at ${formatTime(Date.parse(limits.stopAt))}` : null,
  ].filter(Boolean);
  return (
    <div className="col small rule-in-words" style={{ gap: 4 }}>
      <span>{describeRule(rule)}{extras.length ? ` (${extras.join(", ")})` : ""}.</span>
      <span>
        On {pages.length === 1 ? "pages matching" : "pages matching any of"}{" "}
        {pages.map((p, i) => (
          <span key={i}>
            {i > 0 && ", "}
            <code>{p}</code>
          </span>
        ))}
        {except.length > 0 && (
          <>
            {", except "}
            {except.map((p, i) => (
              <span key={i}>
                {i > 0 && ", "}
                <code>{p}</code>
              </span>
            ))}
          </>
        )}
        .
      </span>
      {matchesEverySite(rule) && (
        <span className="warn-text">This rule can run on every website.</span>
      )}
    </div>
  );
}

/** Whether a rule's pages include unrelated sites (a catch-all glob, domain or regex). */
function matchesEverySite(rule: Rule): boolean {
  try {
    return ["https://unrelated-a.example/x", "http://unrelated-b.test/"].every((u) => matchesAny(rule.target.patterns, u) !== null);
  } catch {
    return false;
  }
}
