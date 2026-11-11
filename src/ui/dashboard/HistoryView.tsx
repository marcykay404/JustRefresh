import { useMemo, useState } from "react";
import { api } from "../shared/api";
import { useApi } from "../shared/hooks";
import { formatTime } from "../shared/format";
import { Empty, ErrorBox } from "../shared/components";
import type { HistoryEntry } from "../../core/types";
import { useDialog } from "../shared/dialog";

export function HistoryView() {
  const dialog = useDialog();
  const { data, error, reload } = useApi<HistoryEntry[]>("getHistory", { limit: 500 }, { pollMs: 4000 });
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState("all");
  const [actor, setActor] = useState("all");
  const rows = useMemo(() => {
    const q = search.toLowerCase();
    return (data ?? []).filter(
      (e) =>
        (outcome === "all" || e.outcome === outcome) &&
        (actor === "all" || e.actor === actor) &&
        (!q || `${e.ruleId} ${e.url} ${e.action} ${e.reason}`.toLowerCase().includes(q)),
    );
  }, [data, search, outcome, actor]);

  return (
    <>
      <div className="row">
        <h1>History</h1>
        <span className="spacer" />
        <button onClick={async () => {
            const ok = await dialog.confirm({ title: "Clear history?", message: "All refresh and rule history entries are deleted.", confirmLabel: "Clear history", danger: true });
            if (ok) {
              await api("clearHistory");
              reload();
            }
          }}>Clear history</button>
      </div>
      <div className="toolbar">
        <input placeholder="Search rule, URL, action, reason" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search history" />
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Outcome">
          <option value="all">All outcomes</option>
          <option value="ok">OK</option>
          <option value="skipped">Skipped</option>
          <option value="error">Error</option>
        </select>
        <select value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Actor">
          <option value="all">All actors</option>
          <option value="system">Automatic</option>
          <option value="user">User</option>
          <option value="agent">Agent</option>
        </select>
        <span className="muted small">Retention and size are configured in Settings.</span>
      </div>
      <ErrorBox error={error} />
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        {rows.length === 0 ? (
          <Empty>No history entries.</Empty>
        ) : (
          <table>
            <thead><tr><th>Time</th><th>Rule</th><th>Tab</th><th>Trigger</th><th>Condition</th><th>Action</th><th>Outcome</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={i}>
                  <td className="small">{formatTime(e.at)}</td>
                  <td className="small mono">{e.ruleId ?? "—"}</td>
                  <td className="small" style={{ maxWidth: 260 }}><div className="truncate">{e.url ?? `#${e.tabId}`}</div></td>
                  <td className="small">{e.trigger}{e.actor !== "system" && <span className="pill pill-muted" style={{ marginLeft: 4 }}>{e.actor}</span>}</td>
                  <td className="small">{e.condition ?? "—"}</td>
                  <td className="small">{e.action}</td>
                  <td><span className={`pill pill-${e.outcome === "ok" ? "ok" : e.outcome === "error" ? "error" : "warn"}`}>{e.outcome}</span></td>
                  <td className="small muted" style={{ maxWidth: 320 }}>{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
