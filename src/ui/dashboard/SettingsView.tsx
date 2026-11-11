import { useEffect, useMemo, useRef, useState } from "react";
import { api, requestOrigins } from "../shared/api";
import { useApi } from "../shared/hooks";
import { ALL_SITE_PATTERNS, describeUsage, groupOrigins, hasAllSites, inUse, siteUsage } from "../shared/site-access";
import { downloadJson } from "../shared/format";
import { ErrorBox, Field, Toggle } from "../shared/components";
import { INTERVAL_PRESETS, STOP_AFTER_CHOICES } from "../../core/defaults";
import { stopAfterLabel } from "../popup/describe";
import type { Rule, Settings } from "../../core/types";
import type { ImportReport } from "../../integrations/json-import";
import { useDialog } from "../shared/dialog";

export function SettingsView() {
  const { data, error, reload } = useApi<{ settings: Settings }>("getOverview", undefined, { live: ["config"] });
  const [actionError, setActionError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const s = data?.settings;

  const update = async (patch: Record<string, unknown>) => {
    setActionError(null);
    try {
      await api("updateSettings", patch);
      await reload();
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    } catch (e) {
      setActionError(e);
    }
  };

  if (!s) return <ErrorBox error={error} />;
  const sf = s.defaultSafety;

  return (
    <>
      <div className="row">
        <h1>Settings</h1>
        {saved && <span className="pill pill-ok">Saved</span>}
      </div>
      <ErrorBox error={actionError} />
      <div className="grid-2">
        <div className="card col">
          <h2>Global</h2>
          <Toggle checked={s.enabled} onChange={(v) => update({ enabled: v })} label="Auto refresh enabled" />
          <Toggle checked={s.paused} onChange={(v) => update({ paused: v })} label="Pause all refreshes" />
          <Field label="Default interval" hint="Used when enabling refresh on a tab without choosing an interval.">
            <select value={s.defaultIntervalSeconds} onChange={(e) => update({ defaultIntervalSeconds: Number(e.target.value) })}>
              {INTERVAL_PRESETS.map((p) => <option key={p.seconds} value={p.seconds}>{p.label}</option>)}
            </select>
          </Field>
          <Field
            label="Stop watching after"
            hint="For rules that wait for something on the page (popup → Refresh until, templates): if it hasn't happened by then, stop and notify you. Applies to rules you create from now on; each rule can have its own in the Rule Builder."
          >
            <select
              value={s.defaultStopAfterMinutes ?? ""}
              onChange={(e) => update({ defaultStopAfterMinutes: e.target.value === "" ? null : Number(e.target.value) })}
            >
              {STOP_AFTER_CHOICES.map((m) => (
                <option key={m ?? "none"} value={m ?? ""}>{stopAfterLabel(m)}</option>
              ))}
            </select>
          </Field>
          <Toggle checked={s.notificationsEnabled} onChange={(v) => update({ notificationsEnabled: v })} label="Desktop notifications" />
          <Toggle checked={s.skipDiscardedTabs} onChange={(v) => update({ skipDiscardedTabs: v })} label="Skip discarded (memory-saver) tabs" />
        </div>

        <div className="card col">
          <h2>Activity protection</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Tabs you start from the popup follow these settings (a tab's own popup switch wins). New rules start with a
            copy, so changing these later doesn't change rules you already have: edit those in the Rule Builder.
          </p>
          <Toggle checked={sf.pauseWhileTyping} onChange={(v) => update({ defaultSafety: { pauseWhileTyping: v } })} label="Wait while I'm typing" />
          <Toggle checked={sf.protectUnsavedChanges} onChange={(v) => update({ defaultSafety: { protectUnsavedChanges: v } })} label="Don't refresh over unsaved form changes" />
          <Toggle checked={sf.pauseOnMouse} onChange={(v) => update({ defaultSafety: { pauseOnMouse: v } })} label="Also wait while I move the mouse" />
          <Toggle checked={sf.pauseOnScroll} onChange={(v) => update({ defaultSafety: { pauseOnScroll: v } })} label="Also wait while I scroll" />
          <Field label="Quiet time before a postponed refresh" hint="A refresh that waited for you happens once the page has been quiet this long.">
            <select value={sf.inactivityGraceSeconds} onChange={(e) => update({ defaultSafety: { inactivityGraceSeconds: Number(e.target.value) } })}>
              {[30, 60, 120, 300, 600, 1800].map((v) => <option key={v} value={v}>{v < 60 ? `${v} s` : `${v / 60} min`}</option>)}
              {![30, 60, 120, 300, 600, 1800].includes(sf.inactivityGraceSeconds) && <option value={sf.inactivityGraceSeconds}>{sf.inactivityGraceSeconds} s</option>}
            </select>
          </Field>
          <Field
            label="When JustRefresh can't see inside the page"
            hint="For example, site access isn't allowed yet, or it's a page Chrome protects, like the Chrome Web Store."
          >
            <select value={sf.onActivityUnavailable} onChange={(e) => update({ defaultSafety: { onActivityUnavailable: e.target.value } })}>
              <option value="pause">Don't refresh (safe)</option>
              <option value="refresh">Refresh without protection</option>
            </select>
          </Field>
          <Field
            label="When a rule can't check the page"
            hint="Only for rules that look for something on the page, like “refresh until In stock appears”, when the page couldn't be read."
          >
            <select value={sf.onUnknown} onChange={(e) => update({ defaultSafety: { onUnknown: e.target.value } })}>
              <option value="pause">Pause, retry {sf.maxUnknownRetries} times, then notify me</option>
              <option value="skip">Skip this time and keep trying (no limit)</option>
              <option value="refresh">Treat it as not found and keep refreshing</option>
              <option value="stop">Stop and notify me</option>
            </select>
          </Field>
        </div>

        <SiteAccess />

        <div className="card col">
          <h2>Advanced</h2>
          <Toggle
            checked={s.allowFastIntervals}
            onChange={(v) => update({ allowFastIntervals: v })}
            label={<span>Allow intervals under 30 seconds <span className="muted small">(minimum 5 seconds)</span></span>}
          />
          <p className="small muted" style={{ margin: 0 }}>
            For time-critical pages such as restocks or appointment slots. Refreshing this often puts real load on the website and may break its
            terms of use, so JustRefresh never refreshes faster than every 5 seconds, and refreshes any one site at most once every 5 seconds
            across all tabs. Fast intervals keep the extension's background worker awake while such a tab is scheduled. Turning this off keeps
            existing fast rules but runs them every 30 seconds.
          </p>
        </div>

        <div className="card col">
          <h2>Help</h2>
          <p className="small muted" style={{ margin: 0 }}>A short introduction, and ready-made rules to start from.</p>
          <div className="row">
            <a className="btn" href="#/welcome">Show the welcome page</a>
            <a className="btn" href="#/templates">Browse templates</a>
          </div>
        </div>

        <div className="card col">
          <h2>History & privacy</h2>
          <Field label="Maximum history entries">
            <input type="number" min={10} max={5000} key={s.historyLimit} defaultValue={s.historyLimit} onBlur={(e) => update({ historyLimit: Number(e.target.value) })} />
          </Field>
          <Field label="Keep history for (days)">
            <input type="number" min={1} max={365} key={s.historyRetentionDays} defaultValue={s.historyRetentionDays} onBlur={(e) => update({ historyRetentionDays: Number(e.target.value) })} />
          </Field>
          <Toggle checked={s.redactUrlsForAgents} onChange={(v) => update({ redactUrlsForAgents: v })} label="Hide URL query strings from agents" />
          <p className="small muted" style={{ margin: 0 }}>No analytics or telemetry. Everything is stored locally in this browser profile. Typed text and form values are never recorded.</p>
        </div>
      </div>
      <ImportExport onDone={reload} />
    </>
  );
}

function ImportExport({ onDone }: { onDone: () => void }) {
  const [json, setJson] = useState("");
  const [onDuplicate, setOnDuplicate] = useState<"rename" | "replace" | "skip">("rename");
  const dialog = useDialog();
  const [activate, setActivate] = useState(false);
  const [includeSettings, setIncludeSettings] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const file = useRef<HTMLInputElement>(null);

  const runImport = async () => {
    setError(null);
    setReport(null);
    try {
      setReport(await api<ImportReport>("importConfig", { json, onDuplicate, activate, includeSettings }));
      onDone();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="card col">
      <h2>Import / export</h2>
      <div className="row">
        <button onClick={async () => downloadJson(`justrefresh-${new Date().toISOString().slice(0, 10)}.json`, await api("exportConfig", { includeSettings: true }))}>
          Export everything
        </button>
        <button onClick={() => file.current?.click()}>Load file…</button>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setJson(await f.text());
          }}
        />
        <span className="spacer" />
        <button
          className="danger"
          onClick={async () => {
            const ok = await dialog.confirm({
              title: "Reset everything to defaults?",
              message: "All settings, rules, exclusions and paired agents are deleted. This can't be undone; export first if you're unsure.",
              confirmLabel: "Reset everything",
              danger: true,
            });
            if (ok) {
              await api("resetConfig", { confirm: true });
              onDone();
            }
          }}
        >
          Reset to defaults
        </button>
      </div>
      <Field label="Paste JSON (a rule, an array of rules, or an export bundle — e.g. generated by an AI agent)">
        <textarea rows={8} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
      </Field>
      <div className="row">
        <label className="row small">
          Duplicate ids:
          <select value={onDuplicate} onChange={(e) => setOnDuplicate(e.target.value as typeof onDuplicate)}>
            <option value="rename">Import as new rule</option>
            <option value="replace">Replace existing</option>
            <option value="skip">Skip</option>
          </select>
        </label>
        <Toggle checked={activate} onChange={setActivate} label={<span className="small">Activate imported rules immediately</span>} />
        <Toggle checked={includeSettings} onChange={setIncludeSettings} label={<span className="small">Also import settings</span>} />
        <span className="spacer" />
        <button className="primary" disabled={!json.trim()} onClick={runImport}>Validate & import</button>
      </div>
      {!activate && <span className="small muted">Imported rules are saved disabled so you can review and test them first.</span>}
      <ErrorBox error={error} />
      {report && (
        <div className="info small col">
          <div>Imported: {report.imported.length ? report.imported.map((id) => <a key={id} href={`#/builder/${id}`} style={{ marginRight: 6 }}>{id}</a>) : "none"}</div>
          {report.skipped.length > 0 && <div>Skipped: {report.skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}</div>}
          {report.warnings.map((w, i) => <div key={i} style={{ color: "var(--warn)" }}>{w}</div>)}
          {report.errors.map((e, i) => (
            <div key={i} style={{ color: "var(--error)" }}>
              {e.index >= 0 ? `Rule #${e.index + 1}${e.name ? ` “${e.name}”` : ""}:` : "Import failed:"}
              <ul className="diagnostics">{e.diagnostics.map((d, j) => <li key={j} className={d.severity}><code>{d.path}</code> {d.message}</li>)}</ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Rows shown before "Show all"; the filter box appears past FILTER_AFTER sites. */
const COLLAPSED_SITES = 5;
const FILTER_AFTER = 8;

/**
 * Granted site access, per site, with removal. Chrome's own extension page
 * cannot revoke runtime-granted sites individually, so this is the place.
 */
export function SiteAccess() {
  const [origins, setOrigins] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState("");
  const dialog = useDialog();
  const [expanded, setExpanded] = useState(false);
  const rules = useApi<Rule[]>("listRules", undefined, { live: ["config"] });
  const overview = useApi<{ tabs: { tab: { url: string }; status: string }[] }>("getOverview", undefined, { live: ["runtime", "config", "tabs"] });

  useEffect(() => {
    const load = () => void chrome.permissions.getAll().then((p) => setOrigins([...(p.origins ?? [])].sort()));
    load();
    chrome.permissions.onAdded.addListener(load);
    chrome.permissions.onRemoved.addListener(load);
    return () => {
      chrome.permissions.onAdded.removeListener(load);
      chrome.permissions.onRemoved.removeListener(load);
    };
  }, []);

  // Usage is only trusted once tabs and rules have loaded; until then nothing
  // counts as unused, so "Remove unused" cannot remove a site in use.
  const loaded = !!overview.data && !!rules.data;
  const sites = useMemo(() => {
    const tabs = (overview.data?.tabs ?? []).map((r) => ({ url: r.tab.url, status: r.status }));
    const ruleList = (rules.data ?? []).map((r) => ({ name: r.name, patterns: r.target.patterns }));
    return groupOrigins(origins ?? [])
      .map((g) => {
        const usage = siteUsage(g, tabs, ruleList);
        return { g, usage, used: !loaded || inUse(usage) };
      })
      // "All websites" first, then sites in use, then the rest by name.
      .sort((a, b) => Number(b.g.kind === "all") - Number(a.g.kind === "all") || Number(b.used) - Number(a.used));
  }, [origins, overview.data, rules.data, loaded]);

  const unused = sites.filter((s) => !s.used && s.g.kind !== "all");
  const q = filter.trim().toLowerCase();
  const matching = q ? sites.filter((s) => s.g.label.toLowerCase().includes(q)) : sites;
  const shown = expanded || q ? matching : matching.slice(0, COLLAPSED_SITES);
  const allSites = sites.some((s) => s.g.kind === "all");

  const describe = ({ g, usage }: (typeof sites)[number]) => {
    const httpOnly = g.schemes.length === 1 && g.schemes[0] === "http" ? "http only" : null;
    if (g.kind === "all") {
      const parts = [usage.tabs && `${usage.tabs} tab${usage.tabs === 1 ? "" : "s"}`, usage.rules.length && `${usage.rules.length} rule${usage.rules.length === 1 ? "" : "s"}`].filter(Boolean);
      return [g.schemes.length === 1 ? `Every ${g.schemes[0]} site` : "Every http and https site", parts.length ? `used by ${parts.join(" and ")}` : null].filter(Boolean).join(" · ");
    }
    return [httpOnly, loaded ? describeUsage(usage) : null].filter(Boolean).join(" · ");
  };

  const remove = async (list: string[], what: string) => {
    setError(null);
    const ok = await dialog.confirm({
      title: `Remove access to ${what}?`,
      message: `Tabs and rules on ${list.length > 1 ? "these sites" : "this site"} will pause instead of refreshing (unless set to refresh without protection), and page conditions will report “unknown”.`,
      confirmLabel: "Remove access",
      danger: true,
    });
    if (!ok) return;
    try {
      await chrome.permissions.remove({ origins: list });
    } catch (e) {
      setError(e);
    }
  };

  const removeUnused = async () => {
    setError(null);
    const names = unused.map((s) => s.g.label);
    const ok = await dialog.confirm({
      title: `Remove access to ${names.length} unused site${names.length === 1 ? "" : "s"}?`,
      message: (
        <>
          <p>No running tab or rule uses {names.length === 1 ? "it" : "them"}. JustRefresh asks again the next time you turn on refresh there.</p>
          <ul>
            {names.slice(0, 10).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          {names.length > 10 && <p>…and {names.length - 10} more.</p>}
        </>
      ),
      confirmLabel: "Remove access",
      danger: true,
    });
    if (!ok) return;
    try {
      await chrome.permissions.remove({ origins: unused.flatMap((s) => s.g.origins) });
    } catch (e) {
      setError(e);
    }
  };

  const siteCount = sites.filter((s) => s.g.kind !== "all").length;
  const summary = allSites
    ? `Allowed on all websites${siteCount ? `, plus ${siteCount} site${siteCount === 1 ? "" : "s"} granted earlier` : ""}`
    : `Allowed on ${siteCount} site${siteCount === 1 ? "" : "s"}${loaded ? ` · ${siteCount - unused.length} in use` : ""}`;

  return (
    <div className="card col">
      <h2>Site access</h2>
      <p className="small muted" style={{ margin: 0 }}>
        JustRefresh installs without access to any website and asks per site when you turn on refresh. Access lets it wait while you're typing or have
        unsaved form changes, and lets rules check a page's content.
      </p>
      {origins === null ? (
        <span className="muted small">Loading…</span>
      ) : sites.length === 0 ? (
        <span className="muted small">No site access granted.</span>
      ) : (
        <>
          <div className="site-summary">
            <span className="small">{summary}</span>
            {unused.length > 0 && (
              <button className="small" onClick={() => void removeUnused()}>
                Remove unused ({unused.length})
              </button>
            )}
          </div>
          {sites.length > FILTER_AFTER && (
            <input type="search" placeholder="Filter sites…" aria-label="Filter sites" value={filter} onChange={(e) => setFilter(e.target.value)} />
          )}
          {/* One row per site: Chrome keeps a pattern per scheme (all sites = http + https). */}
          <div className="site-list">
            {shown.map((s) => (
              <div key={s.g.key} className="site-row">
                <div className="site-main" title={s.g.origins.join("\n")}>
                  <code className="site-origin">{s.g.label}</code>
                  <span className="small muted">{describe(s)}</span>
                </div>
                <button className="small" onClick={() => void remove(s.g.origins, s.g.kind === "all" ? "all websites" : s.g.label)}>
                  Remove
                </button>
              </div>
            ))}
            {q && matching.length === 0 && <span className="small muted site-row">No sites match “{filter}”.</span>}
          </div>
          {!q && matching.length > COLLAPSED_SITES && (
            <button className="link small" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
              {expanded ? "Show fewer" : `Show all ${matching.length} sites`}
            </button>
          )}
        </>
      )}
      <ErrorBox error={error} />
      <div className="row">
        {origins && !hasAllSites(origins) && <button onClick={() => void requestOrigins(ALL_SITE_PATTERNS)}>Allow access to all sites</button>}
        {origins && origins.length > 0 && <button onClick={() => void remove(origins, "all sites")}>Remove all</button>}
      </div>
    </div>
  );
}
