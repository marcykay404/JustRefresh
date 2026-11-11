import { useMemo, useState } from "react";
import { api } from "../shared/api";
import { useApi } from "../shared/hooks";
import { downloadJson, formatTime } from "../shared/format";
import { Empty, ErrorBox, Toggle } from "../shared/components";
import { patternToString } from "../../core/url-pattern";
import type { Rule } from "../../core/types";

export function RulesView() {
  const { data, error, reload } = useApi<Rule[]>("listRules", undefined, { pollMs: 5000 });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<"priority" | "name" | "updated">("priority");
  const [actionError, setActionError] = useState<unknown>(null);

  const act = async (method: string, params?: unknown) => {
    setActionError(null);
    try {
      const r = await api(method, params);
      await reload();
      return r;
    } catch (e) {
      setActionError(e);
      return null;
    }
  };

  const rules = useMemo(() => {
    const q = search.toLowerCase();
    return (data ?? [])
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.id.includes(q) || r.target.patterns.some((p) => patternToString(p).toLowerCase().includes(q)))
      .filter((r) => filter === "all" || (filter === "enabled" ? r.enabled : filter === "disabled" ? !r.enabled : filter === "draft" ? r.meta.draft : r.meta.origin.type === "agent"))
      .sort((a, b) =>
        sort === "name" ? a.name.localeCompare(b.name) : sort === "updated" ? b.meta.updatedAt - a.meta.updatedAt : b.priority - a.priority || a.meta.createdAt - b.meta.createdAt,
      );
  }, [data, search, filter, sort]);

  return (
    <>
      <div className="row">
        <h1>Rules</h1>
        <span className="spacer" />
        <button onClick={async () => downloadJson("smart-auto-refresh-rules.json", await api("exportConfig", { includeSettings: false, ruleIds: rules.map((r) => r.id) }))}>Export shown</button>
        <a className="btn primary" href="#/builder" style={{ textDecoration: "none" }}>New rule</a>
      </div>
      <div className="toolbar">
        <input placeholder="Search name, id or pattern" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search rules" />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter rules">
          <option value="all">All rules</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
          <option value="draft">Drafts</option>
          <option value="agent">Agent-created</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort rules">
          <option value="priority">Sort: priority</option>
          <option value="name">Sort: name</option>
          <option value="updated">Sort: last updated</option>
        </select>
      </div>
      <ErrorBox error={error ?? actionError} />
      <PatternTester />
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        {rules.length === 0 ? (
          <Empty>No rules yet. Create one with the Rule Builder or import JSON in Settings.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Enabled</th>
                <th>Name</th>
                <th>Targets</th>
                <th>Trigger</th>
                <th>Priority</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Toggle checked={r.enabled} label="" onChange={(on) => act(on ? "enableRule" : "disableRule", { id: r.id })} />
                  </td>
                  <td>
                    <a href={`#/builder/${r.id}`}><strong>{r.name}</strong></a>
                    <div className="small muted mono">{r.id}</div>
                    <div className="row small">
                      {r.meta.draft && <span className="pill pill-warn">Draft</span>}
                      {r.meta.origin.type === "agent" && <span className="pill pill-done">Agent: {r.meta.origin.agentId}</span>}
                      {r.meta.origin.type === "import" && <span className="pill pill-muted">Imported</span>}
                      {r.stopWhen && <span className="pill pill-muted">Conditional</span>}
                    </div>
                  </td>
                  <td className="small mono" style={{ maxWidth: 300 }}>
                    {r.target.patterns.map((p, i) => <div key={i} className="truncate">{patternToString(p)}</div>)}
                    {r.target.exclusions.map((p, i) => <div key={`x${i}`} className="truncate muted">not {patternToString(p)}</div>)}
                  </td>
                  <td className="small">
                    {r.trigger.type === "interval" ? `Every ${(r.trigger as unknown as { seconds: number }).seconds}s` : r.trigger.type}
                  </td>
                  <td>{r.priority}</td>
                  <td className="small muted">{formatTime(r.meta.updatedAt)}<div>rev {r.meta.revision}</div></td>
                  <td>
                    <div className="row" style={{ flexWrap: "nowrap" }}>
                      <a className="btn small" href={`#/builder/${r.id}`} style={{ textDecoration: "none" }}>Edit</a>
                      <button className="small" onClick={() => act("duplicateRule", { id: r.id })}>Duplicate</button>
                      <button className="small" onClick={async () => downloadJson(`${r.id}.json`, await api("exportConfig", { ruleIds: [r.id] }))}>Export</button>
                      <button className="small danger" onClick={() => confirm(`Delete rule "${r.name}"?`) && act("deleteRule", { id: r.id, expectedRevision: r.meta.revision })}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export function PatternTester({ initialPattern = "" }: { initialPattern?: string }) {
  const [pattern, setPattern] = useState(initialPattern);
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<{ valid: boolean; error?: string; type?: string; matches?: boolean; rulesMatchingUrl?: { id: string; name: string; priority: number }[]; excludedBy?: string[] } | null>(null);
  const test = async () => setResult(await api("testPattern", { pattern: pattern || "*", url }));
  return (
    <details className="card">
      <summary><strong>URL pattern tester</strong> <span className="muted small">— check patterns, precedence and exclusions</span></summary>
      <div className="row" style={{ marginTop: 8 }}>
        <input style={{ flex: 1 }} placeholder="Pattern, e.g. *.example.com or https://example.com/reports/*" value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="Pattern" />
        <input style={{ flex: 1 }} placeholder="URL to test" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="URL" />
        <button onClick={test} disabled={!url}>Test</button>
      </div>
      {result && (
        <div className="small" style={{ marginTop: 8 }}>
          {!result.valid ? (
            <span style={{ color: "var(--error)" }}>{result.error}</span>
          ) : (
            <>
              <div>
                Detected type <code>{result.type}</code>: {result.matches ? <strong style={{ color: "var(--ok)" }}>matches</strong> : <strong>does not match</strong>}
              </div>
              <div>
                Rules for this URL (in precedence order):{" "}
                {result.rulesMatchingUrl?.length ? result.rulesMatchingUrl.map((r, i) => <span key={r.id}>{i ? " → " : ""}{r.name} (p{r.priority})</span>) : "none"}
              </div>
              {result.excludedBy?.length ? <div style={{ color: "var(--warn)" }}>Excluded by: {result.excludedBy.join(", ")}</div> : null}
            </>
          )}
        </div>
      )}
    </details>
  );
}
