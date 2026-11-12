import { useState } from "react";
import { api } from "../shared/api";
import { useApi } from "../shared/hooks";
import { formatTime } from "../shared/format";
import { Empty, ErrorBox, Toggle } from "../shared/components";
import type { AgentRecord, AgentScope, ApprovalRequest, AuditEntry, Rule, Settings } from "../../core/types";
import { useDialog } from "../shared/dialog";
import { describeRule, intervalLabel } from "../popup/describe";
import { matchesAny, patternToString } from "../../core/url-pattern";
import { agentSetupPrompt, BRIDGE_FILE, bridgePaths, installCommand, mcpSettings, platformOf } from "./agent-setup";

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

type Act = (method: string, params: unknown) => Promise<void>;
type BridgeStatus = { connected: boolean; wanted: boolean; restartRequired: boolean };

export function AgentsView() {
  const { data, error, reload } = useApi<AgentsData>("listAgents", undefined, { live: ["config"] });
  const audit = useApi<AuditEntry[]>("getAudit", undefined, { live: ["audit"] });
  const rules = useApi<Rule[]>("listRules", undefined, { live: ["config"] });
  const overview = useApi<{ settings: Settings }>("getOverview", undefined, { live: ["config"] });
  const bridge = useApi<BridgeStatus>("bridgeStatus", undefined, { live: ["bridge", "config"] });
  const [actionError, setActionError] = useState<unknown>(null);

  const act: Act = async (method, params) => {
    setActionError(null);
    try {
      await api(method, params);
      await Promise.all([reload(), audit.reload(), rules.reload(), overview.reload()]);
    } catch (e) {
      setActionError(e);
    }
  };

  const agents = data?.agents ?? [];
  const ruleById = new Map((rules.data ?? []).map((r) => [r.id, r]));
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const settings = overview.data?.settings;

  return (
    <>
      <h1>Agent Integrations</h1>
      <p className="muted">
        AI agents, such as AI apps on your computer or other browser extensions, can set up refresh rules for you. Their rules don't run on their own: rules
        they create are saved switched off, and switching a rule on or deleting it waits for your OK here, unless you choose to trust that agent. You can take
        an agent's access away at any time.
      </p>
      <ErrorBox error={error ?? actionError} />
      <ApprovalsCard
        approvals={data?.approvals ?? []}
        pendingAgents={agents.filter((a) => a.status === "pending").length}
        ruleById={ruleById}
        agentName={agentName}
        act={act}
      />
      <div className="card col">
        <h2>Agents</h2>
        {agents.length === 0 ? (
          <Empty>No agents have asked for access yet.</Empty>
        ) : (
          agents.map((a) => <AgentCard key={a.id} agent={a} allScopes={data?.allScopes ?? []} act={act} />)
        )}
      </div>
      <AllowedExtensions ids={settings?.allowedExtensionIds ?? []} save={(ids) => act("updateSettings", { allowedExtensionIds: ids })} />
      <BridgeCard enabled={!!settings?.nativeBridgeEnabled} eventsFile={!!settings?.agentEventsFile} status={bridge.data} act={act} />
      <ActivityLog entries={audit.data ?? []} ruleById={ruleById} agentName={agentName} act={act} />
    </>
  );
}

function ApprovalsCard({
  approvals,
  pendingAgents,
  ruleById,
  agentName,
  act,
}: {
  approvals: ApprovalRequest[];
  pendingAgents: number;
  ruleById: Map<string, Rule>;
  agentName: (id: string) => string;
  act: Act;
}) {
  const pending = approvals.filter((a) => a.status === "pending");
  const agentsWaiting = pendingAgents === 1 ? "1 agent is" : `${pendingAgents} agents are`;
  return (
    <div className="card col">
      <h2>Waiting for your OK {pending.length > 0 && <span className="badge">{pending.length}</span>}</h2>
      {pending.length === 0 ? (
        <span className="muted">
          {pendingAgents > 0 ? `No rule changes are waiting. ${agentsWaiting} asking to connect: see Agents below.` : "Nothing is waiting for your OK."}
        </span>
      ) : (
        pending.map((a) => <ApprovalRow key={a.id} approval={a} rule={ruleById.get(a.ruleId)} agentName={agentName} act={act} />)
      )}
    </div>
  );
}

