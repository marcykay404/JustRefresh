import { useMemo, useState } from "react";
import { api, originOf, requestOrigins } from "../shared/api";
import { useApi, useNow } from "../shared/hooks";
import { formatDuration, formatTime, statusLabel } from "../shared/format";
import { Empty, ErrorBox, StatusPill } from "../shared/components";
import { INTERVAL_PRESETS } from "../../core/defaults";
import type { Settings, TabInfo, TabRuntime } from "../../core/types";
import { useDialog } from "../shared/dialog";

interface Row {
  tab: TabInfo;
  runtime: TabRuntime | null;
  status: string;
  reason?: string;
  controllerId: string | null;
  controllerName: string | null;
}
interface Overview {
  settings: Settings;
  tabs: Row[];
  counts: Record<string, number>;
  conflicts: { a: string; b: string; pattern: string }[];
}

type SortKey = "title" | "status" | "next" | "count";

export function TabsView() {
  const dialog = useDialog();
  const { data, error, reload } = useApi<Overview>("getOverview", undefined, { pollMs: 2000 });
  const now = useNow(1000);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState<SortKey>("title");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkInterval, setBulkInterval] = useState(300);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.toLowerCase();
    return data.tabs
      .filter((r) => !q || r.tab.title.toLowerCase().includes(q) || r.tab.url.toLowerCase().includes(q))
      .filter((r) => statusFilter === "all" || (statusFilter === "paused" ? r.status.startsWith("paused") : r.status === statusFilter))
      .sort((a, b) => {
        switch (sort) {
          case "status":
            return a.status.localeCompare(b.status);
          case "next":
            return (a.runtime?.nextDueAt ?? Infinity) - (b.runtime?.nextDueAt ?? Infinity);
          case "count":
            return (b.runtime?.refreshCount ?? 0) - (a.runtime?.refreshCount ?? 0);
          default:
            return a.tab.title.localeCompare(b.tab.title);
        }
      });
  }, [data, search, statusFilter, sort]);

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

  const bulkStart = () => {
    const targets = rows.filter((r) => selected.has(r.tab.id) && !r.tab.restricted);
    const origins = [...new Set(targets.map((r) => originOf(r.tab.url)).filter((o): o is string => !!o))];
    // Request site access in the click gesture, then start each tab.
    void requestOrigins(origins).catch(() => false).then(async () => {
      for (const r of targets) await act("startTab", { tabId: r.tab.id, intervalSeconds: bulkInterval });
      setNotice(`Started ${targets.length} tab(s)`);
    });
  };
  const bulk = async (method: string) => {
    for (const id of selected) await act(method, { tabId: id });
  };

  const refreshAll = async () => {
    // Reloads are spaced out to avoid storms, so this takes a moment: show it,
    // and ignore further clicks until it finishes (avoids duplicate refreshes).
    if (refreshingAll) return;
    setRefreshingAll(true);
    setNotice("Refreshing eligible tabs…");
    let r: { refreshed: number[]; skipped: { tabId: number; reason: string }[] } | null;
    try {
      r = (await act("refreshAll")) as typeof r;
    } finally {
      setRefreshingAll(false);
    }
    if (!r) {
      setNotice(null);
      return;
    }
    const blocked = r.skipped.filter((s) => !/No rule|Excluded|excluded|cannot|Browser-internal|globally disabled/.test(s.reason));
    setNotice(`Refreshed ${r.refreshed.length} tab(s); ${r.skipped.length} skipped.`);
    const forceThem =
      blocked.length > 0 &&
      (await dialog.confirm({
        title: `Refresh ${blocked.length} protected tab${blocked.length === 1 ? "" : "s"} anyway?`,
        message: (
          <>
            <p>These were skipped to protect your work (for example, unsaved changes):</p>
            <ul>
              {blocked.slice(0, 8).map((b) => (
                <li key={b.tabId}>{data?.tabs.find((t) => t.tab.id === b.tabId)?.tab.title || `Tab ${b.tabId}`}: {b.reason}</li>
              ))}
            </ul>
            {blocked.length > 8 && <p>…and {blocked.length - 8} more.</p>}
          </>
        ),
        confirmLabel: "Refresh anyway",
        cancelLabel: "Leave them",
        danger: true,
      }));
    if (forceThem) {
      for (const b of blocked) await act("refreshNow", { tabId: b.tabId, force: true });
    }
  };

  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="muted">Loading…</div>;

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.tab.id));

  return (
    <>
      <div className="row">
        <h1>Tabs</h1>
        <span className="spacer" />
        <span className="muted">
          {data.counts.running} running · {data.counts.paused} paused · {data.counts.stopped} stopped · {data.counts.excluded} excluded
        </span>
      </div>
      <div className="toolbar">
        <input placeholder="Search title or URL" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search tabs" />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="all">All statuses</option>
          {["scheduled", "paused", "completed", "stopped", "excluded", "idle", "error"].map((s) => (
            <option key={s} value={s}>{s === "paused" ? "Paused (any)" : statusLabel(s)}</option>
          ))}
        </select>
        <span className="spacer" />
        {data.settings.paused ? (
          <button className="primary" onClick={() => act("resumeAll")}>Resume all</button>
        ) : (
          <button onClick={() => act("pauseAll")}>Pause all</button>
        )}
        <button onClick={refreshAll} disabled={refreshingAll} aria-busy={refreshingAll} title="Refresh every tab with an active rule (respects exclusions & safety)">
          {refreshingAll ? "Refreshing…" : "Refresh all eligible"}
        </button>
      </div>
      {selected.size > 0 && (
        <div className="card row">
          <strong>{selected.size} selected</strong>
          <select value={bulkInterval} onChange={(e) => setBulkInterval(Number(e.target.value))} aria-label="Bulk interval">
            {INTERVAL_PRESETS.map((p) => <option key={p.seconds} value={p.seconds}>Every {p.label}</option>)}
          </select>
          <button className="primary" onClick={bulkStart}>Start refreshing</button>
          <button onClick={() => bulk("pauseTab")}>Pause</button>
          <button onClick={() => bulk("resumeTab")}>Resume</button>
          <button onClick={() => bulk("stopTab")}>Stop</button>
          <button onClick={() => bulk("excludeTab")}>Exclude</button>
          <button className="link" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}
      <ErrorBox error={actionError} />
      {notice && <div className="info">{notice}</div>}
      {data.conflicts.length > 0 && (
        <div className="notice">
          Rule conflicts: {data.conflicts.map((c) => `${c.a} and ${c.b} share "${c.pattern}" at equal priority (tie-break: oldest rule wins)`).join("; ")}
        </div>
      )}
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        {rows.length === 0 ? (
          <Empty>No tabs match.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.tab.id)) : new Set())}
                  />
                </th>
                <th className="sortable" onClick={() => setSort("title")}>Tab</th>
                <th className="sortable" onClick={() => setSort("status")}>Status</th>
                <th>Controller</th>
                <th className="sortable" onClick={() => setSort("next")}>Next refresh</th>
                <th className="sortable" onClick={() => setSort("count")}>Count</th>
                <th>Last evaluation</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rt = r.runtime;
                const running = rt && ["scheduled", "evaluating", "refreshing"].includes(rt.status);
                return (
                  <tr key={r.tab.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.tab.title}`}
                        checked={selected.has(r.tab.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(r.tab.id);
                          else next.delete(r.tab.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td style={{ maxWidth: 360 }}>
                      <div className="truncate"><strong>{r.tab.title || "Untitled"}</strong></div>
                      <div className="truncate muted small">{r.tab.url}</div>
                    </td>
                    <td>
                      <StatusPill status={r.status} />
                      {r.reason && <div className="small muted" style={{ maxWidth: 220 }}>{r.reason}</div>}
                    </td>
                    <td className="small">
                      {r.controllerId?.startsWith("tab:") ? "Tab-specific" : r.controllerName ? <a href={`#/builder/${r.controllerId}`}>{r.controllerName}</a> : <span className="muted">—</span>}
                    </td>
                    <td className="mono">{rt?.nextDueAt ? formatDuration(rt.nextDueAt - now) : "—"}</td>
                    <td>{rt?.refreshCount ?? 0}</td>
                    <td className="small">
                      {rt?.lastEvaluation ? (
                        <span title={rt.lastEvaluation.reason}>{rt.lastEvaluation.status} · {formatTime(rt.lastEvaluation.at)}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                      {rt?.lastError && <div style={{ color: "var(--error)" }}>{rt.lastError}</div>}
                    </td>
                    <td>
                      <div className="row" style={{ flexWrap: "nowrap" }}>
                        {!r.tab.restricted && !running && (
                          <button className="small" onClick={() => (rt?.status === "paused_user" || rt?.status === "stopped" || rt?.status === "completed" || rt?.status?.startsWith("paused") ? act("resumeTab", { tabId: r.tab.id }) : act("startTab", { tabId: r.tab.id }))}>
                            {rt?.status?.startsWith("paused") ? "Resume" : "Start"}
                          </button>
                        )}
                        {running && <button className="small" onClick={() => act("pauseTab", { tabId: r.tab.id })}>Pause</button>}
                        {running && <button className="small" onClick={() => act("stopTab", { tabId: r.tab.id })}>Stop</button>}
                        {!r.tab.restricted && <button className="small" onClick={() => act("refreshNow", { tabId: r.tab.id })}>Refresh</button>}
                        {r.controllerId?.startsWith("tab:") && <button className="small" onClick={() => act("clearTabOverride", { tabId: r.tab.id })} title="Remove tab-specific settings">Reset</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
