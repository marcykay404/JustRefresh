import { useState } from "react";
import { api } from "../shared/api";
import { useApi } from "../shared/hooks";
import { formatTime } from "../shared/format";
import { Empty, ErrorBox, Toggle } from "../shared/components";
import type { AgentRecord, AgentScope, ApprovalRequest, AuditEntry, Rule, Settings } from "../../core/types";

interface AgentsData {
  agents: AgentRecord[];
  approvals: ApprovalRequest[];
  allScopes: AgentScope[];
}

const DEFAULT_SCOPES: AgentScope[] = ["tabs:read", "rules:read", "rules:write", "rules:test", "rules:activate", "status:read"];

const SCOPE_HELP: Record<AgentScope, string> = {
  "tabs:read": "List open tabs (URLs redacted by default)",
  "rules:read": "List rules and discover capabilities",
  "rules:write": "Create and edit draft rules it owns",
  "rules:test": "Dry-run rules against tabs (no side effects)",
  "rules:activate": "Request activation / disable rules",
  "rules:delete": "Request deletion of rules it owns",
  "status:read": "Read rule status and history",
};

export function AgentsView() {
  const { data, error, reload } = useApi<AgentsData>("listAgents", undefined, { pollMs: 3000 });
  const audit = useApi<AuditEntry[]>("getAudit", undefined, { pollMs: 5000 });
  const rules = useApi<Rule[]>("listRules", undefined, { pollMs: 5000 });
  const overview = useApi<{ settings: Settings }>("getOverview");
  const bridge = useApi<{ connected: boolean; wanted: boolean }>("bridgeStatus", undefined, { pollMs: 3000 });
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

  return (
    <>
      <h1>Agent Integrations</h1>
      <p className="muted">
        External AI agents use the same Rule Management API as this dashboard. Agent-created rules are saved as disabled drafts; activation and deletion
        require your approval unless you grant an agent trusted activation. Access is revocable at any time.
      </p>
      <ErrorBox error={error ?? actionError} />

      <div className="card col">
        <h2>Pending approvals {pendingApprovals.length > 0 && <span className="badge">{pendingApprovals.length}</span>}</h2>
        {pendingApprovals.length === 0 ? (
          <span className="muted">Nothing waiting for approval.</span>
        ) : (
          pendingApprovals.map((a) => {
            const rule = ruleById.get(a.ruleId);
            return (
              <div key={a.id} className="info col">
                <div className="row">
                  <strong>{a.kind === "activate" ? "Activate" : "Delete"} rule “{rule?.name ?? a.ruleId}”</strong>
                  <span className="muted small">requested by {a.agentId} · {formatTime(a.createdAt)} · revision {a.ruleRevision}</span>
                  <span className="spacer" />
                  <a className="btn small" href={`#/builder/${a.ruleId}`} style={{ textDecoration: "none" }}>Review & test</a>
                  <button className="small primary" onClick={() => act("resolveApproval", { id: a.id, approve: true })}>Approve</button>
                  <button className="small danger" onClick={() => act("resolveApproval", { id: a.id, approve: false })}>Reject</button>
                </div>
                {rule && (
                  <details>
                    <summary className="small">Rule JSON</summary>
                    <pre>{JSON.stringify({ ...rule, meta: undefined }, null, 2)}</pre>
                  </details>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="card col">
        <h2>Connected agents</h2>
        {!data?.agents.length ? (
          <Empty>No agents have requested access yet.</Empty>
        ) : (
          data.agents.map((a) => <AgentCard key={a.id} agent={a} allScopes={data.allScopes} act={act} />)
        )}
      </div>

      <div className="card col">
        <h2>Local MCP bridge</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Optional. Lets local MCP clients (e.g. desktop AI agents) call the API through Chrome Native Messaging. Requires installing the bridge host from
          the <code>bridge/</code> folder (see docs/agent-integration.md). Communication is local-only; each MCP client must be approved here.
        </p>
        <div className="row">
          <Toggle
            checked={!!overview.data?.settings.nativeBridgeEnabled}
            label="Enable native bridge"
            onChange={(on) => {
              const ask = on ? chrome.permissions.request({ permissions: ["nativeMessaging"] }).catch(() => false) : Promise.resolve(true);
              void ask.then((granted) => { if (granted) void act("updateSettings", { nativeBridgeEnabled: on }); });
            }}
          />
          <span className={`pill pill-${bridge.data?.connected ? "ok" : "muted"}`}>{bridge.data?.connected ? "Connected" : "Not connected"}</span>
          <span className="small muted">Extension ID: <code>{chrome.runtime.id}</code></span>
        </div>
      </div>

      <div className="card col">
        <div className="row">
          <h2>Audit log</h2>
          <span className="spacer" />
          <button className="small" onClick={() => confirm("Clear the audit log?") && act("clearAudit", undefined)}>Clear</button>
        </div>
        {!audit.data?.length ? (
          <Empty>No agent operations recorded.</Empty>
        ) : (
          <table>
            <thead><tr><th>Time</th><th>Agent</th><th>Operation</th><th>Rule</th><th>Outcome</th><th>Detail</th></tr></thead>
            <tbody>
              {audit.data.slice(0, 300).map((e, i) => (
                <tr key={i}>
                  <td className="small">{formatTime(e.at)}</td>
                  <td className="small mono">{e.agentId}</td>
                  <td className="small">{e.operation}</td>
                  <td className="small mono">{e.ruleId ?? "—"}</td>
                  <td><span className={`pill pill-${e.outcome === "ok" ? "ok" : e.outcome === "pending_approval" ? "warn" : "error"}`}>{e.outcome}</span></td>
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

function AgentCard({ agent, allScopes, act }: { agent: AgentRecord; allScopes: AgentScope[]; act: (m: string, p: unknown) => Promise<void> }) {
  const [scopes, setScopes] = useState<AgentScope[]>(agent.status === "pending" ? DEFAULT_SCOPES : agent.scopes);
  return (
    <div className="info col">
      <div className="row">
        <strong>{agent.name}</strong>
        <code className="small">{agent.id}</code>
        <span className={`pill pill-${agent.status === "approved" ? "ok" : agent.status === "pending" ? "warn" : "muted"}`}>{agent.status}</span>
        <span className="small muted">via {agent.transport} · last seen {formatTime(agent.lastSeenAt)}</span>
        <span className="spacer" />
        {agent.status !== "revoked" && <button className="small danger" onClick={() => act("updateAgent", { id: agent.id, status: "revoked" })}>Revoke</button>}
        <button className="small" onClick={() => confirm("Remove this agent?") && act("removeAgent", { id: agent.id })}>Remove</button>
      </div>
      <div className="row small">
        {allScopes.map((s) => (
          <label key={s} title={SCOPE_HELP[s]} className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />
            {s}
          </label>
        ))}
      </div>
      <div className="row">
        <Toggle
          checked={agent.trustedActivation}
          label={<span className="small">Trusted activation <span className="muted">(activate/delete its own rules without per-request approval)</span></span>}
          onChange={(on) => (!on || confirm("Allow this agent to activate its rules without asking you each time?")) && act("updateAgent", { id: agent.id, trustedActivation: on })}
        />
        <span className="spacer" />
        <button className="small primary" onClick={() => act("updateAgent", { id: agent.id, status: "approved", scopes })}>
          {agent.status === "approved" ? "Save scopes" : "Approve with these scopes"}
        </button>
      </div>
    </div>
  );
}