function ApprovalRow({ approval: a, rule, agentName, act }: { approval: ApprovalRequest; rule?: Rule; agentName: (id: string) => string; act: Act }) {
  return (
    <div className="info col">
      <div className="row">
        <strong>
          {a.kind === "activate" ? "Switch on" : "Delete"} rule “{rule?.name ?? a.ruleId}”
        </strong>
        <span className="muted small" title={`Rule version ${a.ruleRevision}`}>
          asked by {agentName(a.agentId)} · {formatTime(a.createdAt)}
        </span>
        <span className="spacer" />
        <a className="btn small" href={`#/builder/${a.ruleId}`} style={{ textDecoration: "none" }}>
          Review & test
        </a>
        <button className="small primary" onClick={() => act("resolveApproval", { id: a.id, approve: true })}>
          Approve
        </button>
        <button className="small danger" onClick={() => act("resolveApproval", { id: a.id, approve: false })}>
          Reject
        </button>
      </div>
      {rule && (
        <>
          <RuleInWords rule={rule} />
          <details>
            <summary className="small">Show the rule's full definition (JSON)</summary>
            <pre>{JSON.stringify({ ...rule, meta: undefined }, null, 2)}</pre>
          </details>
        </>
      )}
    </div>
  );
}

/** A command or snippet with a Copy button. */
function CopyLine({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<boolean | null>(false);
  const copy = () =>
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(null), // the text stays selectable
    );
  return (
    <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
      <pre className="copy-line" aria-label={label} style={{ flex: 1, margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {text}
      </pre>
      <button className="small" onClick={copy}>
        {copied ? "Copied" : copied === null ? "Couldn't copy" : "Copy"}
      </button>
      <span className="sr-only" role="status">
        {copied ? "Copied" : copied === null ? "Couldn't copy. Select the text and copy it yourself." : ""}
      </span>
    </div>
  );
}

/** Copy a text to paste somewhere else, saying so on the button for a moment. */
function CopyButton({ text, label, className = "small" }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = () =>
    void navigator.clipboard.writeText(text).then(
      () => setState("copied"),
      () => setState("failed"),
    );
  const said = state === "copied" ? "Copied: paste it into your AI app" : state === "failed" ? "Couldn't copy. Select the text and copy it yourself." : "";
  return (
    <>
      <button className={className} onClick={copy} onBlur={() => setState("idle")}>
        {state === "copied" ? "Copied: paste it into your AI app" : state === "failed" ? "Couldn't copy" : label}
      </button>
      {/* Announced by screen readers; the button's own label changes silently. */}
      <span className="sr-only" role="status">
        {said}
      </span>
    </>
  );
}

/** Step by step: allow, download, install with one command, restart if asked, add to the AI app, approve. */
function BridgeSetup({ enabled, connected }: { enabled: boolean; connected: boolean }) {
  const platform = platformOf(navigator.userAgent);
  const paths = bridgePaths(platform);
  const { bin } = paths;
  const command = installCommand(chrome.runtime.id, paths);
  // MCP apps don't expand ~ or $HOME: the installer prints this with the real path.
  const mcp = mcpSettings(paths);
  return (
    <details open={enabled && !connected}>
      <summary className="small">Set up (about two minutes; needs Node.js 18 or later)</summary>
      <ol className="small col setup-steps" style={{ gap: 8, margin: "8px 0 0", paddingLeft: 20 }}>
        <li>Switch on “Allow desktop AI apps to connect” above.</li>
        <li>
          <a className="btn small" href={chrome.runtime.getURL(`bridge/${BRIDGE_FILE}`)} download={BRIDGE_FILE}>
            Download the bridge
          </a>{" "}
          (one file, <code>{BRIDGE_FILE}</code>).
        </li>
        <li className="col" style={{ gap: 6 }}>
          <span>
            <strong>Let your AI app do this step and step 5:</strong> if it can run commands (like Claude Code), paste these instructions into it. It installs
            the bridge and adds JustRefresh to its own settings; you still restart it and approve it here.
          </span>
          <span>
            <CopyButton text={agentSetupPrompt(chrome.runtime.id, platform)} label="Copy setup for your AI app" />
          </span>
          <span>
            Or install it yourself: run this in a terminal (change the folder or file name if yours differ). It copies itself to <code>{bin}</code> and
            registers with your browsers; you can delete the download afterwards.
          </span>
          <CopyLine label="Install command" text={command} />
        </li>
        <li>If this card asks you to restart JustRefresh, do that; then it shows Connected.</li>
        <li>
          Add JustRefresh to your AI app's MCP settings: copy them from what the install command printed, which has the full path to Node and your real path in
          place of <code>&lt;you&gt;</code>. They look like this:
          <pre className="copy-line" style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {mcp}
          </pre>
        </li>
        <li>Start the app. It appears above under Agents: choose what it may do and approve it.</li>
      </ol>
      <p className="small muted" style={{ margin: "8px 0 0" }}>
        To remove it: <code>{`node ${bin}${BRIDGE_FILE} uninstall`}</code>.
      </p>
    </details>
  );
}

function BridgeCard({ enabled, eventsFile, status, act }: { enabled: boolean; eventsFile: boolean; status: BridgeStatus | null; act: Act }) {
  const connected = !!status?.connected;
  const toggle = (on: boolean) => {
    const ask = on ? chrome.permissions.request({ permissions: ["nativeMessaging"] }).catch(() => false) : Promise.resolve(true);
    void ask.then((granted) => {
      if (granted) void act("updateSettings", { nativeBridgeEnabled: on });
    });
  };
  return (
    <div className="card col">
      <h2>Desktop AI apps (MCP bridge)</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Optional. Lets AI apps on this computer that support MCP (Model Context Protocol) connect to JustRefresh, through a small helper program. Everything
        stays on this computer, and each app has to be approved above before it can do anything. Once approved, an app gets its own key, so a program that only
        knows its name can't use its approval.
      </p>
      <div className="row">
        <Toggle checked={enabled} label="Allow desktop AI apps to connect" onChange={toggle} />
        <span className={`pill pill-${connected ? "ok" : "muted"}`}>{connected ? "Connected" : "Not connected"}</span>
      </div>
      {status?.restartRequired && (
        <div className="row">
          <span className="small">
            One more step: Chrome only allows this connection after JustRefresh restarts. Your rules and schedules are kept; open JustRefresh pages (like this
            one) will close.
          </span>
          <button className="small primary" onClick={() => chrome.runtime.reload()}>
            Restart JustRefresh
          </button>
        </div>
      )}
      {enabled && (
        <div className="col" style={{ gap: 4 }}>
          <Toggle checked={eventsFile} label="Also write each app's events to a file" onChange={(v) => void act("updateSettings", { agentEventsFile: v })} />
          <p className="small muted" style={{ margin: 0 }}>
            For scripts and tools that follow a file, such as Claude Code&apos;s Monitor: <code>~/.justrefresh/events/&lt;app&gt;.jsonl</code>, readable only by
            your account. Each app gets events about its own rules and requests only, with page addresses hidden as in Settings, and never page text.
          </p>
        </div>
      )}
      <BridgeSetup enabled={enabled} connected={connected} />
    </div>
  );
}

const OUTCOME_PILL: Record<AuditEntry["outcome"], string> = { ok: "ok", pending_approval: "warn", denied: "error", error: "error" };

function ActivityLog({
  entries,
  ruleById,
  agentName,
  act,
}: {
  entries: AuditEntry[];
  ruleById: Map<string, Rule>;
  agentName: (id: string) => string;
  act: Act;
}) {
  const dialog = useDialog();
  const clear = async () => {
    const ok = await dialog.confirm({
      title: "Clear the activity log?",
      message: "The record of what agents asked JustRefresh to do is deleted.",
      confirmLabel: "Clear log",
      danger: true,
    });
    if (ok) await act("clearAudit", undefined);
  };
  return (
    <div className="card col">
      <div className="row">
        <h2>Activity log</h2>
        <span className="spacer" />
        <button className="small" onClick={clear}>
          Clear
        </button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Everything agents have asked JustRefresh to do, newest first.
      </p>
      {entries.length === 0 ? (
        <Empty>No agent activity yet.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Agent</th>
              <th>Request</th>
              <th>Rule</th>
              <th>Result</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.slice(0, 300).map((e, i) => (
              <tr key={i}>
                <td className="small">{formatTime(e.at)}</td>
                <td className="small" title={e.agentId}>
                  {agentName(e.agentId)}
                </td>
                <td className="small" title={e.operation}>
                  {operationLabel(e.operation)}
                </td>
                <td className="small" title={e.ruleId}>
                  {e.ruleId ? (ruleById.get(e.ruleId)?.name ?? e.ruleId) : "—"}
                </td>
                <td>
                  <span className={`pill pill-${OUTCOME_PILL[e.outcome] ?? "error"}`}>{OUTCOME_LABEL[e.outcome] ?? e.outcome}</span>
                </td>
                <td className="small muted">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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
        Another browser extension can act as an agent only if you add its ID here, and it still has to be approved above before it can do anything. To find an
        extension's ID, open <code>chrome://extensions</code> and turn on Developer mode.
      </p>
      {ids.length === 0 ? (
        <span className="small muted">None added. Other extensions can't connect.</span>
      ) : (
        ids.map((id) => (
          <div key={id} className="row">
            <code>{id}</code>
            <span className="spacer" />
            <button className="small" onClick={() => void save(ids.filter((x) => x !== id))}>
              Remove
            </button>
          </div>
        ))
      )}
      <div className="row">
        <input
          aria-label="Extension ID"
          placeholder="32-letter extension ID"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ minWidth: 300 }}
        />
        <button className="small" disabled={!valid || ids.includes(candidate)} onClick={() => void save([...ids, candidate]).then(() => setDraft(""))}>
          Add
        </button>
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
        <span className="small muted">
          {TRANSPORT_LABEL[agent.transport]} · last seen {formatTime(agent.lastSeenAt)}
          {agent.keyHash ? " · uses its own key" : ""}
        </span>
        <span className="spacer" />
        {/* Kept together so the buttons wrap as a pair, never one per line. */}
        <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
          {agent.status !== "revoked" && (
            <button
              className="small danger"
              title="Keep it listed but refuse everything it asks; you can approve it again later"
              onClick={() => act("updateAgent", { id: agent.id, status: "revoked" })}
            >
              {agent.status === "pending" ? "Decline" : "Revoke access"}
            </button>
          )}
          <button
            className="small"
            onClick={async () =>
              (await dialog.confirm({
                title: `Remove ${agent.name}?`,
                message: "It loses access to JustRefresh and has to ask for approval again to reconnect.",
                confirmLabel: "Remove agent",
                danger: true,
              })) && act("removeAgent", { id: agent.id })
            }
          >
            Remove
          </button>
        </span>
      </div>
      <div className="col small" style={{ gap: 4 }}>
        <strong>{agent.status === "pending" ? "What may this agent do?" : "This agent may:"}</strong>
        {allScopes.map((s) => (
          <label key={s} title={s} className="row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={scopes.includes(s)}
              onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))}
            />
            {SCOPE_LABEL[s] ?? s}
          </label>
        ))}
      </div>
      <div className="row">
        <Toggle
          checked={agent.trustedActivation}
          label={
            <span className="small">
              Trust this agent <span className="muted">(switch on and delete its own rules without asking me each time)</span>
            </span>
          }
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
    limits.maxRefreshes ? `at most ${limits.maxRefreshes} refreshes and clicks` : null,
    limits.maxDurationSeconds ? `stops after ${intervalLabel(limits.maxDurationSeconds)}` : null,
    limits.stopAt ? `stops at ${formatTime(Date.parse(limits.stopAt))}` : null,
  ].filter(Boolean);
  return (
    <div className="col small rule-in-words" style={{ gap: 4 }}>
      <span>
        {describeRule(rule)}
        {extras.length ? ` (${extras.join(", ")})` : ""}.
      </span>
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
      {matchesEverySite(rule) && <span className="warn-text">This rule can run on every website.</span>}
    </div>
  );
}

/** Whether a rule's pages include unrelated sites (a catch-all glob, domain or regex). */
function matchesEverySite(rule: Rule): boolean {
  const all = (urls: string[]) => urls.every((u) => matchesAny(rule.target.patterns, u) !== null);
  // https-only or http-only catch-alls count too ("https://*/*", "regex:^https://").
  return all(["https://unrelated-a.example/x", "https://other-b.test/"]) || all(["http://unrelated-a.example/x", "http://other-b.test/"]);
}
