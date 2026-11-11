import { useEffect, useState, type ReactNode } from "react";
import { api, originOf, requestOrigins } from "../shared/api";
import { useApi, useNow } from "../shared/hooks";
import { formatDuration, formatTime } from "../shared/format";
import { ErrorBox, Toggle } from "../shared/components";
import type { Rule, SafetyConfig, Settings, TabInfo, TabOverride, TabRuntime } from "../../core/types";
import { useDialog } from "../shared/dialog";
import { QueryChoice } from "../shared/QueryChoice";
import { describeRule, intervalChips, intervalLabel, priorityAbove, untilRule, type UntilMode } from "./describe";

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
  otherQueryRules?: { id: string; name: string }[];
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
  { label: "seconds", factor: 1 },
  { label: "minutes", factor: 60 },
  { label: "hours", factor: 3600 },
];

/** Statuses in which the tab is being looked after (counting down, checking or waiting). */
const RUNNING = ["scheduled", "evaluating", "refreshing", "paused_activity", "paused_unsaved", "paused_resubmit", "paused_unknown", "paused_user"];

function openDashboard(hash = "/tabs") {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html#${hash}`) });
  window.close();
}

/** "while you're typing or you have unsaved form changes", from whichever protections are on. */
export function protectedWhile(safety: Pick<SafetyConfig, "pauseWhileTyping" | "protectUnsavedChanges" | "pauseOnMouse" | "pauseOnScroll">): string {
  const parts = [
    safety.pauseWhileTyping && "you're typing",
    safety.protectUnsavedChanges && "you have unsaved form changes",
    safety.pauseOnMouse && "you're using the mouse",
    safety.pauseOnScroll && "you're scrolling",
  ].filter((p): p is string => !!p);
  if (parts.length === 0) return "";
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
  return `while ${list}`;
}

