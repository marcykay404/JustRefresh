import { useState } from "react";
import { api } from "../shared/api";
import { useApi } from "../shared/hooks";
import { formatTime } from "../shared/format";
import { Empty, ErrorBox } from "../shared/components";
import { detectPattern, patternToString, validatePattern } from "../../core/url-pattern";
import type { Exclusion, TabInfo, TabOverride } from "../../core/types";

interface Data {
  exclusions: Exclusion[];
  tabExclusions: (TabOverride & { tab: TabInfo | null })[];
}

export function ExclusionsView() {
  const { data, error, reload } = useApi<Data>("listExclusions", undefined, { pollMs: 5000 });
  const [pattern, setPattern] = useState("");
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<unknown>(null);
  const problem = pattern ? validatePattern(pattern) : null;

  const act = async (method: string, params: unknown) => {
    setActionError(null);
    try {
      await api(method, params);
      await reload();
    } catch (e) {
      setActionError(e);
    }
  };

  return (
    <>
      <h1>Exclusions</h1>
      <p className="muted">Exclusions always override rules and tab-specific settings. Browser-internal pages are always excluded.</p>
      <div className="card col">
        <h3>Add URL exclusion</h3>
        <div className="row">
          <input style={{ flex: 2 }} placeholder="e.g. https://example.com/checkout/*  or  *.bank.com" value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="Exclusion pattern" />
          <input style={{ flex: 1 }} placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          <button
            className="primary"
            disabled={!pattern || !!problem}
            onClick={async () => {
              await act("addExclusion", { pattern, ...(reason ? { reason } : {}) });
              setPattern("");
              setReason("");
            }}
          >
            Add
          </button>
        </div>
        {pattern && (problem ? <span className="small" style={{ color: "var(--error)" }}>{problem}</span> : <span className="small muted">Detected as <code>{detectPattern(pattern).type}</code> pattern</span>)}
      </div>
      <ErrorBox error={error ?? actionError} />
      <div className="card" style={{ padding: 0 }}>
        {!data?.exclusions.length ? (
          <Empty>No URL exclusions.</Empty>
        ) : (
          <table>
            <thead><tr><th>Pattern</th><th>Type</th><th>Reason</th><th>Added</th><th /></tr></thead>
            <tbody>
              {data.exclusions.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{patternToString(e.pattern)}</td>
                  <td>{detectPattern(e.pattern).type}</td>
                  <td>{e.reason ?? <span className="muted">—</span>}</td>
                  <td className="small muted">{formatTime(e.createdAt)}</td>
                  <td><button className="small danger" onClick={() => act("removeExclusion", { id: e.id })}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <h2>Temporarily excluded tabs</h2>
      <div className="card" style={{ padding: 0 }}>
        {!data?.tabExclusions.length ? (
          <Empty>No tabs are temporarily excluded.</Empty>
        ) : (
          <table>
            <thead><tr><th>Tab</th><th>Since</th><th /></tr></thead>
            <tbody>
              {data.tabExclusions.map((o) => (
                <tr key={o.tabId}>
                  <td>
                    <div>{o.tab?.title ?? o.restore.title ?? "Closed tab"}</div>
                    <div className="small muted">{o.tab?.url ?? o.restore.url}</div>
                  </td>
                  <td className="small muted">{formatTime(o.createdAt)}</td>
                  <td><button className="small" onClick={() => act("includeTab", { tabId: o.tabId })}>Include again</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
