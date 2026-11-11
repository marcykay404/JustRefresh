import { useEffect, useState } from "react";
import { api, originOf, requestOrigins } from "../shared/api";
import { useApi, useNow } from "../shared/hooks";
import { formatDuration, formatTime } from "../shared/format";
import { ErrorBox, StatusPill, Toggle } from "../shared/components";
import { FAST_INTERVAL_PRESETS, INTERVAL_PRESETS } from "../../core/defaults";
import type { SafetyConfig, Settings, TabInfo, TabOverride, TabRuntime } from "../../core/types";

interface TabState {
  tab: TabInfo;
  runtime: TabRuntime | null;
  statusLabel: string;
  resolution: {
    kind: string;
    reason?: string;
    controllerId: string | null;
    controllerName: string | null;
    source: "tab" | "rule" | null;
    candidates: { id: string; name: string; priority: number }[];
  };
  override: TabOverride | null;
  interval: number | null;
  safety: SafetyConfig;
  hostAccess: boolean;
}

interface Overview {
  settings: Settings;
  counts: { running: number; paused: number; stopped: number; excluded: number };
  pendingApprovals: number;
  pendingAgents: number;
}

const UNITS = [
  { label: "sec", factor: 1 },
  { label: "min", factor: 60 },
  { label: "hr", factor: 3600 },
];

function openDashboard(hash = "/tabs") {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html#${hash}`) });
  window.close();
}

