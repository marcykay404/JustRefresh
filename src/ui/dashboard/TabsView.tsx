import { useEffect, useMemo, useState } from "react";
import { api, originOf, requestOrigins } from "../shared/api";
import { useApi, useNow } from "../shared/hooks";
import { fileAccessAllowed, openChromeSiteAccess } from "../shared/chrome-settings";
import { cancelAfterAccessFor } from "../shared/access";
import { formatDuration, formatTime, statusLabel } from "../shared/format";
import { Empty, ErrorBox, StatusPill } from "../shared/components";
import { INTERVAL_PRESETS } from "../../core/defaults";
import { FORM_RESULT_REASON } from "../../core/safety";
import type { Settings, TabInfo, TabRuntime } from "../../core/types";
import { useDialog } from "../shared/dialog";

interface Row {
  tab: TabInfo;
  runtime: TabRuntime | null;
  status: string;
  reason?: string;
  controllerId: string | null;
  controllerName: string | null;
  /** Running, but won't refresh until site access is allowed (its protection needs to see the page). */
  needsAccess?: boolean;
  /** A tab timer started here would need to see the page (its protection, with the tab's own settings). */
  timerNeedsAccess?: boolean;
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
  const { data, error, reload } = useApi<Overview>("getOverview", undefined, { live: ["runtime", "config", "tabs"] });
  const now = useNow(1000);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState<SortKey>("title");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkInterval, setBulkInterval] = useState(300);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Chrome's "Allow access to file URLs" for JustRefresh. */
  const [filesOn, setFilesOn] = useState(false);
  useEffect(() => {
    void fileAccessAllowed().then(setFilesOn);
  }, []);
  /** Tabs a bulk start left alone because access to their site was declined. */
  const [declined, setDeclined] = useState<{ tabs: Row[]; intervalSeconds: number } | null>(null);
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
            return nextRefreshAt(a.runtime) - nextRefreshAt(b.runtime);
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
    setDeclined(null);
    // Only tabs whose timer would need to see the page (their protection, with their own settings) need access.
    const asking = targets.filter((r) => r.timerNeedsAccess !== false);
    // Local files can't be granted by a prompt while Chrome's file switch is off: leave them out of it
    // (Chrome would refuse the whole request without asking).
    const origins = [...new Set(asking.map((r) => originOf(r.tab.url)).filter((o): o is string => !!o && (o !== "file:///*" || filesOn)))];
    // Asking here: what declined popup clicks left waiting for these sites mustn't start with it.
    cancelAfterAccessFor(origins);
    // Request site access in the click gesture; then start the tabs JustRefresh may read. Like the
    // popup, a declined site isn't started silently: it's listed, with "start without protection".
    void (origins.length ? requestOrigins(origins) : Promise.resolve(true))
      .catch(() => false)
      .then(async () => {
        const allowed = new Set<string>();
        for (const o of origins) if (await chrome.permissions.contains({ origins: [o] }).catch(() => false)) allowed.add(o);
        const ok = targets.filter((r) => r.timerNeedsAccess === false || !originOf(r.tab.url) || allowed.has(originOf(r.tab.url)!));
        const no = targets.filter((r) => !ok.includes(r));
        for (const r of ok) await act("startTab", { tabId: r.tab.id, intervalSeconds: bulkInterval });
        setNotice(ok.length ? `Started ${ok.length} tab(s)` : null);
        if (no.length) setDeclined({ tabs: no, intervalSeconds: bulkInterval });
      });
  };
  /** Tabs not started because their site access was declined: start them refreshing without protection. */
  const startUnprotected = async () => {
    if (!declined) return;
    for (const r of declined.tabs) {
      await act("startTab", { tabId: r.tab.id, intervalSeconds: declined.intervalSeconds, safety: { onActivityUnavailable: "refresh" } });
    }
    setNotice(`Started ${declined.tabs.length} tab(s) without protection`);
    setDeclined(null);
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
    // Form pages are left out: forcing them would only bring up Chrome's resubmission prompt.
    const blocked = r.skipped.filter(
      (s) => !/No rule|Excluded|excluded|cannot|Browser-internal|globally disabled/.test(s.reason) && s.reason !== FORM_RESULT_REASON,
    );
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
                <li key={b.tabId}>
                  {data?.tabs.find((t) => t.tab.id === b.tabId)?.tab.title || `Tab ${b.tabId}`}: {b.reason}
                </li>
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
            <option key={s} value={s}>
              {s === "paused" ? "Paused (any)" : statusLabel(s)}
            </option>
          ))}
        </select>
        <span className="spacer" />
        {data.settings.paused ? (
          <button className="primary" onClick={() => act("resumeAll")}>
            Resume all
          </button>
        ) : (
          <button onClick={() => act("pauseAll")}>Pause all</button>
        )}
        <button
          onClick={refreshAll}
          disabled={refreshingAll}
          aria-busy={refreshingAll}
          title="Refresh every tab with an active rule (respects exclusions & safety)"
        >
          {refreshingAll ? "Refreshing…" : "Refresh all eligible"}
        </button>
      </div>
      {selected.size > 0 && (
        <div className="card row">
          <strong>{selected.size} selected</strong>
          <select value={bulkInterval} onChange={(e) => setBulkInterval(Number(e.target.value))} aria-label="Bulk interval">
            {INTERVAL_PRESETS.map((p) => (
              <option key={p.seconds} value={p.seconds}>
                Every {p.label}
              </option>
            ))}
          </select>
          <button className="primary" onClick={bulkStart}>
            Start refreshing
          </button>
          <button onClick={() => bulk("pauseTab")}>Pause</button>
          <button onClick={() => bulk("resumeTab")}>Resume</button>
          <button onClick={() => bulk("stopTab")}>Stop</button>
          <button onClick={() => bulk("excludeTab")}>Exclude</button>
          <button className="link" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}
      <ErrorBox error={actionError} />
      {notice && <div className="info">{notice}</div>}
      {declined && (
        <div className="notice small col" role="status" style={{ gap: 6 }}>
          <span>
            Not started: JustRefresh wasn't allowed to read {declined.tabs.map((r) => hostOfUrl(r.tab.url) || "local files").join(", ")}, so it couldn't tell
            whether you're typing or have unsaved form changes there.
            {!filesOn &&
              declined.tabs.some((r) => r.tab.url.startsWith("file:")) &&
              " For local files, turn on “Allow access to file URLs” in Chrome's settings."}
          </span>
          <div className="row">
            <button className="small" onClick={() => void startUnprotected()}>
              Start without protection
            </button>
            <button className="small" onClick={() => setDeclined(null)}>
              Leave them
            </button>
          </div>
        </div>
      )}
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
                <th className="sortable" onClick={() => setSort("title")}>
                  Tab
                </th>
                <th className="sortable" onClick={() => setSort("status")}>
                  Status
                </th>
                <th>Controller</th>
                <th className="sortable" onClick={() => setSort("next")}>
                  Next refresh
                </th>
                <th className="sortable" onClick={() => setSort("count")}>
                  Count
                </th>
                <th>Last evaluation</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <TabRow
                  key={r.tab.id}
                  row={r}
                  now={now}
                  checked={selected.has(r.tab.id)}
                  onSelect={(on) => {
                    const next = new Set(selected);
                    if (on) next.add(r.tab.id);
                    else next.delete(r.tab.id);
                    setSelected(next);
                  }}
                  act={act}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

type Act = (method: string, params?: unknown) => unknown;

const RUNNING_STATES = ["scheduled", "evaluating", "refreshing"];
const isTabOverride = (r: Row) => !!r.controllerId?.startsWith("tab:");
/** Paused, stopped or finished: Start resumes the run instead of starting a new one. */
const resumes = (status: string | undefined) => status === "stopped" || status === "completed" || !!status?.startsWith("paused");

function ControllerCell({ row: r }: { row: Row }) {
  if (isTabOverride(r)) return <>Tab-specific</>;
  if (r.controllerName) return <a href={`#/builder/${r.controllerId}`}>{r.controllerName}</a>;
  return <span className="muted">—</span>;
}

function LastEvaluation({ rt }: { rt: TabRuntime | null }) {
  return (
    <>
      {rt?.lastEvaluation ? (
        <span title={rt.lastEvaluation.reason}>
          {rt.lastEvaluation.status} · {formatTime(rt.lastEvaluation.at)}
        </span>
      ) : (
        <span className="muted">—</span>
      )}
      {rt?.lastError && <div style={{ color: "var(--error)" }}>{rt.lastError}</div>}
    </>
  );
}

function RowActions({ row: r, act }: { row: Row; act: Act }) {
  const status = r.runtime?.status;
  const running = !!status && RUNNING_STATES.includes(status);
  const tabId = r.tab.id;
  return (
    <div className="row" style={{ flexWrap: "nowrap" }}>
      {!r.tab.restricted && !running && (
        <button className="small" onClick={() => act(resumes(status) ? "resumeTab" : "startTab", { tabId })}>
          {status?.startsWith("paused") ? "Resume" : "Start"}
        </button>
      )}
      {running && (
        <button className="small" onClick={() => act("pauseTab", { tabId })}>
          Pause
        </button>
      )}
      {running && (
        <button className="small" onClick={() => act("stopTab", { tabId })}>
          Stop
        </button>
      )}
      {!r.tab.restricted && (
        <button className="small" onClick={() => act("refreshNow", { tabId })}>
          Refresh
        </button>
      )}
      {isTabOverride(r) && (
        <button className="small" onClick={() => act("clearTabOverride", { tabId })} title="Remove tab-specific settings">
          Reset
        </button>
      )}
    </div>
  );
}

const hostOfUrl = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** A running tab JustRefresh can't see into: it won't refresh until allowed (the dashboard stays open for Chrome's prompt). */
function AccessNeeded({ url }: { url: string }) {
  const origin = originOf(url);
  const [filesOff, setFilesOff] = useState(false);
  useEffect(() => {
    if (origin === "file:///*") void fileAccessAllowed().then((ok) => setFilesOff(!ok));
  }, [origin]);
  return (
    <div className="small warn-text" style={{ maxWidth: 220 }}>
      No site access: won't refresh until you allow it.{" "}
      {filesOff ? (
        // Chrome lets extensions into local files only with its "Allow access to file URLs" switch.
        <button className="link small" onClick={openChromeSiteAccess}>
          Turn on file access in Chrome's settings
        </button>
      ) : (
        origin && (
          <button
            className="link small"
            onClick={() => {
              cancelAfterAccessFor([origin]);
              void requestOrigins([origin]).catch(() => false);
            }}
          >
            Allow access
          </button>
        )
      )}
    </div>
  );
}

function TabRow({ row: r, now, checked, onSelect, act }: { row: Row; now: number; checked: boolean; onSelect: (on: boolean) => void; act: Act }) {
  const next = nextRefreshAt(r.runtime);
  return (
    <tr>
      <td>
        <input type="checkbox" aria-label={`Select ${r.tab.title}`} checked={checked} onChange={(e) => onSelect(e.target.checked)} />
      </td>
      <td style={{ maxWidth: 360 }}>
        <div className="truncate">
          <strong>{r.tab.title || "Untitled"}</strong>
        </div>
        <div className="truncate muted small">{r.tab.url}</div>
      </td>
      <td>
        <StatusPill status={r.status} />
        {r.needsAccess && <AccessNeeded url={r.tab.url} />}
        {r.reason && (
          <div className="small muted" style={{ maxWidth: 220 }}>
            {r.reason}
          </div>
        )}
      </td>
      <td className="small">
        <ControllerCell row={r} />
      </td>
      <td className="mono">{next !== Infinity ? formatDuration(next - now) : "—"}</td>
      <td>{r.runtime?.refreshCount ?? 0}</td>
      <td className="small">
        <LastEvaluation rt={r.runtime} />
      </td>
      <td>
        <RowActions row={r} act={act} />
      </td>
    </tr>
  );
}

/**
 * When the next refresh is due (Infinity = none). A tab paused on a submitted
 * form has no next refresh: its stored time is only when a time limit ends it.
 */
function nextRefreshAt(rt: TabRuntime | null | undefined): number {
  if (!rt?.nextDueAt || rt.status === "paused_resubmit") return Infinity;
  return rt.nextDueAt;
}