export function Popup() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const now = useNow(1000);
  const dialog = useDialog();

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTabId(t?.id ?? null));
  }, []);

  const state = useApi<TabState>("getTabState", tabId !== null ? { tabId } : undefined, { skip: tabId === null, live: ["runtime", "config", "tabs", "access"] });
  const overview = useApi<Overview>("getOverview", undefined, { live: ["runtime", "config", "tabs"] });
  const s = state.data;
  const ruleId = s?.resolution.source === "rule" ? s.resolution.controllerId : null;
  const rule = useApi<Rule>("getRule", ruleId ? { id: ruleId } : undefined, { skip: !ruleId, live: ["config"] });

  /** Interval picked in the chips (null = the tab's current one). */
  const [picked, setPicked] = useState<number | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [customUnit, setCustomUnit] = useState(60);
  /** Changing the interval of a tab that is already refreshing. */
  const [changing, setChanging] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [view, setView] = useState<"main" | "until">("main");
  /** The site-access prompt was declined for the interval in here. */
  const [declinedFor, setDeclinedFor] = useState<number | null>(null);

  const run = async (method: string, params?: unknown) => {
    setError(null);
    try {
      const r = await api(method, params);
      await Promise.all([state.reload(), overview.reload()]);
      return r;
    } catch (e) {
      setError(e);
      return null;
    }
  };

  const header = <Header overview={overview.data} onToggleGlobal={() => void run(overview.data?.settings.paused ? "resumeAll" : "pauseAll")} />;
  if (tabId === null || !s) {
    return (
      <div className="popup-root">
        {header}
        {state.error ? <ErrorBox error={state.error} /> : <div className="muted">Loading…</div>}
      </div>
    );
  }

  const rt = s.runtime;
  const source = s.resolution.source;
  const restricted = s.resolution.kind === "restricted";
  const tabExcluded = s.override?.mode === "excluded";
  const running = !!rt && RUNNING.includes(rt.status);
  // The interval actually in effect (fast intervals are clamped to 30 s while they're turned off).
  const currentInterval = s.interval ?? s.override?.intervalSeconds ?? overview.data?.settings.defaultIntervalSeconds ?? 300;
  const kind = s.resolution.kind;
  /** Nothing runs here right now for a reason that Start can't fix. */
  const blockedKind = kind === "paused" || kind === "disabled" || kind === "url_excluded" ? kind : null;
  const origin = originOf(s.tab.url);
  const siteName = origin === "file:///*" ? "local files" : hostLabel(s.tab.url);
  const protectionOn = s.safety.pauseWhileTyping || s.safety.protectUnsavedChanges || s.safety.pauseOnMouse || s.safety.pauseOnScroll;
  const unprotected = !s.hostAccess && s.safety.onActivityUnavailable === "refresh";
  // Without site access the default safety policy pauses every refresh: say so and offer a choice.
  const blockedByAccess = declinedFor !== null || (!s.hostAccess && rt?.status === "paused_activity" && s.safety.onActivityUnavailable !== "refresh");

  const fastAllowed = overview.data?.settings.allowFastIntervals === true;
  const minSeconds = fastAllowed ? 5 : 30;
  const chips = intervalChips(fastAllowed);
  const customSeconds = customOpen && customValue ? Math.round(Number(customValue) * customUnit) : null;
  const chosen = customSeconds ?? picked ?? currentInterval;
  const chosenValid = Number.isFinite(chosen) && chosen >= minSeconds;
  const tooShort = !chosenValid
    ? fastAllowed
      ? "The shortest interval is 5 seconds."
      : "The shortest interval is 30 seconds. Shorter ones can be turned on in Dashboard → Settings → Advanced."
    : null;

  const resetPicker = () => {
    setPicked(null);
    setCustomOpen(false);
    setCustomValue("");
  };

  /**
   * Starting requests site access in the same click (user gesture) when
   * protection needs it. If the user declines, nothing starts silently: the
   * popup explains and offers to refresh without protection instead.
   */
  const start = (intervalSeconds: number, alreadyGranted = false) => {
    // No protection means nothing reads the page, so there is nothing to ask for.
    // `alreadyGranted`: access was just granted in this click; asking again
    // (outside the click) could be refused by Chrome.
    if (alreadyGranted || s.hostAccess || !origin || !protectionOn) {
      setDeclinedFor(null);
      void run("startTab", { tabId, intervalSeconds }).then(() => {
        resetPicker();
        setChanging(false);
      });
      return;
    }
    void requestOrigins([origin])
      .catch(() => false)
      .then((granted) => {
        if (granted) {
          setDeclinedFor(null);
          void run("startTab", { tabId, intervalSeconds }).then(() => {
            resetPicker();
            setChanging(false);
          });
        } else {
          setDeclinedFor(intervalSeconds);
        }
      });
  };

  const startUnprotected = async () => {
    await run("startTab", { tabId, intervalSeconds: declinedFor ?? chosen, safety: { onActivityUnavailable: "refresh" } });
    setDeclinedFor(null);
  };

  const openFresh = () => void run("openFresh", { tabId });

  const refreshNow = async () => {
    const r = (await run("refreshNow", { tabId })) as { refreshed: boolean; reason?: string; formResult?: boolean } | null;
    if (r && !r.refreshed && r.formResult) {
      const ok = await dialog.confirm({
        title: "Open this page fresh instead?",
        message:
          "This page came from submitting a form. Refreshing it could send the form again, for example placing a second order. Opening it fresh loads the address as a normal visit, so nothing is sent again; the page may look different.",
        confirmLabel: "Open this page fresh",
      });
      if (ok) openFresh();
      return;
    }
    if (r && !r.refreshed) {
      const ok = await dialog.confirm({
        title: "Refresh anyway?",
        message: `${r.reason ?? "Refresh blocked"}. Refreshing now may lose unsaved changes on this page.`,
        confirmLabel: "Refresh anyway",
        danger: true,
      });
      if (ok) await run("refreshNow", { tabId, force: true });
    }
  };

  const toggleProtection = (on: boolean) => run("setTabSafety", { tabId, safety: { pauseWhileTyping: on, protectUnsavedChanges: on } });

  const countdown = rt?.nextDueAt ? Math.max(0, rt.nextDueAt - now) : null;
  const total = s.interval ?? currentInterval;
  const progress = countdown !== null && total ? Math.min(100, Math.max(0, 100 - (countdown / (total * 1000)) * 100)) : 0;

  const picker = (
    <IntervalPicker
      chips={chips}
      value={chosen}
      customOpen={customOpen}
      customValue={customValue}
      customUnit={customUnit}
      minSeconds={minSeconds}
      onPick={(v) => {
        setPicked(v);
        setCustomOpen(false);
      }}
      onCustom={() => {
        setCustomOpen(true);
        if (!customValue) {
          const unit = chosen % 3600 === 0 ? 3600 : chosen % 60 === 0 ? 60 : 1;
          setCustomUnit(unit);
          setCustomValue(String(chosen / unit));
        }
      }}
      onCustomValue={setCustomValue}
      onCustomUnit={setCustomUnit}
    />
  );

  /* ---------- main card ---------- */
  let card: ReactNode;
  if (restricted) {
    card = <p className="muted" style={{ margin: 0 }}>Chrome doesn't let extensions refresh this page.</p>;
  } else if (tabExcluded) {
    card = (
      <>
        <span>This tab is set to never auto-refresh, so rules skip it.</span>
        <button onClick={() => void run("includeTab", { tabId })}>Allow auto-refresh again</button>
      </>
    );
  } else if (blockedKind === "paused") {
    card = (
      <>
        <span className="card-title">All refreshing is paused</span>
        <span className="small muted">
          {s.resolution.controllerName ? `When you resume, “${s.resolution.controllerName}” carries on here.` : "Nothing refreshes until you resume."}
        </span>
        <button className="primary big" onClick={() => void run("resumeAll")}>Resume all refreshing</button>
      </>
    );
  } else if (blockedKind === "disabled") {
    card = (
      <>
        <span className="card-title">JustRefresh is switched off</span>
        <span className="small muted">Auto refresh is turned off in Settings, so no tab refreshes.</span>
        <button className="primary big" onClick={() => void run("updateSettings", { enabled: true })}>Turn auto refresh on</button>
      </>
    );
  } else if (blockedKind === "url_excluded") {
    card = (
      <>
        <span className="card-title">This page is excluded</span>
        <span className="small muted">{s.resolution.reason ?? "An exclusion matches this page"}, so nothing refreshes it.</span>
        <button className="big" onClick={() => openDashboard("/exclusions")}>Manage exclusions</button>
      </>
    );
  } else if (view === "until") {
    card = (
      <UntilForm
        site={siteName}
        url={s.tab.url}
        picker={picker}
        canStart={chosenValid}
        problem={tooShort}
        onCancel={() => setView("main")}
        onStart={async (text, mode, anyQuery) => {
          setError(null);
          if (!s.hostAccess && origin) {
            const granted = await requestOrigins([origin]).catch(() => false);
            if (!granted) {
              setError(new Error(`JustRefresh needs access to ${siteName} to read the page. Nothing was set up.`));
              return;
            }
          }
          const stopAfter = overview.data?.settings.defaultStopAfterMinutes ?? null;
          const newRule = untilRule({
            url: s.tab.url,
            site: siteName,
            seconds: chosen,
            text,
            mode,
            // Outrank rules already matching this page, or the new one would never run here.
            priority: priorityAbove(s.resolution.candidates),
            stopAfterSeconds: stopAfter ? stopAfter * 60 : null,
            anyQuery,
          });
          const created = (await run("createRule", { rule: newRule })) as Rule | null;
          if (!created) return;
          // A tab-specific timer outranks rules, so hand the tab over to the new rule.
          if (s.override?.mode === "custom") await run("clearTabOverride", { tabId });
          const after = (await api("getTabState", { tabId }).catch(() => null)) as TabState | null;
          if (after && after.resolution.controllerId !== created.id) {
            setError(new Error(`The rule was saved, but “${after.resolution.controllerName ?? "another rule"}” still controls this tab. Raise the new rule's priority in the Rule Builder.`));
          } else {
            await run("runNow", { tabId });
          }
          resetPicker();
          setView("main");
        }}
      />
    );
  } else if (source === "rule") {
    card = (
      <RuleCard
        name={s.resolution.controllerName ?? rule.data?.name ?? "Rule"}
        summary={rule.data ? describeRule(rule.data, s.interval) : null}
        onEdit={() => openDashboard(`/builder/${ruleId}`)}
        rt={rt}
        countdown={countdown}
        progress={progress}
        onCheckNow={() => void run("runNow", { tabId })}
        onStop={() => void run("stopTab", { tabId })}
        onRestart={() => void run("resumeTab", { tabId })}
      />
    );
  } else if (running && !changing) {
    card = (
      <>
        {rt?.status === "paused_resubmit" ? (
          <CountdownRow
            title="Paused on a submitted form"
            rt={rt}
            countdown={null}
            subtitle={`Refreshing every ${intervalLabel(currentInterval)} starts again when this tab goes to another page`}
          />
        ) : (
          <>
            <CountdownRow title={`Refreshing every ${intervalLabel(currentInterval)}`} rt={rt} countdown={countdown} />
            <div className="progress" aria-hidden>
              <div style={{ width: `${progress}%` }} />
            </div>
          </>
        )}
        {rt?.status === "paused_user" ? (
          <button className="primary big" onClick={() => void run("resumeTab", { tabId })}>Resume</button>
        ) : (
          <div className="row">
            <button className="big grow" onClick={() => void run("stopTab", { tabId })}>Stop</button>
            <button className="big" onClick={() => setChanging(true)}>Change interval</button>
          </div>
        )}
        {rt && <Stats rt={rt} />}
      </>
    );
  } else {
    card = (
      <>
        <span className="card-title">{changing ? "Change the interval" : "Refresh this tab every"}</span>
        {picker}
        {tooShort && <span className="small field-error">{tooShort}</span>}
        <button className="primary big" disabled={!chosenValid} onClick={() => start(chosen)}>
          {changing ? `Refresh every ${intervalLabel(chosen)}` : `Start refreshing every ${intervalLabel(chosen)}`}
        </button>
        {changing && (
          <button className="link small" style={{ alignSelf: "center" }} onClick={() => { resetPicker(); setChanging(false); }}>
            Cancel
          </button>
        )}
        {rt?.status === "completed" && <span className="small muted">{rt.reason ?? "Finished."}</span>}
      </>
    );
  }

  return (
    <div className="popup-root">
      {header}

      <div className="col" style={{ gap: 2 }}>
        <strong className="popup-site truncate">{siteName || s.tab.title || "This tab"}</strong>
        <span className="muted small truncate" title={s.tab.url}>
          {s.tab.title ? `${s.tab.title} · ` : ""}
          {shortUrl(s.tab.url)}
        </span>
      </div>

      <section className="card col popup-card">{card}</section>

      {view === "main" && !restricted && <OtherQueryNotice rules={s.otherQueryRules ?? []} onEdit={(id) => openDashboard(`/builder/${id}`)} />}

      {!restricted && view === "main" && (
        <>
          <WaitingNotice
            rt={rt}
            grace={s.safety.inactivityGraceSeconds}
            onRefreshAnyway={async () =>
              (await dialog.confirm({
                title: "Refresh anyway?",
                message: "This page may have unsaved changes. Refreshing will lose them.",
                confirmLabel: "Refresh anyway",
                danger: true,
              })) && run("allowUnsavedOnce", { tabId })
            }
            onRetry={() => void run("resumeTab", { tabId })}
            onOpenFresh={openFresh}
            hidden={blockedByAccess}
          />

          {blockedByAccess && origin && (
            <div className="notice small col">
              <span>
                JustRefresh can't see inside <strong>{siteName}</strong>, so it can't tell whether you're typing or have unsaved form changes. To be safe,
                it won't refresh this page until you allow access.
              </span>
              <div className="row">
                <button className="small" onClick={() => void requestOrigins([origin]).then((ok) => ok && (declinedFor !== null ? start(declinedFor, true) : void run("resumeTab", { tabId })))}>
                  Allow access
                </button>
                <button className="small" onClick={() => void startUnprotected()}>Refresh without protection</button>
              </div>
            </div>
          )}

          {!tabExcluded && !blockedByAccess && !blockedKind && (
            <ProtectionLine
              site={siteName}
              safety={s.safety}
              protectionOn={protectionOn}
              hostAccess={s.hostAccess}
              unprotected={unprotected}
              running={running}
              byRule={source === "rule"}
              needsAccessForRule={source === "rule" && !s.hostAccess}
              onToggle={toggleProtection}
              onAllow={() => origin && void requestOrigins([origin]).then(() => state.reload())}
              showAllow={!!origin}
            />
          )}

          <div className="btn-grid">
            <button onClick={refreshNow}>
              <RefreshIcon /> Refresh now
            </button>
            <button aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
              More <Chevron up={moreOpen} />
            </button>
          </div>

          {moreOpen && (
            <nav className="menu" aria-label="More actions">
              {source !== "rule" && !tabExcluded && !blockedKind && origin && origin !== "file:///*" && (
                <button onClick={() => { setView("until"); setMoreOpen(false); }}>
                  <strong>Refresh until something appears…</strong>
                  <span>e.g. stop and notify me when “In stock” shows up</span>
                </button>
              )}
              {!tabExcluded && (
                <button onClick={() => { void run("excludeTab", { tabId }); setMoreOpen(false); }}>
                  <strong>Never auto-refresh this tab</strong>
                  <span>Rules for this site will skip it until you allow it again</span>
                </button>
              )}
              <button onClick={() => openDashboard(`/builder?url=${encodeURIComponent(s.tab.url)}`)}>
                <strong>Make a rule for {siteName || "this page"}…</strong>
                <span>Opens the Rule Builder for more options</span>
              </button>
            </nav>
          )}
        </>
      )}

      <ErrorBox error={error} />

      <Footer overview={overview.data} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** "youtube.com/watch?v=…" without the scheme. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "");
}