export function Popup() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTabId(t?.id ?? null));
  }, []);

  const state = useApi<TabState>("getTabState", tabId !== null ? { tabId } : undefined, { skip: tabId === null, pollMs: 2000 });
  const overview = useApi<Overview>("getOverview", undefined, { pollMs: 4000 });
  const s = state.data;

  const [customValue, setCustomValue] = useState("");
  const [customUnit, setCustomUnit] = useState(60);
  /** Interval picked while auto refresh is off: applied when the user turns it on. */
  const [chosenInterval, setChosenInterval] = useState<number | null>(null);
  /** The site-access prompt was declined for the interval in here. */
  const [declinedFor, setDeclinedFor] = useState<number | null>(null);

  const run = async (method: string, params?: unknown) => {
    setError(null);
    setMessage(null);
    try {
      const r = await api(method, params);
      await Promise.all([state.reload(), overview.reload()]);
      return r;
    } catch (e) {
      setError(e);
      return null;
    }
  };

  if (tabId === null || !s) {
    return (
      <div className="popup-root">
        <Header overview={overview.data} onToggleGlobal={() => undefined} />
        {state.error ? <ErrorBox error={state.error} /> : <div className="muted">Loading…</div>}
      </div>
    );
  }

  const rt = s.runtime;
  const status = rt?.status ?? (s.resolution.kind.endsWith("excluded") || s.resolution.kind === "restricted" ? "excluded" : "idle");
  const restricted = s.resolution.kind === "restricted";
  const active = !!rt && ["scheduled", "evaluating", "refreshing"].includes(rt.status) || (rt?.status.startsWith("paused") ?? false);
  const tabExcluded = s.override?.mode === "excluded";
  const currentInterval = s.override?.intervalSeconds ?? s.interval ?? overview.data?.settings.defaultIntervalSeconds ?? 300;
  const shownInterval = active ? currentInterval : (chosenInterval ?? currentInterval);
  const origin = originOf(s.tab.url);
  const unprotected = !s.hostAccess && s.safety.onActivityUnavailable === "refresh";
  // Without site access the default safety policy pauses every refresh: say so and offer a choice.
  const blockedByAccess =
    declinedFor !== null || (!s.hostAccess && rt?.status === "paused_activity" && s.safety.onActivityUnavailable !== "refresh");

  /**
   * Enabling requests site access in the same click (user gesture). If the
   * user declines, nothing starts silently: the popup explains and offers to
   * refresh without protection instead.
   */
  const enable = (intervalSeconds: number) => {
    if (s.hostAccess || !origin) {
      void run("startTab", { tabId, intervalSeconds });
      return;
    }
    void requestOrigins([origin])
      .catch(() => false)
      .then((granted) => {
        if (granted) {
          setDeclinedFor(null);
          void run("startTab", { tabId, intervalSeconds });
        } else {
          setDeclinedFor(intervalSeconds);
        }
      });
  };

  const startUnprotected = async () => {
    await run("startTab", { tabId, intervalSeconds: declinedFor ?? shownInterval, safety: { onActivityUnavailable: "refresh" } });
    setDeclinedFor(null);
  };

  const fastAllowed = overview.data?.settings.allowFastIntervals === true;
  const minSeconds = fastAllowed ? 5 : 30;
  const presets = fastAllowed ? [...FAST_INTERVAL_PRESETS, ...INTERVAL_PRESETS] : INTERVAL_PRESETS;

  /** Changing the interval applies at once only while auto refresh is on. */
  const setInterval = (seconds: number) => {
    if (seconds < minSeconds) {
      setError(
        new Error(
          fastAllowed
            ? "The minimum interval is 5 seconds"
            : "The minimum interval is 30 seconds (shorter intervals can be enabled in Dashboard → Settings → Advanced)",
        ),
      );
      return;
    }
    if (active) enable(seconds);
    else setChosenInterval(seconds);
  };

  const refreshNow = async () => {
    const r = (await run("refreshNow", { tabId })) as { refreshed: boolean; reason?: string } | null;
    if (r && !r.refreshed) {
      if (confirm(`${r.reason ?? "Refresh blocked"}.\n\nRefresh anyway? Unsaved changes may be lost.`)) {
        await run("refreshNow", { tabId, force: true });
      }
    }
  };

  const toggleProtection = (on: boolean) =>
    run("setTabSafety", { tabId, safety: { pauseWhileTyping: on, protectUnsavedChanges: on } });

  const countdown = rt?.nextDueAt ? rt.nextDueAt - now : null;

  return (
    <div className="popup-root">
      <Header
        overview={overview.data}
        onToggleGlobal={() => void run(overview.data?.settings.paused ? "resumeAll" : "pauseAll")}
      />

      <div className="card col">
        <div className="col" style={{ gap: 2 }}>
          <strong className="truncate" title={s.tab.title}>{s.tab.title || "Untitled tab"}</strong>
          <span className="muted small truncate" title={s.tab.url}>{s.tab.url}</span>
        </div>

        <div className="row">
          <StatusPill status={status} />
          {s.resolution.source === "rule" && (
            <span className="small">
              Rule: <a href="#" onClick={(e) => { e.preventDefault(); openDashboard(`/builder/${s.resolution.controllerId}`); }}>{s.resolution.controllerName}</a>
            </span>
          )}
          {s.resolution.source === "tab" && <span className="small muted">Tab-specific settings</span>}
          {s.resolution.source === "tab" && s.resolution.candidates.length > 0 && (
            <span className="small muted">(overrides {s.resolution.candidates[0].name})</span>
          )}
        </div>
        {(rt?.reason || (!rt && s.resolution.reason)) && <div className="small muted">{rt?.reason ?? s.resolution.reason}</div>}

        {restricted ? (
          <div className="notice small">This page cannot be refreshed by extensions.</div>
        ) : (
          <>
            <div className="row">
              <Toggle
                checked={active}
                disabled={tabExcluded}
                label="Auto refresh"
                onChange={(on) => {
                  // A rule-controlled tab is resumed under its rule (keeping its conditions);
                  // only uncontrolled tabs get tab-specific settings.
                  if (on && s.resolution.source === "rule" && chosenInterval === null) void run("resumeTab", { tabId });
                  else if (on) enable(shownInterval);
                  else void run("stopTab", { tabId });
                }}
              />
              <span className="spacer" />
              {countdown !== null && active && rt?.status !== "refreshing" && (
                <span className="countdown" title={`Next refresh at ${formatTime(rt?.nextDueAt)}`}>{formatDuration(countdown)}</span>
              )}
              {rt?.status === "refreshing" && <span className="muted">Refreshing…</span>}
            </div>

            <div className="row">
              <select
                aria-label="Refresh interval"
                value={presets.some((p) => p.seconds === shownInterval) ? shownInterval : "custom"}
                onChange={(e) => e.target.value !== "custom" && setInterval(Number(e.target.value))}
              >
                {presets.map((p) => (
                  <option key={p.seconds} value={p.seconds}>Every {p.label}</option>
                ))}
                {!presets.some((p) => p.seconds === shownInterval) && <option value="custom">Every {shownInterval}s</option>}
              </select>
              <input
                aria-label="Custom interval"
                style={{ width: 64 }}
                type="number"
                min={customUnit === 1 ? minSeconds : 1}
                placeholder="Custom"
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
              />
              <select aria-label="Custom interval unit" value={customUnit} onChange={(e) => setCustomUnit(Number(e.target.value))}>
                {UNITS.map((u) => <option key={u.factor} value={u.factor}>{u.label}</option>)}
              </select>
              <button className="small" disabled={!customValue} onClick={() => setInterval(Math.round(Number(customValue) * customUnit))}>Set</button>
            </div>
            {!active && chosenInterval !== null && <div className="small muted">Turn on Auto refresh to start with this interval.</div>}
            {s.resolution.source === "rule" && <div className="small muted">Changing the interval creates a tab-specific override of the rule.</div>}

            {blockedByAccess && origin && (
              <div className="notice small col">
                <span>
                  Without access to this site, JustRefresh can't see typing or unsaved forms here, so by default it won't refresh this page.
                </span>
                <div className="row">
                  <button className="small" onClick={() => void requestOrigins([origin]).then((ok) => ok && (declinedFor !== null ? enable(declinedFor) : void run("resumeTab", { tabId })))}>
                    Grant access
                  </button>
                  <button className="small" onClick={() => void startUnprotected()}>Refresh without protection</button>
                </div>
              </div>
            )}
            {unprotected && active && !blockedByAccess && (
              <div className="small muted">Refreshing without activity protection (no site access): typing and unsaved forms on this page are not detected.</div>
            )}

            <div className="btn-grid">
              {rt?.status === "paused_user" ? (
                <button onClick={() => run("resumeTab", { tabId })}>Resume</button>
              ) : (
                <button disabled={!active} onClick={() => run("pauseTab", { tabId })}>Pause</button>
              )}
              <button onClick={refreshNow}>Refresh now</button>
              {tabExcluded ? (
                <button onClick={() => run("includeTab", { tabId })}>Include tab</button>
              ) : (
                <button onClick={() => run("excludeTab", { tabId })} title="Temporarily exclude this tab from all rules">Exclude tab</button>
              )}
              {rt && ["paused_unknown", "paused_activity", "completed", "stopped", "error"].includes(rt.status) ? (
                <button onClick={() => run("resumeTab", { tabId })}>{rt.status === "completed" || rt.status === "stopped" ? "Restart" : "Retry now"}</button>
              ) : (
                <button disabled={!s.resolution.controllerId} onClick={() => run("runNow", { tabId })} title="Evaluate conditions and run actions now">Run rule now</button>
              )}
            </div>

            {rt?.status === "paused_unsaved" && (
              <div className="notice small row">
                <span>Possible unsaved changes on this page.</span>
                <button className="small" onClick={() => confirm("Refresh even though changes may be lost?") && run("allowUnsavedOnce", { tabId })}>Refresh anyway</button>
              </div>
            )}

            <Toggle
              checked={s.safety.pauseWhileTyping && s.safety.protectUnsavedChanges}
              onChange={toggleProtection}
              disabled={s.resolution.source === "rule"}
              label={<span>Smart activity protection <span className="muted small">(pause while typing, protect unsaved forms)</span></span>}
            />

            {!s.hostAccess && origin && !blockedByAccess && !unprotected && (
              <div className="info small row">
                <span>Grant site access to enable activity protection and page conditions.</span>
                <button className="small" onClick={() => void requestOrigins([origin]).then(() => state.reload())}>Grant access</button>
              </div>
            )}

            {rt && (
              <div className="small muted">
                Refreshes: {rt.refreshCount} · Last attempt: {formatTime(rt.lastAttemptAt)}
                {rt.lastEvaluation && <> · Condition: {rt.lastEvaluation.status}</>}
                {rt.lastError && <div style={{ color: "var(--error)" }}>{rt.lastError}</div>}
              </div>
            )}
          </>
        )}
      </div>

      <ErrorBox error={error} />
      {message && <div className="info small">{message}</div>}

      <div className="row">
        <button onClick={() => openDashboard(`/builder?url=${encodeURIComponent(s.tab.url)}`)}>Create rule for this page</button>
        <span className="spacer" />
        <button onClick={() => openDashboard()}>Dashboard</button>
      </div>
    </div>
  );
}

function Header({ overview, onToggleGlobal }: { overview: Overview | null; onToggleGlobal: () => void }) {
  const pending = (overview?.pendingApprovals ?? 0) + (overview?.pendingAgents ?? 0);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="popup-header">
        <img src="icons/icon32.png" alt="" />
        <strong>JustRefresh</strong>
        <span className="spacer" />
        {overview && (
          <button className="small" onClick={onToggleGlobal} title="Pause or resume all refreshing">
            {overview.settings.paused ? "Resume all" : "Pause all"}
          </button>
        )}
      </div>
      {overview && (
        <div className="row small muted">
          <span>{overview.counts.running} running</span>·<span>{overview.counts.paused} paused</span>·<span>{overview.counts.stopped} stopped</span>
          {!overview.settings.enabled && <span className="pill pill-muted">Disabled</span>}
          {overview.settings.paused && <span className="pill pill-warn">All paused</span>}
          {pending > 0 && (
            <a href="#" onClick={(e) => { e.preventDefault(); openDashboard("/agents"); }}>
              <span className="badge">{pending}</span> agent request{pending > 1 ? "s" : ""}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
