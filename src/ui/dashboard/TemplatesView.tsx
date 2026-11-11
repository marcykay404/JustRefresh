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
              <h2 className="grow" style={{ margin: 0 }}>
                {t.title}
              </h2>
              {t.badge && <span className="pill pill-ok">{t.badge}</span>}
            </div>
            <p style={{ margin: 0 }}>{t.description}</p>
            <p className="small muted" style={{ margin: 0 }}>
              You fill in: {t.fills}
            </p>
            {t.warning && (
              <p className="notice small" style={{ margin: 0 }}>
                {t.warning}
              </p>
            )}
            <span className="spacer" />
            <button
              style={{ alignSelf: "flex-start" }}
              aria-label={`Use template: ${t.title}`}
              onClick={() => {
                setCreated(null);
                setOpen(t);
              }}
            >
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
  const webTabs = (tabs.data ?? []).filter((x) => /^https?:/.test(x.url));
  const [form, setForm] = useState<FormState>(() => ({
    choice: "",
    address: "",
    text: t.text?.initial ?? "",
    seconds: t.initialSeconds,
    start: "08:00",
    end: "18:00",
    anyQuery: false,
    stopAfter: undefined,
  }));
  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Default to the most recently used open web tab once tabs load.
  useEffect(() => {
    if (form.choice || tabs.data === null) return;
    update({ choice: webTabs.length ? String(webTabs[0]!.id) : ADDRESS });
  }, [tabs.data]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    boxRef.current?.querySelector<HTMLElement>("select, input")?.focus();
    return () => previous?.focus?.();
  }, []);

  const pickedTab = webTabs.find((x) => String(x.id) === form.choice) ?? null;
  const v = formValues(t, form, pickedTab, rules.data, overview.data?.settings);
  // Wait for rules and settings: priority, protection wording and the default time limit come from them.
  const loaded = rules.data !== null && overview.data !== null;
  const ready = !!v.values && v.textOk && v.hoursOk && loaded && !busy;

  const create = async () => {
    if (!v.values || !v.url) return;
    setError(null);
    setBusy(true);
    try {
      const done = await createFromTemplate(t, v.values, v.url, pickedTab);
      onCreated(done.name, done.note);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const customise = () => {
    if (!v.values) return;
    stashBuilderDraft({ ...t.build(v.values), enabled: false });
    location.hash = "/builder?draft=template";
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={boxRef}
        className="dialog template-form"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tpl-title"
        onKeyDown={(e) => trapFocus(e, boxRef.current, onClose)}
      >
        <div className="col" style={{ gap: 2 }}>
          <span className="eyebrow">Template</span>
          <h3 id="tpl-title" style={{ fontSize: 18 }}>
            {t.title}
          </h3>
        </div>

        <TemplateBlanks t={t} form={form} update={update} webTabs={webTabs} v={v} />

        <ErrorBox error={error} />

        <div className="dialog-actions" style={{ alignItems: "center" }}>
          <button className="link" disabled={!v.values} onClick={customise}>
            Customise in the Rule Builder…
          </button>
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

interface FormState {
  /** An open tab's id, or ADDRESS to type one. */
  choice: string;
  address: string;
  text: string;
  seconds: number;
  start: string;
  end: string;
  anyQuery: boolean;
  /** undefined = the Settings default. */
  stopAfter: number | null | undefined;
}

type Update = (patch: Partial<FormState>) => void;

/** The template's blanks as filled in: the rule's values (null until there's a page) and what's missing. */
function formValues(t: Template, f: FormState, pickedTab: TabInfo | null, rules: Rule[] | null, settings: Settings | undefined) {
  const url = f.choice === ADDRESS ? normalizeAddress(f.address) : (pickedTab?.url ?? null);
  const stopAfterMinutes = f.stopAfter === undefined ? (settings?.defaultStopAfterMinutes ?? null) : f.stopAfter;
  return {
    url,
    values: url ? ruleValues(t, f, url, rules, settings, stopAfterMinutes) : null,
    stopAfterMinutes,
    textOk: !t.text || f.text.trim().length > 0,
    hoursOk: !t.hours || (f.start !== "" && f.end !== "" && f.start < f.end),
  };
}

function ruleValues(
  t: Template,
  f: FormState,
  url: string,
  rules: Rule[] | null,
  settings: Settings | undefined,
  stopAfterMinutes: number | null,
): TemplateValues {
  // A page template outranks rules already matching its page, or it would never
  // run there. A site-wide template doesn't: more specific rules keep their pages.
  const matching = t.scope === "page" ? (rules ?? []).filter((r) => r.enabled && !r.meta.draft && matchesAny(r.target.patterns, url) !== null) : [];
  return {
    url,
    text: f.text,
    seconds: f.seconds,
    start: f.start,
    end: f.end,
    stopAfterMinutes: t.until ? stopAfterMinutes : null,
    priority: priorityAbove(matching),
    protects: settings ? settings.defaultSafety.pauseWhileTyping : true,
    anyQuery: t.scope === "page" && f.anyQuery,
  };
}

/**
 * Create the template's rule: ask for site access first (inside the click),
 * then, for a page template on an open tab, take that tab over from a
 * tab-specific timer (which would outrank it) and check at once. Once the
 * rule exists, the form closes whatever happens next (no duplicate on a
 * second click): `note` says why it isn't running on the tab.
 */
async function createFromTemplate(t: Template, values: TemplateValues, url: string, pickedTab: TabInfo | null): Promise<{ name: string; note?: string }> {
  const origin = originOf(url);
  if (origin && !(await requestOrigins([origin]).catch(() => false))) {
    throw new Error(`JustRefresh needs access to ${hostOf(url)} to read the page. Nothing was created.`);
  }
  const rule = (await api("createRule", { rule: t.build(values) })) as Rule;
  if (!pickedTab || t.scope !== "page") return { name: rule.name };
  const state = (await api("getTabState", { tabId: pickedTab.id })) as { override: { mode: string } | null };
  if (state.override?.mode === "custom") await api("clearTabOverride", { tabId: pickedTab.id });
  const after = (await api("getTabState", { tabId: pickedTab.id })) as {
    resolution: { kind: string; reason?: string; controllerId: string | null; controllerName: string | null };
  };
  if (after.resolution.controllerId !== rule.id) return { name: rule.name, note: takeoverNote(after.resolution) };
  await api("runNow", { tabId: pickedTab.id }).catch(() => undefined);
  return { name: rule.name };
}

/** Escape closes the form; Tab keeps focus inside it. */
function trapFocus(e: KeyboardEvent, box: HTMLElement | null, onClose: () => void) {
  if (e.key === "Escape") {
    e.preventDefault();
    onClose();
    return;
  }
  if (e.key !== "Tab") return;
  const items = [...(box?.querySelectorAll<HTMLElement>("button:not(:disabled), input, select") ?? [])];
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  const atEdge = e.shiftKey ? document.activeElement === first : document.activeElement === last;
  if (!atEdge) return;
  e.preventDefault();
  (e.shiftKey ? last : first).focus();
}

/** The template's blanks, in order, and what the rule will do. */
function TemplateBlanks({
  t,
  form,
  update,
  webTabs,
  v,
}: {
  t: Template;
  form: FormState;
  update: Update;
  webTabs: TabInfo[];
  v: ReturnType<typeof formValues>;
}) {
  const complete = v.values && v.textOk && v.hoursOk ? v.values : null;
  return (
    <>
      {t.warning && (
        <p className="notice small" style={{ margin: 0 }}>
          {t.warning}
        </p>
      )}
      <PageField t={t} form={form} update={update} webTabs={webTabs} url={v.url} />
      {t.scope === "page" && v.url && <QueryChoice url={v.url} anyQuery={form.anyQuery} onChange={(anyQuery) => update({ anyQuery })} />}
      {t.text && (
        <label className="field">
          <span className="field-label">{t.text.label}</span>
          <input value={form.text} maxLength={200} onChange={(e) => update({ text: e.target.value })} />
          <span className="field-hint">{t.text.hint}</span>
        </label>
      )}
      {t.intervals && <IntervalField intervals={t.intervals} seconds={form.seconds} onPick={(seconds) => update({ seconds })} />}
      {t.until && <StopAfterField minutes={v.stopAfterMinutes} onChange={(stopAfter) => update({ stopAfter })} />}
      {t.hours && <HoursField start={form.start} end={form.end} ok={v.hoursOk} update={update} />}
      {complete && (
        <div className="info col" style={{ gap: 4 }}>
          <span className="eyebrow">What it will do</span>
          <span>{t.describe(complete)}</span>
          <span className="small muted">Chrome may ask once for access to {hostOf(complete.url)} so JustRefresh can read the page.</span>
        </div>
      )}
    </>
  );
}

function PageField({ t, form, update, webTabs, url }: { t: Template; form: FormState; update: Update; webTabs: TabInfo[]; url: string | null }) {
  const typing = form.choice === ADDRESS;
  const site = t.scope === "site";
  const hint =
    typing && form.address && !url
      ? "That doesn't look like a web address."
      : site
        ? "Every page on this site."
        : "Pick one of your open tabs, or type an address.";
  return (
    <label className="field">
      <span className="field-label">{site ? "Which site?" : "Which page?"}</span>
      <select value={form.choice} onChange={(e) => update({ choice: e.target.value })}>
        {webTabs.map((x) => (
          <option key={x.id} value={x.id}>
            {site ? hostOf(x.url) : `${x.title ? `${x.title} · ` : ""}${pageLabel(x.url)}`} (open tab)
          </option>
        ))}
        <option value={ADDRESS}>Type an address…</option>
      </select>
      {typing && (
        <input aria-label="Address" placeholder="shop.example.com/item/42" value={form.address} onChange={(e) => update({ address: e.target.value })} />
      )}
      <span className="field-hint">{hint}</span>
    </label>
  );
}

function IntervalField({ intervals, seconds, onPick }: { intervals: number[]; seconds: number; onPick: (s: number) => void }) {
  return (
    <div className="field">
      <span className="field-label">Check every</span>
      <div className="chips" style={{ gridTemplateColumns: `repeat(${intervals.length}, minmax(0, 1fr))` }} role="group" aria-label="Check every">
        {intervals.map((s) => (
          <button type="button" key={s} className={`chip${seconds === s ? " selected" : ""}`} aria-pressed={seconds === s} onClick={() => onPick(s)}>
            {intervalLabel(s)}
          </button>
        ))}
      </div>
    </div>
  );
}

function StopAfterField({ minutes, onChange }: { minutes: number | null; onChange: (m: number | null) => void }) {
  return (
    <label className="field">
      <span className="field-label">Stop watching after</span>
      <select value={minutes ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
        {STOP_AFTER_CHOICES.map((m) => (
          <option key={m ?? "none"} value={m ?? ""}>
            {stopAfterLabel(m)}
          </option>
        ))}
      </select>
      <span className="field-hint">If it hasn't happened by then, it stops and tells you. Your default is in Settings.</span>
    </label>
  );
}

function HoursField({ start, end, ok, update }: { start: string; end: string; ok: boolean; update: Update }) {
  return (
    <div className="field">
      <span className="field-label">Working hours, Monday to Friday</span>
      <div className="row">
        <input type="time" aria-label="From" value={start} onChange={(e) => update({ start: e.target.value })} />
        <span>to</span>
        <input type="time" aria-label="Until" value={end} onChange={(e) => update({ end: e.target.value })} />
      </div>
      {!ok && <span className="small field-error">The end time must be after the start time.</span>}
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