function Header({ overview, onToggleGlobal }: { overview: Overview | null; onToggleGlobal: () => void }) {
  const paused = !!overview?.settings.paused;
  return (
    <div className="popup-header">
      <img src="icons/icon32.png" alt="" />
      <strong>JustRefresh</strong>
      {paused && <span className="pill pill-warn">All paused</span>}
      {overview && !overview.settings.enabled && <span className="pill pill-muted">Off</span>}
      <span className="spacer" />
      {overview && (
        <button className="icon-btn" onClick={onToggleGlobal} aria-label={paused ? "Resume all refreshing" : "Pause all refreshing"} title={paused ? "Resume all refreshing" : "Pause all refreshing"}>
          {paused ? (
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5l12 7-12 7z" fill="currentColor" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
          )}
        </button>
      )}
      <button className="icon-btn" onClick={() => openDashboard()} aria-label="Open dashboard" title="Open dashboard">
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
        </svg>
      </button>
    </div>
  );
}

function Footer({ overview }: { overview: Overview | null }) {
  if (!overview) return null;
  const { running, paused } = overview.counts;
  const pending = overview.pendingApprovals + overview.pendingAgents;
  return (
    <footer className="popup-footer small muted">
      <span>
        {running} tab{running === 1 ? "" : "s"} refreshing{paused ? ` · ${paused} waiting` : ""}
      </span>
      {pending > 0 && (
        <a href="#" onClick={(e) => { e.preventDefault(); openDashboard("/agents"); }}>
          <span className="badge">{pending}</span> agent request{pending > 1 ? "s" : ""}
        </a>
      )}
      <span className="spacer" />
      <a href="#" onClick={(e) => { e.preventDefault(); openDashboard(); }}>Open dashboard</a>
    </footer>
  );
}

