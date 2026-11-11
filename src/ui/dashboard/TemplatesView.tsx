import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, originOf, requestOrigins } from "../shared/api";
import { useApi } from "../shared/hooks";
import { ErrorBox } from "../shared/components";
import { QueryChoice } from "../shared/QueryChoice";
import type { Rule, Settings, TabInfo } from "../../core/types";
import { STOP_AFTER_CHOICES } from "../../core/defaults";
import { matchesAny } from "../../core/url-pattern";
import { intervalLabel, priorityAbove, stopAfterLabel } from "../popup/describe";
import { hostOf, normalizeAddress, pageLabel, stashBuilderDraft, TEMPLATES, type Template, type TemplateValues } from "./templates";

/** Dashboard → Templates: ready-made rules you fill in. */
export function TemplatesView() {
  const [open, setOpen] = useState<Template | null>(null);
  const [created, setCreated] = useState<{ name: string; note?: string } | null>(null);
  return (
    <>
      <div className="col" style={{ gap: 4, maxWidth: 760 }}>
        <h1>Templates</h1>
        <p className="muted" style={{ margin: 0 }}>
          Start from a ready-made rule. You fill in the blanks, and JustRefresh shows what it will do before anything is saved.
        </p>
      </div>
      {created && (
        <div className={`${created.note ? "notice" : "info"} row`} role="status">
          <span>
            Created “{created.name}”. {created.note ?? "It runs on matching tabs from now on."}
          </span>
          <a href="#/rules">See it in Rules</a>
        </div>
      )}
      <div className="template-grid">
        {TEMPLATES.map((t) => (
          <article key={t.id} className="card col template-card">
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <h2 className="grow" style={{ margin: 0 }}>{t.title}</h2>
              {t.badge && <span className="pill pill-ok">{t.badge}</span>}
            </div>
            <p style={{ margin: 0 }}>{t.description}</p>
            <p className="small muted" style={{ margin: 0 }}>You fill in: {t.fills}</p>
            {t.warning && <p className="notice small" style={{ margin: 0 }}>{t.warning}</p>}
            <span className="spacer" />
            <button style={{ alignSelf: "flex-start" }} aria-label={`Use template: ${t.title}`} onClick={() => { setCreated(null); setOpen(t); }}>
              Use template
            </button>
          </article>
        ))}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Have a rule as JSON, for example from an AI agent? Import it in <a href="#/settings">Settings → Import / export</a>.
      </p>
      {open && (
        <TemplateForm
          template={open}
          onClose={() => setOpen(null)}
          onCreated={(name, note) => {
            setOpen(null);
            setCreated({ name, note });
          }}
        />
      )}
    </>
  );
}

const ADDRESS = "__address__";

