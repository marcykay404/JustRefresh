import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, originOf, requestOrigins } from "../shared/api";
import { useApi } from "../shared/hooks";
import { ErrorBox } from "../shared/components";
import type { Rule, Settings, TabInfo } from "../../core/types";
import { STOP_AFTER_CHOICES } from "../../core/defaults";
import { matchesAny } from "../../core/url-pattern";
import { intervalLabel, priorityAbove, stopAfterLabel } from "../popup/describe";
import { hostOf, normalizeAddress, pageLabel, stashBuilderDraft, TEMPLATES, type Template, type TemplateValues } from "./templates";

/** Dashboard → Templates: ready-made rules you fill in. */
export function TemplatesView() {
  const [open, setOpen] = useState<Template | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  return (
    <>
      <div className="col" style={{ gap: 4, maxWidth: 760 }}>
        <h1>Templates</h1>
        <p className="muted" style={{ margin: 0 }}>
          Start from a ready-made rule. You fill in the blanks, and JustRefresh shows what it will do before anything is saved.
        </p>
      </div>
      {created && (
        <div className="info row" role="status">
          <span>
            Created “{created}”. It runs on matching tabs from now on.
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
          onCreated={(name) => {
            setOpen(null);
            setCreated(name);
          }}
        />
      )}
    </>
  );
}

const ADDRESS = "__address__";

function TemplateForm({ template: t, onClose, onCreated }: { template: Template; onClose: () => void; onCreated: (name: string) => void }) {
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
  // Outrank rules that already match the page, or the new rule would never run there.
  const matching = url ? (rules.data ?? []).filter((r) => r.enabled && !r.meta.draft && matchesAny(r.target.patterns, url) !== null) : [];
  const stopAfterMinutes = stopAfter === undefined ? (settings?.defaultStopAfterMinutes ?? null) : stopAfter;
  const protects = settings ? settings.defaultSafety.pauseWhileTyping : true;
  const values: TemplateValues | null = url ? { url, text, seconds, start, end, stopAfterMinutes: t.until ? stopAfterMinutes : null, priority: priorityAbove(matching), protects } : null;
  const textOk = !t.text || text.trim().length > 0;
  const hoursOk = !t.hours || (start !== "" && end !== "" && start < end);
  const ready = !!values && textOk && hoursOk && !busy;
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
      // A tab-specific timer on the chosen tab would outrank the new rule: hand the tab over.
      if (pickedTab) {
        const state = (await api("getTabState", { tabId: pickedTab.id })) as { override: { mode: string } | null };
        if (state.override?.mode === "custom") await api("clearTabOverride", { tabId: pickedTab.id });
        const after = (await api("getTabState", { tabId: pickedTab.id })) as { resolution: { controllerId: string | null; controllerName: string | null } };
        if (after.resolution.controllerId !== rule.id) {
          setError(new Error(`“${rule.name}” was created, but “${after.resolution.controllerName ?? "another rule"}” still controls that tab. Raise the new rule's priority in the Rule Builder.`));
          return;
        }
        if (t.scope === "page") await api("runNow", { tabId: pickedTab.id }).catch(() => undefined);
      }
      onCreated(rule.name);
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