function IntervalPicker(p: {
  chips: number[];
  value: number;
  customOpen: boolean;
  customValue: string;
  customUnit: number;
  minSeconds: number;
  onPick: (v: number) => void;
  onCustom: () => void;
  onCustomValue: (v: string) => void;
  onCustomUnit: (v: number) => void;
}) {
  const isChip = !p.customOpen && p.chips.includes(p.value);
  return (
    <>
      <div className="chips" role="group" aria-label="Refresh interval">
        {p.chips.map((c) => (
          <button type="button" key={c} className={`chip${isChip && p.value === c ? " selected" : ""}`} aria-pressed={isChip && p.value === c} onClick={() => p.onPick(c)}>
            {intervalLabel(c)}
          </button>
        ))}
        <button type="button" className={`chip${!isChip ? " selected" : ""}`} aria-pressed={!isChip} onClick={p.onCustom}>
          {!isChip && !p.customOpen ? intervalLabel(p.value) : "Custom…"}
        </button>
      </div>
      {p.customOpen && (
        <div className="row">
          <label htmlFor="custom-interval" className="muted">Every</label>
          <input
            id="custom-interval"
            type="number"
            min={p.customUnit === 1 ? p.minSeconds : 1}
            style={{ width: 80 }}
            value={p.customValue}
            onChange={(e) => p.onCustomValue(e.target.value)}
            autoFocus
          />
          <select aria-label="Unit" value={p.customUnit} onChange={(e) => p.onCustomUnit(Number(e.target.value))}>
            {UNITS.map((u) => <option key={u.factor} value={u.factor}>{u.label}</option>)}
          </select>
        </div>
      )}
    </>
  );
}

