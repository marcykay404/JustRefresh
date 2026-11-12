/**
 * The toolbar popup: what happens on this tab, in one card, with the
 * protection line and rarely used actions under More.
 *
 *   Popup     loads the tab's state and the overview
 *   TabPopup  works out the situation and picks the card (cards.tsx)
 *   Extras    notices, protection line, Refresh now and More
 */
import { useEffect, useState } from "react";
import { api, originOf, requestOrigins } from "../shared/api";
import { askAccessThen, cancelAfterAccess, type AfterAccessRequest } from "../shared/access";
import { fileAccessAllowed, openChromeSiteAccess } from "../shared/chrome-settings";
import { useApi, useNow } from "../shared/hooks";
import { StillLoading } from "../shared/StillLoading";
import { ErrorBox } from "../shared/components";
import type { Rule, TabRuntime } from "../../core/types";
import { useDialog } from "../shared/dialog";
import { describeRule, type UntilMode } from "./describe";
import { startUntil } from "./actions";
import { BlockedCard, type BlockedKind, isOwnPage, RunningCard, StartCard } from "./cards";
import { useIntervalPicker } from "./picker";
import {
  Chevron,
  Footer,
  Header,
  hostLabel,
  openDashboard,
  OtherQueryNotice,
  ProtectionLine,
  RefreshIcon,
  RuleCard,
  RUNNING,
  shortUrl,
  UntilForm,
  WaitingNotice,
  type Overview,
  type TabState,
} from "./parts";

export { protectedWhile } from "./parts";

type Run = (method: string, params?: unknown) => Promise<unknown>;

export function Popup() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTabId(t?.id ?? null));
  }, []);

  const state = useApi<TabState>("getTabState", tabId !== null ? { tabId } : undefined, {
    skip: tabId === null,
    live: ["runtime", "config", "tabs", "access"],
  });
  const overview = useApi<Overview>("getOverview", undefined, { live: ["runtime", "config", "tabs"] });

  const run: Run = async (method, params) => {
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
  if (tabId === null || !state.data) {
    return (
      <div className="popup-root">
        {header}
        {state.error ? <ErrorBox error={state.error} /> : <StillLoading onRetry={() => void state.reload()} />}
      </div>
    );
  }
  return (
    <div className="popup-root">
      {header}
      <TabPopup tabId={tabId} s={state.data} overview={overview.data} run={run} setError={setError} reloadState={state.reload} />
      <ErrorBox error={error} />
      <Footer overview={overview.data} />
    </div>
  );
}

/** The situation on this tab, worked out once for the card and the extras. */
function tabFacts(s: TabState, overview: Overview | null) {
  const origin = originOf(s.tab.url);
  return {
    rt: s.runtime,
    byRule: s.resolution.source === "rule",
    blocked: blockedKind(s),
    running: !!s.runtime && RUNNING.includes(s.runtime.status),
    // The interval actually in effect (fast intervals are clamped to 30 s while they're turned off).
    currentInterval: s.interval ?? s.override?.intervalSeconds ?? overview?.settings.defaultIntervalSeconds ?? 300,
    origin,
    siteName: isOwnPage(s.tab.url) ? "JustRefresh" : origin === "file:///*" ? "local files" : hostLabel(s.tab.url),
    protectionOn: s.safety.pauseWhileTyping || s.safety.protectUnsavedChanges || s.safety.pauseOnMouse || s.safety.pauseOnScroll,
  };
}

type Facts = ReturnType<typeof tabFacts>;

/** Nothing runs here for a reason Start can't fix (the card says which). */
function blockedKind(s: TabState): BlockedKind | null {
  const kind = s.resolution.kind;
  if (kind === "restricted") return "restricted";
  if (s.override?.mode === "excluded") return "tab_excluded";
  return kind === "paused" || kind === "disabled" || kind === "url_excluded" ? kind : null;
}

function countdownOf(rt: TabRuntime | null, now: number, intervalSeconds: number) {
  const countdown = rt?.nextDueAt ? Math.max(0, rt.nextDueAt - now) : null;
  const progress = countdown !== null && intervalSeconds ? Math.min(100, Math.max(0, 100 - (countdown / (intervalSeconds * 1000)) * 100)) : 0;
  return { countdown, progress };
}