function TemplateForm({ template: t, onClose, onCreated }: { template: Template; onClose: () => void; onCreated: (name: string, note?: string) => void }) {
  const tabs = useApi<TabInfo[]>("listTabs");
  const rules = useApi<Rule[]>("listRules");
  const overview = useApi<{ settings: Settings }>("getOverview");
  const settings = overview.data?.settings;
  const [stopAfter, setStopAfter] = useState<number | null | undefined>(undefined);
  const webTabs = (tabs.data ?? []).filter((x) => /^https?:/.test(x.url));
  const [choice, setChoice] = useState<string>("");
  const [address, setAddress] = useState("");
  const [text, setText] = useState(t.text?.initial ?? "");
  const [seconds, setSeconds] = useState(t.initialSeconds);
  const [start, setStart] = useState("08:00");
  const [end, setEnd] = useState("18:00");
  const [anyQuery, setAnyQuery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Default to the most recently used open web tab once tabs load.
  useEffect(() => {
    if (choice || tabs.data === null) return;
    setChoice(webTabs.length ? String(webTabs[0]!.id) : ADDRESS);
  }, [tabs.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    boxRef.current?.querySelector<HTMLElement>("select, input")?.focus();
    return () => previous?.focus?.();
  }, []);

  const pickedTab = webTabs.find((x) => String(x.id) === choice) ?? null;
  const url = choice === ADDRESS ? normalizeAddress(address) : (pickedTab?.url ?? null);
  // A page template outranks rules already matching its page, or it would never
  // run there. A site-wide template doesn't: more specific rules keep their pages.
  const matching = url && t.scope === "page" ? (rules.data ?? []).filter((r) => r.enabled && !r.meta.draft && matchesAny(r.target.patterns, url) !== null) : [];
  const stopAfterMinutes = stopAfter === undefined ? (settings?.defaultStopAfterMinutes ?? null) : stopAfter;
  const protects = settings ? settings.defaultSafety.pauseWhileTyping : true;
  const values: TemplateValues | null = url ? { url, text, seconds, start, end, stopAfterMinutes: t.until ? stopAfterMinutes : null, priority: priorityAbove(matching), protects, anyQuery: t.scope === "page" && anyQuery } : null;
  const textOk = !t.text || text.trim().length > 0;
  const hoursOk = !t.hours || (start !== "" && end !== "" && start < end);
  // Wait for rules and settings: priority, protection wording and the default time limit come from them.
  const loaded = rules.data !== null && overview.data !== null;
  const ready = !!values && textOk && hoursOk && loaded && !busy;
  const host = url ? hostOf(url) : "";

  const create = async () => {
    if (!values || !url) return;
    setError(null);
    setBusy(true);
    try {
      // Ask first, inside the click: page reading (conditions, protection) needs site access.
      const origin = originOf(url);
      if (origin && !(await requestOrigins([origin]).catch(() => false))) {
        setError(new Error(`JustRefresh needs access to ${host} to read the page. Nothing was created.`));
        return;
      }
      const rule = (await api("createRule", { rule: t.build(values) })) as Rule;
      // The rule now exists: whatever happens next, close the form (no duplicate on a second click).
      let note: string | undefined;
      // A page template takes over the chosen tab from a tab-specific timer, which would outrank it.
      if (pickedTab && t.scope === "page") {
        const state = (await api("getTabState", { tabId: pickedTab.id })) as { override: { mode: string } | null };
        if (state.override?.mode === "custom") await api("clearTabOverride", { tabId: pickedTab.id });
        const after = (await api("getTabState", { tabId: pickedTab.id })) as { resolution: { kind: string; reason?: string; controllerId: string | null; controllerName: string | null } };
        if (after.resolution.controllerId === rule.id) await api("runNow", { tabId: pickedTab.id }).catch(() => undefined);
        else note = takeoverNote(after.resolution);
      }
      onCreated(rule.name, note);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const customise = () => {
    if (!values) return;
    stashBuilderDraft({ ...t.build(values), enabled: false });
    location.hash = "/builder?draft=template";
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      // Keep focus inside the form while it's open.
      const items = [...(boxRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input, select") ?? [])];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={boxRef} className="dialog template-form" role="dialog" aria-modal="true" aria-labelledby="tpl-title" onKeyDown={onKeyDown}>
        <div className="col" style={{ gap: 2 }}>
          <span className="eyebrow">Template</span>
          <h3 id="tpl-title" style={{ fontSize: 18 }}>{t.title}</h3>
        </div>

        {t.warning && <p className="notice small" style={{ margin: 0 }}>{t.warning}</p>}

        <label className="field">
          <span className="field-label">{t.scope === "site" ? "Which site?" : "Which page?"}</span>
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            {webTabs.map((x) => (
              <option key={x.id} value={x.id}>
                {t.scope === "site" ? hostOf(x.url) : `${x.title ? `${x.title} · ` : ""}${pageLabel(x.url)}`} (open tab)
              </option>
            ))}
            <option value={ADDRESS}>Type an address…</option>
          </select>
          {choice === ADDRESS && (
            <input aria-label="Address" placeholder="shop.example.com/item/42" value={address} onChange={(e) => setAddress(e.target.value)} />
          )}
          <span className="field-hint">
            {choice === ADDRESS && address && !url ? "That doesn't look like a web address." : t.scope === "site" ? "Every page on this site." : "Pick one of your open tabs, or type an address."}
          </span>
        </label>
        {t.scope === "page" && url && <QueryChoice url={url} anyQuery={anyQuery} onChange={setAnyQuery} />}

        {t.text && (
          <label className="field">
            <span className="field-label">{t.text.label}</span>
            <input value={text} maxLength={200} onChange={(e) => setText(e.target.value)} />
            <span className="field-hint">{t.text.hint}</span>
          </label>
        )}

        {t.intervals && (
          <div className="field">
            <span className="field-label">Check every</span>
            <div className="chips" style={{ gridTemplateColumns: `repeat(${t.intervals.length}, minmax(0, 1fr))` }} role="group" aria-label="Check every">
              {t.intervals.map((s) => (
                <button type="button" key={s} className={`chip${seconds === s ? " selected" : ""}`} aria-pressed={seconds === s} onClick={() => setSeconds(s)}>
                  {intervalLabel(s)}
                </button>
              ))}
            </div>
          </div>
        )}

        {t.until && (
          <label className="field">
            <span className="field-label">Stop watching after</span>
            <select value={stopAfterMinutes ?? ""} onChange={(e) => setStopAfter(e.target.value === "" ? null : Number(e.target.value))}>
              {STOP_AFTER_CHOICES.map((m) => (
                <option key={m ?? "none"} value={m ?? ""}>{stopAfterLabel(m)}</option>
              ))}
            </select>
            <span className="field-hint">If it hasn't happened by then, it stops and tells you. Your default is in Settings.</span>
          </label>
        )}

        {t.hours && (
          <div className="field">
            <span className="field-label">Working hours, Monday to Friday</span>
            <div className="row">
              <input type="time" aria-label="From" value={start} onChange={(e) => setStart(e.target.value)} />
              <span>to</span>
              <input type="time" aria-label="Until" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
            {!hoursOk && <span className="small field-error">The end time must be after the start time.</span>}
          </div>
        )}

        {values && textOk && hoursOk && (
          <div className="info col" style={{ gap: 4 }}>
            <span className="eyebrow">What it will do</span>
            <span>{t.describe(values)}</span>
            <span className="small muted">Chrome may ask once for access to {host} so JustRefresh can read the page.</span>
          </div>
        )}

        <ErrorBox error={error} />

        <div className="dialog-actions" style={{ alignItems: "center" }}>
          <button className="link" disabled={!values} onClick={customise}>Customise in the Rule Builder…</button>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!ready} onClick={() => void create()}>
            {busy ? "Creating…" : "Create and start"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Why a new page rule isn't running on the chosen tab. */
function takeoverNote(r: { kind: string; reason?: string; controllerName: string | null }): string {
  if (r.kind === "paused") return "All refreshing is paused; it starts when you resume.";
  if (r.kind === "disabled") return "Auto refresh is switched off in Settings, so it won't run until you turn it on.";
  if (r.kind === "tab_excluded" || r.kind === "url_excluded") return `It won't run on that tab: ${r.reason ?? "the tab is excluded"}.`;
  if (r.controllerName) return `On that tab, “${r.controllerName}” still has priority. Raise the new rule's priority in the Rule Builder to change that.`;
  return "It isn't running on that tab yet.";
}