function CountdownRow({ title, rt, countdown, subtitle }: { title: ReactNode; rt: TabRuntime | null; countdown: number | null; subtitle?: ReactNode }) {
  const waiting = rt?.status.startsWith("paused") && rt.status !== "paused_user";
  return (
    <div className="countdown-row">
      <div className="col" style={{ gap: 0, minWidth: 0 }}>
        <span className="card-title">{title}</span>
        <span className={`small ${waiting ? "warn-text" : "muted"}`}>
          {subtitle ??
            (rt?.status === "refreshing"
              ? "Refreshing now…"
              : rt?.status === "evaluating"
                ? "Checking the page…"
                : rt?.status === "paused_user"
                  ? "Paused"
                  : waiting
                    ? "Waiting for you"
                    : "Next refresh in")}
        </span>
      </div>
      <span className="spacer" />
      {countdown !== null && !waiting && rt?.status !== "refreshing" && rt?.status !== "paused_user" && (
        <span className="countdown" title={`Next refresh at ${formatTime(rt?.nextDueAt)}`}>{formatDuration(countdown)}</span>
      )}
    </div>
  );
}

function Stats({ rt, rule }: { rt: TabRuntime; rule?: boolean }) {
  const last = rt.lastAttemptAt ? ` · last checked ${formatTime(rt.lastAttemptAt)}` : "";
  if (rule) {
    const found = rt.lastEvaluation?.status === "matched" ? "found" : rt.lastEvaluation?.status === "unknown" ? "couldn't check" : "not found yet";
    return <span className="small muted">Refreshed {rt.refreshCount} time{rt.refreshCount === 1 ? "" : "s"} · {found}{last}</span>;
  }
  return <span className="small muted">Refreshed {rt.refreshCount} time{rt.refreshCount === 1 ? "" : "s"}{last}</span>;
}