function TabPopup({
  tabId,
  s,
  overview,
  run,
  setError,
  reloadState,
}: {
  tabId: number;
  s: TabState;
  overview: Overview | null;
  run: Run;
  setError: (e: unknown) => void;
  reloadState: () => Promise<void>;
}) {
  const now = useNow(1000);
  const f = tabFacts(s, overview);
  const ruleId = f.byRule ? s.resolution.controllerId : null;
  const rule = useApi<Rule>("getRule", ruleId ? { id: ruleId } : undefined, { skip: !ruleId, live: ["config"] });
  /** Changing the interval of a tab that is already refreshing. */
  const [changing, setChanging] = useState(false);
  const [view, setView] = useState<"main" | "until">("main");
  /** The site-access prompt was declined for the interval in here. */
  const [declinedFor, setDeclinedFor] = useState<number | null>(null);
  const picker = useIntervalPicker(f.currentInterval, overview?.settings.allowFastIntervals === true);
  /** A local file while Chrome keeps extensions out of local files (only its settings can change that). */
  const [filesOff, setFilesOff] = useState(false);
  useEffect(() => {
    if (f.origin === "file:///*" && !s.hostAccess) void fileAccessAllowed().then((ok) => setFilesOff(!ok));
  }, [f.origin, s.hostAccess]);
  /** A "Refresh until" the popup was setting up when it closed for Chrome's prompt (then declined). */
  const [restored, setRestored] = useState<{ text: string; mode: UntilMode; anyQuery: boolean; note: string } | null>(null);

  // Opened again after "Deny" (Chrome's prompt closes the popup on macOS): carry on from the click
  // instead of starting over. Taking it back also cancels it, so it can't start later by surprise.
  useEffect(() => {
    if (s.hostAccess) return;
    void api<AfterAccessRequest | null>("takeAfterAccess", { tabId })
      .catch(() => null)
      .then((req) => {
        if (req?.method === "startTab") {
          if (req.params.intervalSeconds) picker.choose(req.params.intervalSeconds);
          setDeclinedFor(req.params.intervalSeconds ?? picker.chosen);
        } else if (req?.method === "refreshUntil") {
          picker.choose(req.params.seconds);
          setRestored({
            text: req.params.text,
            mode: req.params.mode,
            anyQuery: req.params.anyQuery,
            note: `JustRefresh wasn't allowed to read ${f.siteName}, so nothing was set up. Start watching asks Chrome again.`,
          });
          setView("until");
        }
      });
    // Once per popup.
  }, []);
  const { countdown, progress } = countdownOf(f.rt, now, s.interval ?? f.currentInterval);

  const begin = async (intervalSeconds: number) => {
    setDeclinedFor(null);
    await run("startTab", { tabId, intervalSeconds });
    picker.reset();
    setChanging(false);
  };

  /**
   * Starting requests site access in the same click (user gesture) when
   * protection needs it. If the user declines, nothing starts silently: the
   * popup explains and offers to refresh without protection instead.
   * `alreadyGranted`: access was just granted in this click; asking again
   * (outside the click) could be refused by Chrome.
   */
  const start = (intervalSeconds: number, alreadyGranted = false) => {
    // No protection means nothing reads the page, so there is nothing to ask for.
    if (alreadyGranted || s.hostAccess || !f.origin || !f.protectionOn) return void begin(intervalSeconds);
    // Chrome refuses local files without asking while its file switch is off: explain instead of asking.
    if (filesOff) return void setDeclinedFor(intervalSeconds);
    // If Chrome's prompt closes the popup (macOS), the service worker starts it once you allow.
    void askAccessThen(f.origin, { method: "startTab", params: { tabId, intervalSeconds } }).then(({ granted, result }) => {
      if (!granted) return setDeclinedFor(intervalSeconds);
      if (result && !result.ok) setError(new Error(result.message ?? "Couldn't start"));
      setDeclinedFor(null);
      picker.reset();
      setChanging(false);
      void reloadState();
    });
  };

  const onStartUntil = async (text: string, mode: "appears" | "disappears", anyQuery: boolean) => {
    setError(null);
    const stopAfterMinutes = overview?.settings.defaultStopAfterMinutes ?? null;
    let r;
    try {
      r = await startUntil({ state: s, tabId, site: f.siteName, origin: f.origin, seconds: picker.chosen, text, mode, anyQuery, stopAfterMinutes });
    } catch (e) {
      setError(e);
      return;
    }
    void reloadState();
    if (r.warning) setError(new Error(r.warning));
    if (!r.done) return;
    setRestored(null);
    picker.reset();
    setView("main");
  };

  const card = () => {
    if (f.blocked)
      return (
        <BlockedCard kind={f.blocked} tabId={tabId} controllerName={s.resolution.controllerName} reason={s.resolution.reason} run={(m, p) => void run(m, p)} />
      );
    if (view === "until") {
      return (
        <UntilForm
          site={f.siteName}
          url={s.tab.url}
          restored={restored ?? undefined}
          picker={picker.element}
          canStart={picker.valid}
          problem={picker.tooShort}
          onCancel={() => {
            setRestored(null);
            setView("main");
          }}
          onStart={onStartUntil}
        />
      );
    }
    if (f.byRule) {
      return (
        <RuleCard
          name={s.resolution.controllerName ?? rule.data?.name ?? "Rule"}
          summary={rule.data ? describeRule(rule.data, s.interval) : null}
          onEdit={() => openDashboard(`/builder/${ruleId}`)}
          rt={f.rt}
          countdown={countdown}
          progress={progress}
          onCheckNow={() => void run("runNow", { tabId })}
          onStop={() => void run("stopTab", { tabId })}
          onRestart={() => void run("resumeTab", { tabId })}
        />
      );
    }
    if (f.running && !changing) {
      return (
        <RunningCard
          rt={f.rt}
          interval={f.currentInterval}
          countdown={countdown}
          progress={progress}
          onStop={() => void run("stopTab", { tabId })}
          onChange={() => setChanging(true)}
          onResume={() => void run("resumeTab", { tabId })}
        />
      );
    }
    return (
      <StartCard
        changing={changing}
        picker={picker.element}
        tooShort={picker.tooShort}
        chosen={picker.chosen}
        valid={picker.valid}
        finished={f.rt?.status === "completed" ? (f.rt.reason ?? "Finished.") : null}
        onStart={() => start(picker.chosen)}
        onCancel={() => {
          picker.reset();
          setChanging(false);
        }}
      />
    );
  };

  return (
    <>
      <div className="col" style={{ gap: 2 }}>
        <strong className="popup-site truncate">{f.siteName || s.tab.title || "This tab"}</strong>
        <span className="muted small truncate" title={s.tab.url}>
          {s.tab.title ? `${s.tab.title} · ` : ""}
          {shortUrl(s.tab.url)}
        </span>
      </div>

      <section className="card col popup-card">{card()}</section>

      {view === "main" && f.blocked !== "restricted" && (
        <Extras
          s={s}
          f={f}
          tabId={tabId}
          run={run}
          declinedFor={declinedFor}
          filesOff={filesOff}
          onAccessGranted={() => {
            setDeclinedFor(null);
            picker.reset();
            setChanging(false);
            void reloadState();
          }}
          onStartUnprotected={async () => {
            void cancelAfterAccess(tabId); // the declined click's request isn't wanted now
            await run("startTab", { tabId, intervalSeconds: declinedFor ?? picker.chosen, safety: { onActivityUnavailable: "refresh" } });
            setDeclinedFor(null);
          }}
          setError={setError}
          onUntil={() => setView("until")}
          reloadState={reloadState}
        />
      )}
    </>
  );
}

