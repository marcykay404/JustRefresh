/** The popup's main card, one per situation: can't run here, refreshing, or ready to start. */
import type { ReactNode } from "react";
import type { TabRuntime } from "../../core/types";
import { intervalLabel } from "./describe";
import { Countdown, openDashboard, Stats } from "./parts";

/** Situations where Start can't help: say why, and offer the fix. */
export type BlockedKind = "restricted" | "tab_excluded" | "paused" | "disabled" | "url_excluded";

/** One of JustRefresh's own pages (dashboard, settings…). */
export function isOwnPage(url: string, ownBase = chrome.runtime.getURL("")): boolean {
  return ownBase !== "" && url.startsWith(ownBase);
}

/** Why a page can't be refreshed at all, in words: JustRefresh's own page, Chrome's, or the Web Store. */
export function restrictedMessage(url: string, ownBase = chrome.runtime.getURL("")): string {
  if (isOwnPage(url, ownBase)) {
    return "This is JustRefresh's own page, so there's nothing to refresh here. Go to the website you want to refresh and open JustRefresh there.";
  }
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url)) {
    return "Chrome doesn't let extensions work on the Chrome Web Store, so JustRefresh can't refresh it.";
  }
  if (/^(chrome|edge|brave|about|devtools|chrome-extension|view-source):/.test(url)) {
    return "This is one of the browser's own pages (settings, extensions, new tab…). Chrome doesn't let extensions refresh those.";
  }
  return "Chrome doesn't let extensions refresh this page.";
}

export function BlockedCard(p: {
  kind: BlockedKind;
  /** The tab's address (to say why a restricted page can't be refreshed). */
  url: string;
  tabId: number;
  controllerName: string | null;
  reason?: string;
  run: (method: string, params?: unknown) => void;
}) {
  switch (p.kind) {
    case "restricted":
      return (
        <p className="muted" style={{ margin: 0 }}>
          {restrictedMessage(p.url)}
        </p>
      );
    case "tab_excluded":
      return (
        <>
          <span>This tab is set to never auto-refresh, so rules skip it.</span>
          <button onClick={() => p.run("includeTab", { tabId: p.tabId })}>Allow auto-refresh again</button>
        </>
      );
    case "paused":
      return (
        <>
          <span className="card-title">All refreshing is paused</span>
          <span className="small muted">
            {p.controllerName ? `When you resume, “${p.controllerName}” carries on here.` : "Nothing refreshes until you resume."}
          </span>
          <button className="primary big" onClick={() => p.run("resumeAll")}>
            Resume all refreshing
          </button>
        </>
      );
    case "disabled":
      return (
        <>
          <span className="card-title">JustRefresh is switched off</span>
          <span className="small muted">Auto refresh is turned off in Settings, so no tab refreshes.</span>
          <button className="primary big" onClick={() => p.run("updateSettings", { enabled: true })}>
            Turn auto refresh on
          </button>
        </>
      );
    case "url_excluded":
      return (
        <>
          <span className="card-title">This page is excluded</span>
          <span className="small muted">{p.reason ?? "An exclusion matches this page"}, so nothing refreshes it.</span>
          <button className="big" onClick={() => openDashboard("/exclusions")}>
            Manage exclusions
          </button>
        </>
      );
  }
}

/** A tab timer that is running (or waiting): countdown, Stop and Change interval. */
export function RunningCard(p: {
  rt: TabRuntime | null;
  interval: number;
  countdown: number | null;
  progress: number;
  onStop: () => void;
  onChange: () => void;
  onResume: () => void;
}) {
  const every = intervalLabel(p.interval);
  return (
    <>
      <Countdown
        title={p.rt?.status === "paused_resubmit" ? "Paused on a submitted form" : `Refreshing every ${every}`}
        rt={p.rt}
        countdown={p.countdown}
        progress={p.progress}
        formPaused={`Refreshing every ${every} starts again when this tab goes to another page`}
      />
      {p.rt?.status === "paused_user" ? (
        <button className="primary big" onClick={p.onResume}>
          Resume
        </button>
      ) : (
        <div className="row">
          <button className="big grow" onClick={p.onStop}>
            Stop
          </button>
          <button className="big" onClick={p.onChange}>
            Change interval
          </button>
        </div>
      )}
      {p.rt && <Stats rt={p.rt} />}
    </>
  );
}

/** Pick an interval and start (or change the interval of a running tab). */
export function StartCard(p: {
  changing: boolean;
  picker: ReactNode;
  tooShort: string | null;
  chosen: number;
  valid: boolean;
  finished: string | null;
  onStart: () => void;
  onCancel: () => void;
}) {
  const every = intervalLabel(p.chosen);
  return (
    <>
      <span className="card-title">{p.changing ? "Change the interval" : "Refresh this tab every"}</span>
      {p.picker}
      {p.tooShort && <span className="small field-error">{p.tooShort}</span>}
      <button className="primary big" disabled={!p.valid} onClick={p.onStart}>
        {p.changing ? `Refresh every ${every}` : `Start refreshing every ${every}`}
      </button>
      {p.changing && (
        <button className="link small" style={{ alignSelf: "center" }} onClick={p.onCancel}>
          Cancel
        </button>
      )}
      {p.finished !== null && <span className="small muted">{p.finished}</span>}
    </>
  );
}