function RuleCard(p: {
  name: string;
  summary: string | null;
  onEdit: () => void;
  rt: TabRuntime | null;
  countdown: number | null;
  progress: number;
  onCheckNow: () => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  const rt = p.rt;
  const active = !!rt && RUNNING.includes(rt.status);
  return (
    <>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <span className="pill pill-done">Rule</span>
        <strong className="truncate grow">{p.name}</strong>
        <a href="#" className="small" onClick={(e) => { e.preventDefault(); p.onEdit(); }}>Edit rule</a>
      </div>
      {active ? (
        <>
          {rt?.status === "paused_resubmit" ? (
            <CountdownRow title={p.summary ?? "Refreshing"} rt={rt} countdown={null} subtitle="Paused on a submitted form. The rule carries on if this tab goes to another page it covers." />
          ) : (
            <>
              <CountdownRow title={p.summary ?? "Refreshing"} rt={rt} countdown={p.countdown} />
              <div className="progress" aria-hidden>
                <div style={{ width: `${p.progress}%` }} />
              </div>
            </>
          )}
          {rt && <Stats rt={rt} rule />}
          <div className="row">
            <button className="big grow" onClick={p.onCheckNow}>Check now</button>
            <button className="big grow" onClick={p.onStop}>Stop on this tab</button>
          </div>
        </>
      ) : (
        <>
          {p.summary && <span>{p.summary}</span>}
          <span className="small muted">
            {rt?.status === "completed" ? (rt.reason ?? "Finished: the condition was found.") : rt?.status === "stopped" ? "Stopped on this tab." : (rt?.reason ?? "Not running on this tab yet.")}
          </span>
          <button className="primary big" onClick={p.onRestart}>
            {rt?.status === "completed" || rt?.status === "stopped" ? "Start again" : "Start"}
          </button>
        </>
      )}
    </>
  );
}

/** One plain sentence when JustRefresh is holding back, with the override right there. */
function WaitingNotice(p: { rt: TabRuntime | null; grace: number; onRefreshAnyway: () => void; onRetry: () => void; onOpenFresh: () => void; hidden: boolean }) {
  const rt = p.rt;
  if (!rt || p.hidden) return null;
  if (rt.status === "paused_resubmit") {
    return (
      <div className="notice col small">
        <span>
          This page came from submitting a form, such as an order or a payment. Refreshing it could send the form again, so JustRefresh won't refresh it.
        </span>
        <button className="small" style={{ alignSelf: "flex-start" }} onClick={p.onOpenFresh}>Open this page fresh</button>
        <span>Loads the address as a normal visit, so nothing is sent again. The page may look different.</span>
      </div>
    );
  }
  if (rt.status === "paused_unsaved") {
    return (
      <div className="notice col small">
        <span>This page may have a form you've started filling in. It won't refresh until you submit it, so nothing you typed is lost.</span>
        <button className="small" style={{ alignSelf: "flex-start" }} onClick={p.onRefreshAnyway}>Refresh anyway</button>
      </div>
    );
  }
  if (rt.status === "paused_activity") {
    return (
      <div className="notice small">
        {rt.reason ? `${rt.reason}. ` : ""}It refreshes once the page has been quiet for {intervalLabel(p.grace)}.
      </div>
    );
  }
  if (rt.status === "paused_unknown" || rt.status === "error") {
    return (
      <div className="notice col small">
        <span>{rt.status === "error" ? "Something went wrong" : "Couldn't check the page"}{rt.reason ? `: ${rt.reason}` : "."}</span>
        <button className="small" style={{ alignSelf: "flex-start" }} onClick={p.onRetry}>Try again now</button>
      </div>
    );
  }
  return null;
}

function ProtectionLine(p: {
  site: string;
  safety: SafetyConfig;
  protectionOn: boolean;
  hostAccess: boolean;
  unprotected: boolean;
  running: boolean;
  byRule: boolean;
  needsAccessForRule: boolean;
  onToggle: (on: boolean) => void;
  onAllow: () => void;
  showAllow: boolean;
}) {
  const allow = p.showAllow ? (
    <button className="small" onClick={p.onAllow}>Allow access</button>
  ) : null;
  let text: ReactNode;
  let ok = false;
  if (p.protectionOn && p.hostAccess) {
    ok = true;
    text = `${p.running ? "Protected: waits" : "Will wait"} ${protectedWhile(p.safety)}`;
  } else if (p.protectionOn && p.unprotected) {
    text = <>Refreshing without protection: JustRefresh can't see inside <strong>{p.site}</strong>, so typing isn't detected.</>;
  } else if (p.protectionOn || p.needsAccessForRule) {
    text = (
      <>
        JustRefresh can't see inside <strong>{p.site}</strong> yet. Allow it so refreshes wait while you're typing or have unsaved form changes
        {p.byRule ? ", and so this rule can check the page's content." : "."}
      </>
    );
  } else {
    text = <span className="muted">Protection off: refreshes even while you're typing.</span>;
  }
  const showAllow = !p.hostAccess && (p.protectionOn || p.needsAccessForRule);
  return (
    <div className="protection-line small">
      {ok && (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="ok-icon">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
      <div className="col grow" style={{ gap: 6 }}>
        <span>
          {text}
          {p.byRule && p.protectionOn && p.hostAccess && <span className="muted"> (set by the rule)</span>}
        </span>
        {showAllow && allow && <div>{allow}</div>}
      </div>
      {!p.byRule && <Toggle checked={p.safety.pauseWhileTyping && p.safety.protectUnsavedChanges} onChange={p.onToggle} label={<span className="sr-only">Wait while I'm typing or have unsaved form changes</span>} />}
    </div>
  );
}

function UntilForm(p: {
  site: string;
  url: string;
  picker: ReactNode;
  canStart: boolean;
  problem: string | null;
  onCancel: () => void;
  onStart: (text: string, mode: UntilMode, anyQuery: boolean) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<UntilMode>("appears");
  const [anyQuery, setAnyQuery] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = text.trim().length > 0 && p.canStart && !busy;
  return (
    <form
      className="col"
      style={{ gap: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        void p.onStart(text, mode, anyQuery).finally(() => setBusy(false));
      }}
    >
      <span className="card-title">Refresh until something appears</span>
      <div className="col" style={{ gap: 4 }}>
        <span className="small muted" id="until-mode">Stop when this text</span>
        <div className="seg" role="group" aria-labelledby="until-mode">
          <button type="button" className={mode === "appears" ? "selected" : ""} aria-pressed={mode === "appears"} onClick={() => setMode("appears")}>appears</button>
          <button type="button" className={mode === "disappears" ? "selected" : ""} aria-pressed={mode === "disappears"} onClick={() => setMode("disappears")}>disappears</button>
        </div>
      </div>
      <input aria-label="Text to look for" placeholder="e.g. In stock" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} autoFocus />
      <span className="small muted">Checking every</span>
      {p.picker}
      {p.problem && <span className="small field-error">{p.problem}</span>}
      <QueryChoice url={p.url} anyQuery={anyQuery} onChange={setAnyQuery} />
      <span className="small muted">
        It looks anywhere on this page (ignoring upper/lower case), then stops refreshing and notifies you with a sound. You'll find it under Rules in the
        dashboard.
      </span>
      <button type="submit" className="primary big" disabled={!ready}>
        {busy ? "Setting up…" : "Start watching"}
      </button>
      <button type="button" className="link small" style={{ alignSelf: "center" }} onClick={p.onCancel}>Cancel</button>
    </form>
  );
}

/** A rule set for this page with another "?…" part doesn't run here: say so instead of dropping out silently. */
function OtherQueryNotice({ rules, onEdit }: { rules: { id: string; name: string }[]; onEdit: (id: string) => void }) {
  if (!rules.length) return null;
  const [first] = rules;
  return (
    <div className="notice small col" style={{ gap: 4 }} role="status">
      <span>
        {rules.length === 1 ? `Rule “${first!.name}” is` : `${rules.length} rules, including “${first!.name}”, are`} set for this page with a different part
        after “?” in the address, so {rules.length === 1 ? "it doesn't" : "they don't"} run here. If the site changes that part on each load, edit the rule
        to cover the page whatever comes after “?”.
      </span>
      <button className="link small" style={{ alignSelf: "flex-start" }} onClick={() => onEdit(first!.id)}>
        Edit “{first!.name}”
      </button>
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

function Chevron({ up }: { up: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={up ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
    </svg>
  );
}