/**
 * JustRefresh can't see inside the page, so it won't refresh it: allow access
 * (for a local file, only Chrome's settings can), or refresh without protection.
 */
function NoAccessNotice(p: { site: string; filesOff: boolean; onAllow: () => void; onUnprotected: () => void }) {
  return (
    <div className="notice small col">
      {p.filesOff ? (
        <span>
          Chrome only lets extensions into local files when “Allow access to file URLs” is on for JustRefresh. Until then it can't tell whether you're typing
          here, so it won't refresh this page. Turn it on in Chrome's settings, or refresh without protection.
        </span>
      ) : (
        <span>
          JustRefresh can't see inside <strong>{p.site}</strong>, so it can't tell whether you're typing or have unsaved form changes. To be safe, it won't
          refresh this page until you allow access.
        </span>
      )}
      <div className="row">
        <button className="small" onClick={p.filesOff ? openChromeSiteAccess : p.onAllow}>
          {p.filesOff ? "Open Chrome's settings" : "Allow access"}
        </button>
        <button className="small" onClick={p.onUnprotected}>
          Refresh without protection
        </button>
      </div>
    </div>
  );
}

/** Below the card: why it's waiting, site access, protection, Refresh now and More. */
function Extras(p: {
  s: TabState;
  f: Facts;
  tabId: number;
  run: Run;
  declinedFor: number | null;
  /** A local file while Chrome's "Allow access to file URLs" is off. */
  filesOff: boolean;
  setError: (e: unknown) => void;
  /** Access was granted from the notice; the service worker did what the click was for. */
  onAccessGranted: () => void;
  onStartUnprotected: () => Promise<void>;
  onUntil: () => void;
  reloadState: () => Promise<void>;
}) {
  const { s, f, tabId, run } = p;
  const dialog = useDialog();
  const [moreOpen, setMoreOpen] = useState(false);
  // Without site access the default safety policy pauses every refresh: say so and offer a choice.
  const blockedByAccess = p.declinedFor !== null || (!s.hostAccess && f.rt?.status === "paused_activity" && s.safety.onActivityUnavailable !== "refresh");
  const openFresh = () => void run("openFresh", { tabId });

  const refreshNow = async () => {
    const r = (await run("refreshNow", { tabId })) as { refreshed: boolean; reason?: string; formResult?: boolean } | null;
    if (!r || r.refreshed) return;
    if (r.formResult) {
      const ok = await dialog.confirm({
        title: "Open this page fresh instead?",
        message:
          "This page came from submitting a form. Refreshing it could send the form again, for example placing a second order. Opening it fresh loads the address as a normal visit, so nothing is sent again; the page may look different.",
        confirmLabel: "Open this page fresh",
      });
      if (ok) openFresh();
      return;
    }
    const ok = await dialog.confirm({
      title: "Refresh anyway?",
      message: `${r.reason ?? "Refresh blocked"}. Refreshing now may lose unsaved changes on this page.`,
      confirmLabel: "Refresh anyway",
      danger: true,
    });
    if (ok) await run("refreshNow", { tabId, force: true });
  };

  // What the earlier click was for happens once you allow, even if Chrome's prompt closes the popup.
  const allowAccess = () =>
    f.origin &&
    void askAccessThen(
      f.origin,
      p.declinedFor !== null ? { method: "startTab", params: { tabId, intervalSeconds: p.declinedFor } } : { method: "resumeTab", params: { tabId } },
    ).then(({ granted, result }) => {
      if (result && !result.ok) p.setError(new Error(result.message ?? "Couldn't start"));
      if (granted) p.onAccessGranted();
    });

  return (
    <>
      <OtherQueryNotice rules={s.otherQueryRules ?? []} onEdit={(id) => openDashboard(`/builder/${id}`)} />
      <WaitingNotice
        rt={f.rt}
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

      {blockedByAccess && f.origin && (
        <NoAccessNotice site={f.siteName} filesOff={p.filesOff} onAllow={allowAccess} onUnprotected={() => void p.onStartUnprotected()} />
      )}

      {!f.blocked && !blockedByAccess && (
        <ProtectionLine
          site={f.siteName}
          safety={s.safety}
          protectionOn={f.protectionOn}
          hostAccess={s.hostAccess}
          unprotected={!s.hostAccess && s.safety.onActivityUnavailable === "refresh"}
          running={f.running}
          byRule={f.byRule}
          needsAccessForRule={f.byRule && !s.hostAccess}
          onToggle={(on) => run("setTabSafety", { tabId, safety: { pauseWhileTyping: on, protectUnsavedChanges: on } })}
          onAllow={() => (p.filesOff ? openChromeSiteAccess() : f.origin && void requestOrigins([f.origin]).then(() => p.reloadState()))}
          showAllow={!!f.origin}
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

      {moreOpen && <MoreMenu s={s} f={f} tabId={tabId} run={run} onUntil={p.onUntil} onClose={() => setMoreOpen(false)} />}
    </>
  );
}

function MoreMenu({ s, f, tabId, run, onUntil, onClose }: { s: TabState; f: Facts; tabId: number; run: Run; onUntil: () => void; onClose: () => void }) {
  const tabExcluded = f.blocked === "tab_excluded";
  const canWatch = !f.byRule && !f.blocked && !!f.origin && f.origin !== "file:///*";
  return (
    <nav className="menu" aria-label="More actions">
      {canWatch && (
        <button
          onClick={() => {
            onUntil();
            onClose();
          }}
        >
          <strong>Refresh until something appears…</strong>
          <span>e.g. stop and notify me when “In stock” shows up</span>
        </button>
      )}
      {!tabExcluded && (
        <button
          onClick={() => {
            void run("excludeTab", { tabId });
            onClose();
          }}
        >
          <strong>Never auto-refresh this tab</strong>
          <span>Rules for this site will skip it until you allow it again</span>
        </button>
      )}
      <button onClick={() => openDashboard(`/builder?url=${encodeURIComponent(s.tab.url)}`)}>
        <strong>Make a rule for {f.siteName || "this page"}…</strong>
        <span>Opens the Rule Builder for more options</span>
      </button>
    </nav>
  );
}
