import { useEffect, useRef, useState } from "react";
import { api, requestOrigins } from "../shared/api";
import { useApi } from "../shared/hooks";
import { downloadJson } from "../shared/format";
import { ErrorBox, Field, Toggle } from "../shared/components";
import { INTERVAL_PRESETS } from "../../core/defaults";
import type { Rule, Settings } from "../../core/types";
import type { ImportReport } from "../../integrations/json-import";

export function SettingsView() {
  const { data, error, reload } = useApi<{ settings: Settings }>("getOverview");
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
          <Toggle checked={s.notificationsEnabled} onChange={(v) => update({ notificationsEnabled: v })} label="Desktop notifications" />
          <Toggle checked={s.skipDiscardedTabs} onChange={(v) => update({ skipDiscardedTabs: v })} label="Skip discarded (memory-saver) tabs" />
        </div>

        <div className="card col">
          <h2>Default activity protection</h2>
          <Toggle checked={sf.pauseWhileTyping} onChange={(v) => update({ defaultSafety: { pauseWhileTyping: v } })} label="Pause while typing" />
          <Toggle checked={sf.protectUnsavedChanges} onChange={(v) => update({ defaultSafety: { protectUnsavedChanges: v } })} label="Protect unsaved form changes" />
          <Toggle checked={sf.pauseOnMouse} onChange={(v) => update({ defaultSafety: { pauseOnMouse: v } })} label="Also pause on mouse activity" />
          <Toggle checked={sf.pauseOnScroll} onChange={(v) => update({ defaultSafety: { pauseOnScroll: v } })} label="Also pause on scrolling" />
          <Field label="Inactivity grace period" hint="Refresh waits until there has been no activity for this long.">
            <select value={sf.inactivityGraceSeconds} onChange={(e) => update({ defaultSafety: { inactivityGraceSeconds: Number(e.target.value) } })}>
              {[30, 60, 120, 300, 600, 1800].map((v) => <option key={v} value={v}>{v < 60 ? `${v} s` : `${v / 60} min`}</option>)}
              {![30, 60, 120, 300, 600, 1800].includes(sf.inactivityGraceSeconds) && <option value={sf.inactivityGraceSeconds}>{sf.inactivityGraceSeconds} s</option>}
            </select>
          </Field>
          <Field label="When activity detection is unavailable" hint="E.g. site access not granted or the page blocks the content script.">
            <select value={sf.onActivityUnavailable} onChange={(e) => update({ defaultSafety: { onActivityUnavailable: e.target.value } })}>
              <option value="pause">Pause (safe)</option>
              <option value="refresh">Refresh anyway</option>
            </select>
          </Field>
          <Field label="When a condition is unknown">
            <select value={sf.onUnknown} onChange={(e) => update({ defaultSafety: { onUnknown: e.target.value } })}>
              <option value="pause">Pause and retry (bounded)</option>
              <option value="skip">Skip this cycle</option>
              <option value="refresh">Refresh anyway</option>
              <option value="stop">Stop</option>
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
          <h2>History & privacy</h2>
          <Field label="Maximum history entries">
            <input type="number" min={10} max={5000} defaultValue={s.historyLimit} onBlur={(e) => update({ historyLimit: Number(e.target.value) })} />
          </Field>
          <Field label="Keep history for (days)">
            <input type="number" min={1} max={365} defaultValue={s.historyRetentionDays} onBlur={(e) => update({ historyRetentionDays: Number(e.target.value) })} />
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
            if (confirm("Reset ALL settings, rules, exclusions and agents to defaults? Export first if unsure.")) {
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

/** "https://github.com/*" → "github.com"; wildcards and file URLs get readable labels. */
function siteLabel(origin: string): { label: string; host: string | null } {
  if (origin === "file:///*") return { label: "Local files (file://)", host: null };
  const m = /^[a-z*]+:\/\/([^/]+)\//.exec(origin);
  const host = m?.[1] ?? null;
  if (!host || host === "*") return { label: `All websites (${origin})`, host: null };
  return { label: origin, host: host.replace(/^\*\./, "") };
}

/**
 * Granted site access, per site, with removal. Chrome's own extension page
 * cannot revoke runtime-granted sites individually, so this is the place.
 */
function SiteAccess() {
  const [origins, setOrigins] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const rules = useApi<Rule[]>("listRules");

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

  /** Rules whose patterns mention this host (a hint, not an exact match). */
  const usedBy = (host: string | null) =>
    host ? (rules.data ?? []).filter((r) => r.target.patterns.some((p) => (typeof p === "string" ? p : p.value).replace(/\\/g, "").toLowerCase().includes(host.toLowerCase()))) : [];

  const remove = async (list: string[], what: string) => {
    setError(null);
    if (!confirm(`Remove JustRefresh's access to ${what}?\n\nRules and tabs on ${list.length > 1 ? "these sites" : "this site"} will pause instead of refreshing unless they are set to refresh without protection, and page conditions will report "unknown".`)) return;
    try {
      await chrome.permissions.remove({ origins: list });
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="card col">
      <h2>Site access</h2>
      <p className="small muted" style={{ margin: 0 }}>
        JustRefresh installs without access to any website. Access is requested per site when you enable refresh. It is needed for activity protection
        and page (DOM) conditions; without it, a tab only refreshes if you chose to refresh without protection.
      </p>
      {origins === null ? (
        <span className="muted small">Loading…</span>
      ) : origins.length === 0 ? (
        <span className="muted small">No site access granted.</span>
      ) : (
        <table>
          <thead><tr><th>Site</th><th>Used by rules</th><th /></tr></thead>
          <tbody>
            {origins.map((o) => {
              const { label, host } = siteLabel(o);
              const used = usedBy(host);
              return (
                <tr key={o}>
                  <td className="mono small">{label}</td>
                  <td className="small">{used.length ? used.map((r) => r.name).join(", ") : <span className="muted">—</span>}</td>
                  <td><button className="small" onClick={() => void remove([o], label)}>Remove</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <ErrorBox error={error} />
      <div className="row">
        <button onClick={() => void requestOrigins(["http://*/*", "https://*/*"])}>Grant access to all sites</button>
        {origins && origins.length > 0 && <button onClick={() => void remove(origins, "all sites")}>Revoke all site access</button>}
      </div>
    </div>
  );
}
