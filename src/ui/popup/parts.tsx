/** The popup's smaller pieces: header, footer, interval chips, countdown, rule card, notices and forms. */
import { useState, type ReactNode } from "react";
import { formatDuration, formatTime } from "../shared/format";
import { Toggle } from "../shared/components";
import { QueryChoice } from "../shared/QueryChoice";
import type { SafetyConfig, Settings, TabInfo, TabOverride, TabRuntime } from "../../core/types";
import { intervalLabel, type UntilMode } from "./describe";

export interface TabState {
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

export interface Overview {
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
export const RUNNING = ["scheduled", "evaluating", "refreshing", "paused_activity", "paused_unsaved", "paused_resubmit", "paused_unknown", "paused_user"];

export function openDashboard(hash = "/tabs") {
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


export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** "youtube.com/watch?v=…" without the scheme. */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "");
}

export function Header({ overview, onToggleGlobal }: { overview: Overview | null; onToggleGlobal: () => void }) {
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

export function Footer({ overview }: { overview: Overview | null }) {
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

export function IntervalPicker(p: {
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

/** "Next refresh in", "Checking the page…", "Waiting for you"… */
function countdownSubtitle(rt: TabRuntime | null, waiting: boolean): string {
  if (rt?.status === "refreshing") return "Refreshing now…";
  if (rt?.status === "evaluating") return "Checking the page…";
  if (rt?.status === "paused_user") return "Paused";
  return waiting ? "Waiting for you" : "Next refresh in";
}

export function CountdownRow({ title, rt, countdown, subtitle }: { title: ReactNode; rt: TabRuntime | null; countdown: number | null; subtitle?: ReactNode }) {
  const waiting = !!rt?.status.startsWith("paused") && rt.status !== "paused_user";
  const ticking = countdown !== null && !waiting && rt?.status !== "refreshing" && rt?.status !== "paused_user";
  return (
    <div className="countdown-row">
      <div className="col" style={{ gap: 0, minWidth: 0 }}>
        <span className="card-title">{title}</span>
        <span className={`small ${waiting ? "warn-text" : "muted"}`}>{subtitle ?? countdownSubtitle(rt, waiting)}</span>
      </div>
      <span className="spacer" />
      {ticking && (
        <span className="countdown" title={`Next refresh at ${formatTime(rt?.nextDueAt)}`}>{formatDuration(countdown)}</span>
      )}
    </div>
  );
}

/** The countdown with its progress bar, or the form-page pause in its place. */
export function Countdown({ title, rt, countdown, progress, formPaused }: { title: ReactNode; rt: TabRuntime | null; countdown: number | null; progress: number; formPaused: string }) {
  if (rt?.status === "paused_resubmit") return <CountdownRow title={title} rt={rt} countdown={null} subtitle={formPaused} />;
  return (
    <>
      <CountdownRow title={title} rt={rt} countdown={countdown} />
      <div className="progress" aria-hidden>
        <div style={{ width: `${progress}%` }} />
      </div>
    </>
  );
}

export function Stats({ rt, rule }: { rt: TabRuntime; rule?: boolean }) {
  const last = rt.lastAttemptAt ? ` · last checked ${formatTime(rt.lastAttemptAt)}` : "";
  if (rule) {
    const found = rt.lastEvaluation?.status === "matched" ? "found" : rt.lastEvaluation?.status === "unknown" ? "couldn't check" : "not found yet";
    return <span className="small muted">Refreshed {rt.refreshCount} time{rt.refreshCount === 1 ? "" : "s"} · {found}{last}</span>;
  }
  return <span className="small muted">Refreshed {rt.refreshCount} time{rt.refreshCount === 1 ? "" : "s"}{last}</span>;
}

export function RuleCard(p: {
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
  const active = !!p.rt && RUNNING.includes(p.rt.status);
  return (
    <>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <span className="pill pill-done">Rule</span>
        <strong className="truncate grow">{p.name}</strong>
        <a href="#" className="small" onClick={(e) => { e.preventDefault(); p.onEdit(); }}>Edit rule</a>
      </div>
      {active ? <ActiveRule {...p} /> : <IdleRule {...p} />}
    </>
  );
}

function ActiveRule(p: Parameters<typeof RuleCard>[0]) {
  return (
    <>
      <Countdown
        title={p.summary ?? "Refreshing"}
        rt={p.rt}
        countdown={p.countdown}
        progress={p.progress}
        formPaused="Paused on a submitted form. The rule carries on if this tab goes to another page it covers."
      />
      {p.rt && <Stats rt={p.rt} rule />}
      <div className="row">
        <button className="big grow" onClick={p.onCheckNow}>Check now</button>
        <button className="big grow" onClick={p.onStop}>Stop on this tab</button>
      </div>
    </>
  );
}

function idleRuleText(rt: TabRuntime | null): string {
  if (rt?.status === "completed") return rt.reason ?? "Finished: the condition was found.";
  if (rt?.status === "stopped") return "Stopped on this tab.";
  return rt?.reason ?? "Not running on this tab yet.";
}

function IdleRule(p: Parameters<typeof RuleCard>[0]) {
  const ended = p.rt?.status === "completed" || p.rt?.status === "stopped";
  return (
    <>
      {p.summary && <span>{p.summary}</span>}
      <span className="small muted">{idleRuleText(p.rt)}</span>
      <button className="primary big" onClick={p.onRestart}>{ended ? "Start again" : "Start"}</button>
    </>
  );
}

/** One plain sentence when JustRefresh is holding back, with the override right there. */
export function WaitingNotice(p: { rt: TabRuntime | null; grace: number; onRefreshAnyway: () => void; onRetry: () => void; onOpenFresh: () => void; hidden: boolean }) {
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

interface ProtectionProps {
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
}

/** The protection sentence, and whether it's the "all good" one. */
function protectionText(p: ProtectionProps): { text: ReactNode; ok: boolean } {
  if (p.protectionOn && p.hostAccess) return { ok: true, text: `${p.running ? "Protected: waits" : "Will wait"} ${protectedWhile(p.safety)}` };
  if (p.protectionOn && p.unprotected) {
    return { ok: false, text: <>Refreshing without protection: JustRefresh can't see inside <strong>{p.site}</strong>, so typing isn't detected.</> };
  }
  if (p.protectionOn || p.needsAccessForRule) {
    return {
      ok: false,
      text: (
        <>
          JustRefresh can't see inside <strong>{p.site}</strong> yet. Allow it so refreshes wait while you're typing or have unsaved form changes
          {p.byRule ? ", and so this rule can check the page's content." : "."}
        </>
      ),
    };
  }
  return { ok: false, text: <span className="muted">Protection off: refreshes even while you're typing.</span> };
}

export function ProtectionLine(p: ProtectionProps) {
  const { text, ok } = protectionText(p);
  const showAllow = p.showAllow && !p.hostAccess && (p.protectionOn || p.needsAccessForRule);
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
          {p.byRule && ok && <span className="muted"> (set by the rule)</span>}
        </span>
        {showAllow && (
          <div>
            <button className="small" onClick={p.onAllow}>Allow access</button>
          </div>
        )}
      </div>
      {!p.byRule && <Toggle checked={p.safety.pauseWhileTyping && p.safety.protectUnsavedChanges} onChange={p.onToggle} label={<span className="sr-only">Wait while I'm typing or have unsaved form changes</span>} />}
    </div>
  );
}

export function UntilForm(p: {
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
export function OtherQueryNotice({ rules, onEdit }: { rules: { id: string; name: string }[]; onEdit: (id: string) => void }) {
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

export function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

export function Chevron({ up }: { up: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={up ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
    </svg>
  );
}
