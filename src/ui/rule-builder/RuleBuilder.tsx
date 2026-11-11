/**
 * Visual rule builder: WHEN → ON → UNTIL → THEN.
 * A client of the Rule Management API like any agent: it validates, tests
 * (dry run) and saves through the same methods.
 */
import { useEffect, useMemo, useState } from "react";
import { api, ApiClientError } from "../shared/api";
import { useApi } from "../shared/hooks";
import { downloadJson } from "../shared/format";
import { Diagnostics, ErrorBox, Field, Toggle } from "../shared/components";
import { detectPattern, validatePattern, patternToString } from "../../core/url-pattern";
import type { ActionConfig, ConditionNode, Diagnostic, EvaluationResult, EvaluationTrace, Rule, RuleInput, TabInfo, UrlPatternInput } from "../../core/types";
import { ConditionEditor, describeCondition, isSimpleTree, type CapabilityItem } from "./ConditionEditor";
import { defaultsFor, SchemaForm } from "./SchemaForm";

interface Capabilities {
  conditions: CapabilityItem[];
  triggers: CapabilityItem[];
  actions: (CapabilityItem & { disruptive: boolean })[];
  limits: { minIntervalSeconds: number };
}

type Draft = RuleInput & { stopWhen?: ConditionNode };

function initialDraft(url?: string): Draft {
  let pattern = "https://example.com/*";
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol.startsWith("http")) pattern = `${u.origin}${u.pathname.replace(/[^/]*$/, "")}*`;
    } catch {
      /* ignore */
    }
  }
  return {
    name: url ? `Refresh ${new URL(url).hostname}` : "",
    enabled: true,
    priority: 0,
    target: { type: "url", patterns: [pattern], exclusions: [] },
    trigger: { type: "interval", seconds: 60 },
    actions: { onMatched: [{ type: "stopRefresh" }, { type: "notify" }], onNotMatched: [{ type: "refresh" }] },
    safety: {},
    limits: {},
  };
}

function stripMeta(rule: Rule): Draft {
  const { meta: _m, schemaVersion: _v, ...rest } = rule;
  return rest as unknown as Draft;
}

/** Remove empty optional sections so the JSON stays tidy. */
function clean(d: Draft): Draft {
  const out: Record<string, unknown> = { ...d };
  if (!out.stopWhen) delete out.stopWhen;
  if (out.limits && !Object.keys(out.limits as object).length) delete out.limits;
  if (out.safety && !Object.keys(out.safety as object).length) delete out.safety;
  if (!out.description) delete out.description;
  const sch = out.schedule as Record<string, unknown> | undefined;
  if (sch && !sch.days && !sch.startTime) delete out.schedule;
  return out as Draft;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function RuleBuilder({ ruleId, initialUrl }: { ruleId?: string; initialUrl?: string }) {
  const caps = useApi<Capabilities>("getCapabilities");
  const tabs = useApi<TabInfo[]>("listTabs");
  const [existing, setExisting] = useState<Rule | null>(null);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(initialUrl));
  const [advanced, setAdvanced] = useState(false);
  const [view, setView] = useState<"visual" | "json">("visual");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [valid, setValid] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [testTab, setTestTab] = useState<number | null>(null);

  useEffect(() => {
    if (!ruleId) return;
    api<Rule>("getRule", { id: ruleId })
      .then((r) => {
        setExisting(r);
        setDraft(stripMeta(r));
        setAdvanced(!isSimpleTree(r.stopWhen));
      })
      .catch(setLoadError);
  }, [ruleId]);

  useEffect(() => {
    if (testTab !== null || !tabs.data) return;
    const match = tabs.data.find((t) => t.url === initialUrl) ?? tabs.data.find((t) => !t.restricted);
    if (match) setTestTab(match.id);
  }, [tabs.data, initialUrl, testTab]);

  const cleaned = useMemo(() => clean(draft), [draft]);

  // Live validation through the API (debounced).
  useEffect(() => {
    const t = setTimeout(() => {
      api<{ valid: boolean; diagnostics: Diagnostic[] }>("validateRule", { rule: cleaned })
        .then((r) => {
          setDiagnostics(r.diagnostics);
          setValid(r.valid);
        })
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [cleaned]);

  useEffect(() => {
    if (view === "json") setJsonText(JSON.stringify(cleaned, null, 2));
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<Draft>) => {
    setSaved(null);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const save = async () => {
    setSaveError(null);
    try {
      if (existing) {
        const r = await api<Rule>("updateRule", { id: existing.id, patch: cleaned, expectedRevision: existing.meta.revision });
        setExisting(r);
        setDraft(stripMeta(r));
        setSaved("Saved");
      } else {
        const r = await api<Rule>("createRule", { rule: cleaned });
        location.hash = `/builder/${r.id}`;
      }
    } catch (e) {
      setSaveError(e);
    }
  };

  if (loadError) return <ErrorBox error={loadError} />;
  if (!caps.data) return <div className="muted">Loading…</div>;
  const c = caps.data;
  const trigger = draft.trigger as { type: string; seconds?: number; randomMaxSeconds?: number };
  const actions = draft.actions ?? {};
  const safety = draft.safety ?? {};
  const limits = draft.limits ?? {};
  const triggerCap = c.triggers.find((t) => t.type === trigger.type);
  const refreshAllowed = trigger.type === "interval" || trigger.type === "startup" || trigger.type === "manual";

  const setStopWhen = (n: ConditionNode | null) => set({ stopWhen: n ?? undefined });
  const firstLeaf = c.conditions.find((x) => !["all", "any", "not"].includes(x.type))!;

  const errorsFor = (prefix: string) => diagnostics.filter((d) => d.path === prefix || d.path.startsWith(`${prefix}.`) || d.path.startsWith(`${prefix}[`));

  return (
    <>
      <div className="row">
        <h1>{existing ? `Edit rule: ${existing.name}` : "New rule"}</h1>
        {existing?.meta.draft && <span className="pill pill-warn">Draft</span>}
        {existing?.meta.origin.type === "agent" && <span className="pill pill-done">Created by {existing.meta.origin.agentId}</span>}
        <span className="spacer" />
        <Toggle checked={advanced} onChange={(v) => (v || isSimpleTree(draft.stopWhen) ? setAdvanced(v) : alert("This rule uses nested groups; simplify it before switching to simple mode."))} label="Advanced mode" />
        <div className="row" role="tablist">
          <button className={view === "visual" ? "primary" : ""} onClick={() => setView("visual")}>Visual</button>
          <button className={view === "json" ? "primary" : ""} onClick={() => setView("json")}>JSON</button>
        </div>
      </div>

      <div className="builder">
        <div className="col">
          {view === "json" ? (
            <div className="card col">
              <span className="muted small">Edit the rule as JSON (same format agents generate). Apply to sync back to the visual editor.</span>
              <textarea rows={30} value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} aria-label="Rule JSON" />
              {jsonError && <div className="error-box">{jsonError}</div>}
              <div className="row">
                <button
                  className="primary"
                  onClick={() => {
                    try {
                      const parsed = JSON.parse(jsonText);
                      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a single rule object");
                      delete parsed.meta;
                      const base = initialDraft();
                      setDraft({ ...parsed, target: { ...base.target, ...(parsed.target ?? {}) }, trigger: parsed.trigger ?? base.trigger });
                      setAdvanced(advanced || !isSimpleTree(parsed.stopWhen));
                      setJsonError(null);
                      setView("visual");
                    } catch (e) {
                      setJsonError((e as Error).message);
                    }
                  }}
                >
                  Apply JSON
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="card col">
                <div className="row">
                  <Field label="Name">
                    <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Watch order status" style={{ minWidth: 260 }} />
                  </Field>
                  <Field label="Priority" hint="Higher wins">
                    <input type="number" style={{ width: 90 }} value={draft.priority ?? 0} onChange={(e) => set({ priority: Number(e.target.value) })} />
                  </Field>
                  <Toggle checked={draft.enabled !== false} onChange={(v) => set({ enabled: v })} label="Enabled" />
                </div>
                <Field label="Description (optional)">
                  <input value={draft.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
                </Field>
                <Diagnostics items={diagnostics.filter((d) => d.path === "name" || d.path === "priority" || d.path === "$")} />
              </div>

              <div className="card col">
                <div className="section-title">WHEN</div>
                <div className="row">
                  <select
                    aria-label="Trigger type"
                    value={trigger.type}
                    onChange={(e) => {
                      const t = e.target.value;
                      const cap = c.triggers.find((x) => x.type === t);
                      const nt = t === "interval" ? { type: "interval", seconds: 60 } : defaultsFor(t, cap?.schema);
                      const ok = t === "interval" || t === "startup" || t === "manual";
                      set({
                        trigger: nt as Draft["trigger"],
                        actions: { ...actions, onNotMatched: ok ? (actions.onNotMatched?.length ? actions.onNotMatched : [{ type: "refresh" }]) : (actions.onNotMatched ?? []).filter((a) => a.type !== "refresh") },
                      });
                    }}
                  >
                    {c.triggers.map((t) => <option key={t.type} value={t.type}>{t.title}</option>)}
                  </select>
                  {trigger.type === "interval" && <IntervalInput seconds={trigger.seconds ?? 60} onChange={(s) => set({ trigger: { ...trigger, seconds: s } as Draft["trigger"] })} min={c.limits.minIntervalSeconds} />}
                </div>
                {trigger.type === "interval" && (
                  <div className="row">
                    <Toggle
                      checked={trigger.randomMaxSeconds !== undefined}
                      onChange={(v) => {
                        const { randomMaxSeconds: _r, ...rest } = trigger;
                        set({ trigger: (v ? { ...rest, randomMaxSeconds: (trigger.seconds ?? 60) * 2 } : rest) as Draft["trigger"] });
                      }}
                      label="Randomize interval"
                    />
                    {trigger.randomMaxSeconds !== undefined && (
                      <>
                        <span className="small muted">up to</span>
                        <IntervalInput seconds={trigger.randomMaxSeconds} onChange={(s) => set({ trigger: { ...trigger, randomMaxSeconds: s } as Draft["trigger"] })} min={c.limits.minIntervalSeconds} />
                      </>
                    )}
                  </div>
                )}
                <span className="small muted">{triggerCap?.description}</span>
                <Diagnostics items={errorsFor("trigger")} />
              </div>

              <div className="card col">
                <div className="section-title">ON</div>
                <PatternList label="Pages matching" items={draft.target.patterns} onChange={(p) => set({ target: { ...draft.target, patterns: p } })} />
                <PatternList label="Except pages matching" items={draft.target.exclusions ?? []} onChange={(p) => set({ target: { ...draft.target, exclusions: p } })} />
                <Diagnostics items={errorsFor("target")} />
              </div>

              <div className="card col">
                <div className="section-title">UNTIL</div>
                {draft.stopWhen ? (
                  <>
                    <span className="small muted">Stop when:</span>
                    <ConditionEditor
                      node={draft.stopWhen.type === "any" || draft.stopWhen.type === "all" || advanced ? draft.stopWhen : { type: "any", conditions: [draft.stopWhen] }}
                      onChange={setStopWhen}
                      conditions={c.conditions}
                      advanced={advanced}
                      onTestSelector={(sel) => testTab !== null && void testSelector(testTab, sel)}
                    />
                  </>
                ) : (
                  <div className="row">
                    <span className="muted">No stop condition — refreshes until stopped or a limit is reached.</span>
                    <button className="small" onClick={() => setStopWhen({ type: "any", conditions: [defaultsFor(firstLeaf.type, firstLeaf.schema) as ConditionNode] })}>
                      + Add stop condition
                    </button>
                  </div>
                )}
                <Diagnostics items={errorsFor("stopWhen")} />
                <SelectorResult />
              </div>

              <div className="card col">
                <div className="section-title">THEN</div>
                {draft.stopWhen && (
                  <ActionList
                    label="When the condition matches"
                    items={actions.onMatched ?? []}
                    caps={c.actions}
                    allowRefresh={refreshAllowed}
                    onChange={(a) => set({ actions: { ...actions, onMatched: a } })}
                  />
                )}
                <ActionList
                  label={draft.stopWhen ? "Otherwise" : "Each time it fires"}
                  items={actions.onNotMatched ?? []}
                  caps={c.actions}
                  allowRefresh={refreshAllowed}
                  onChange={(a) => set({ actions: { ...actions, onNotMatched: a } })}
                />
                {advanced && draft.stopWhen && (
                  <ActionList
                    label="When the condition is unknown (before the unknown policy)"
                    items={actions.onUnknown ?? []}
                    caps={c.actions}
                    allowRefresh={false}
                    onChange={(a) => set({ actions: { ...actions, onUnknown: a.length ? a : undefined } })}
                  />
                )}
                <Diagnostics items={errorsFor("actions")} />
              </div>

              <div className="card col">
                <div className="section-title">SAFETY & LIMITS</div>
                <span className="small muted">"Default" values are filled from Settings when the rule is saved.</span>
                <div className="row">
                  <TriToggle label="Pause while typing" value={safety.pauseWhileTyping} onChange={(v) => set({ safety: { ...safety, pauseWhileTyping: v } })} />
                  <TriToggle label="Protect unsaved changes" value={safety.protectUnsavedChanges} onChange={(v) => set({ safety: { ...safety, protectUnsavedChanges: v } })} />
                  <TriToggle label="Pause on mouse" value={safety.pauseOnMouse} onChange={(v) => set({ safety: { ...safety, pauseOnMouse: v } })} />
                  <TriToggle label="Pause on scroll" value={safety.pauseOnScroll} onChange={(v) => set({ safety: { ...safety, pauseOnScroll: v } })} />
                </div>
                <div className="row">
                  <Field label="Inactivity grace (s)">
                    <OptNumber value={safety.inactivityGraceSeconds} onChange={(v) => set({ safety: { ...safety, inactivityGraceSeconds: v } })} />
                  </Field>
                  <Field label="If condition unknown">
                    <OptSelect value={safety.onUnknown} options={["pause", "skip", "refresh", "stop"]} onChange={(v) => set({ safety: { ...safety, onUnknown: v as never } })} />
                  </Field>
                  <Field label="Unknown retries">
                    <OptNumber value={safety.maxUnknownRetries} onChange={(v) => set({ safety: { ...safety, maxUnknownRetries: v } })} />
                  </Field>
                  <Field label="If activity detection unavailable">
                    <OptSelect value={safety.onActivityUnavailable} options={["pause", "refresh"]} onChange={(v) => set({ safety: { ...safety, onActivityUnavailable: v as never } })} />
                  </Field>
                </div>
                <div className="row">
                  <Field label="Max refreshes">
                    <OptNumber value={limits.maxRefreshes} onChange={(v) => set({ limits: { ...limits, maxRefreshes: v } })} />
                  </Field>
                  <Field label="Max duration (min)">
                    <OptNumber
                      value={limits.maxDurationSeconds !== undefined ? limits.maxDurationSeconds / 60 : undefined}
                      onChange={(v) => set({ limits: { ...limits, maxDurationSeconds: v === undefined ? undefined : Math.round(v * 60) } })}
                    />
                  </Field>
                  <Field label="Stop at">
                    <input
                      type="datetime-local"
                      value={limits.stopAt ? toLocalInput(limits.stopAt) : ""}
                      onChange={(e) => set({ limits: { ...limits, stopAt: e.target.value ? new Date(e.target.value).toISOString() : undefined } })}
                    />
                  </Field>
                </div>
                <div className="row">
                  <span className="field-label">Active on</span>
                  {DAYS.map((d, i) => {
                    const days = draft.schedule?.days ?? [];
                    return (
                      <label key={d} className="row small" style={{ gap: 3 }}>
                        <input
                          type="checkbox"
                          checked={days.includes(i)}
                          onChange={(e) => {
                            const next = e.target.checked ? [...days, i].sort() : days.filter((x) => x !== i);
                            set({ schedule: { ...draft.schedule, days: next.length ? next : undefined } });
                          }}
                        />
                        {d}
                      </label>
                    );
                  })}
                  <span className="small muted">(none = every day)</span>
                </div>
                <div className="row">
                  <span className="field-label">Hours</span>
                  <input type="time" value={draft.schedule?.startTime ?? ""} onChange={(e) => set({ schedule: { ...draft.schedule, startTime: e.target.value || undefined } })} aria-label="Start time" />
                  <span>to</span>
                  <input type="time" value={draft.schedule?.endTime ?? ""} onChange={(e) => set({ schedule: { ...draft.schedule, endTime: e.target.value || undefined } })} aria-label="End time" />
                </div>
                <Diagnostics items={[...errorsFor("safety"), ...errorsFor("limits"), ...errorsFor("schedule")]} />
              </div>
            </>
          )}
        </div>

        <div className="col sticky">
          <div className="card col">
            <h3>Summary</h3>
            <Summary draft={cleaned} />
            <div className="row">
              <span className={`pill pill-${valid ? "ok" : "error"}`}>{valid ? "Valid" : "Invalid"}</span>
              <span className="spacer" />
              {existing && <button onClick={async () => downloadJson(`${existing.id}.json`, await api("exportConfig", { ruleIds: [existing.id] }))}>Export</button>}
              {existing && <button onClick={async () => { const r = await api<Rule>("duplicateRule", { id: existing.id }); location.hash = `/builder/${r.id}`; }}>Duplicate</button>}
              <button className="primary" disabled={!valid} onClick={save}>{existing ? "Save changes" : "Create rule"}</button>
            </div>
            {saved && <span className="pill pill-ok">{saved}</span>}
            {saveError instanceof ApiClientError && saveError.code === "conflict" ? (
              <div className="error-box">This rule was changed elsewhere. Reload it before saving to avoid overwriting.</div>
            ) : (
              <ErrorBox error={saveError} />
            )}
            <Diagnostics items={diagnostics} />
          </div>
          <TestPanel draft={cleaned} tabs={tabs.data ?? []} tabId={testTab} setTabId={setTestTab} />
          <details className="card">
            <summary><strong>Generated JSON</strong></summary>
            <pre style={{ marginTop: 8 }}>{JSON.stringify(cleaned, null, 2)}</pre>
          </details>
        </div>
      </div>
    </>
  );
}

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function IntervalInput({ seconds, onChange, min }: { seconds: number; onChange: (s: number) => void; min: number }) {
  const unit = seconds % 3600 === 0 ? 3600 : seconds % 60 === 0 ? 60 : 1;
  return (
    <span className="row" style={{ gap: 4 }}>
      <span className="small">every</span>
      <input type="number" min={1} style={{ width: 80 }} value={seconds / unit} onChange={(e) => onChange(Math.round(Number(e.target.value) * unit))} aria-label="Interval value" />
      <select value={unit} onChange={(e) => onChange(Math.round((seconds / unit) * Number(e.target.value)))} aria-label="Interval unit">
        <option value={1}>seconds</option>
        <option value={60}>minutes</option>
        <option value={3600}>hours</option>
      </select>
      {seconds < min && <span className="small" style={{ color: "var(--error)" }}>min {min}s</span>}
    </span>
  );
}

function PatternList({ label, items, onChange }: { label: string; items: UrlPatternInput[]; onChange: (p: UrlPatternInput[]) => void }) {
  return (
    <div className="col" style={{ gap: 4 }}>
      <span className="field-label">{label}</span>
      {items.map((p, i) => {
        const str = patternToString(p);
        const problem = validatePattern(p);
        return (
          <div key={i} className="row">
            <input style={{ flex: 1 }} className="mono" value={str} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`${label} ${i + 1}`} />
            <span className="pill pill-muted">{detectPattern(p).type}</span>
            <button className="small danger" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove pattern">✕</button>
            {problem && <span className="small" style={{ color: "var(--error)", width: "100%" }}>{problem}</span>}
          </div>
        );
      })}
      <div>
        <button className="small" onClick={() => onChange([...items, ""])}>+ Pattern</button>{" "}
        <span className="small muted">Examples: <code>example.com</code>, <code>*.example.com</code>, <code>https://example.com/reports/*</code>, <code>^https://example\.com/orders/\d+$</code></span>
      </div>
    </div>
  );
}

function ActionList({ label, items, caps, allowRefresh, onChange }: { label: string; items: ActionConfig[]; caps: Capabilities["actions"]; allowRefresh: boolean; onChange: (a: ActionConfig[]) => void }) {
  const available = caps.filter((a) => allowRefresh || a.type !== "refresh");
  return (
    <div className="col" style={{ gap: 4 }}>
      <span className="field-label">{label}</span>
      {items.length === 0 && <span className="small muted">Do nothing</span>}
      {items.map((a, i) => {
        const cap = caps.find((x) => x.type === a.type);
        return (
          <div key={i} className="cond-leaf">
            <div className="row">
              <select value={a.type} onChange={(e) => onChange(items.map((x, j) => (j === i ? (defaultsFor(e.target.value, caps.find((c) => c.type === e.target.value)?.schema) as ActionConfig) : x)))} aria-label="Action type">
                {available.map((c) => <option key={c.type} value={c.type}>{c.title}</option>)}
                {!cap && <option value={a.type}>{a.type} (unknown)</option>}
              </select>
              <span className="small muted" style={{ flex: 1 }}>{cap?.description}</span>
              <button className="small danger" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove action">✕</button>
            </div>
            <SchemaForm schema={cap?.schema} value={a} onChange={(v) => onChange(items.map((x, j) => (j === i ? (v as ActionConfig) : x)))} />
          </div>
        );
      })}
      <div>
        <button className="small" onClick={() => onChange([...items, { type: available.find((c) => !items.some((x) => x.type === c.type))?.type ?? available[0].type }])}>+ Action</button>
      </div>
    </div>
  );
}

function TriToggle({ label, value, onChange }: { label: string; value: boolean | undefined; onChange: (v: boolean | undefined) => void }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}>
        <option value="">Default</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    </label>
  );
}

function OptNumber({ value, onChange }: { value: number | undefined; onChange: (v: number | undefined) => void }) {
  return <input type="number" min={0} style={{ width: 100 }} value={value ?? ""} placeholder="—" onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />;
}

function OptSelect({ value, options, onChange }: { value: string | undefined; options: string[]; onChange: (v: string | undefined) => void }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">Default</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Summary({ draft }: { draft: Draft }) {
  const t = draft.trigger as { type: string; seconds?: number; randomMaxSeconds?: number };
  const when =
    t.type === "interval"
      ? `Every ${t.seconds}s${t.randomMaxSeconds ? `–${t.randomMaxSeconds}s (random)` : ""}`
      : t.type === "navigation"
        ? "When a page finishes loading"
        : t.type === "urlChange"
          ? "When the URL changes"
          : t.type === "startup"
            ? "When the browser starts"
            : "Only when run manually";
  const names = (a?: ActionConfig[]) => (a?.length ? a.map((x) => x.type).join(", ") : "nothing");
  return (
    <div className="small col" style={{ gap: 4 }}>
      <div><strong>WHEN</strong> {when}</div>
      <div><strong>ON</strong> {draft.target.patterns.map(patternToString).join(", ") || "—"}{draft.target.exclusions?.length ? ` except ${draft.target.exclusions.map(patternToString).join(", ")}` : ""}</div>
      {draft.stopWhen && <div><strong>UNTIL</strong> {describeCondition(draft.stopWhen)}</div>}
      <div><strong>THEN</strong> {draft.stopWhen ? `${names(draft.actions?.onMatched)}; otherwise ${names(draft.actions?.onNotMatched)}` : names(draft.actions?.onNotMatched)}</div>
      {draft.limits?.maxRefreshes && <div className="muted">At most {draft.limits.maxRefreshes} refreshes</div>}
    </div>
  );
}

/* ---------------- testing ---------------- */

interface TestResult {
  valid: boolean;
  diagnostics: Diagnostic[];
  targetsTab?: boolean;
  hostAccess?: boolean;
  result?: EvaluationResult;
  trace?: EvaluationTrace | null;
  explanations?: string[];
}

function TestPanel({ draft, tabs, tabId, setTabId }: { draft: Draft; tabs: TabInfo[]; tabId: number | null; setTabId: (id: number) => void }) {
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (tabId === null) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api<TestResult>("testRule", { rule: draft, tabId }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const tab = tabs.find((t) => t.id === tabId);
  return (
    <div className="card col">
      <h3>Test rule</h3>
      <span className="small muted">Dry run: evaluates conditions on a tab without refreshing or running actions.</span>
      <div className="row">
        <select style={{ flex: 1, maxWidth: "100%" }} value={tabId ?? ""} onChange={(e) => setTabId(Number(e.target.value))} aria-label="Tab to test">
          {tabs.map((t) => <option key={t.id} value={t.id} disabled={t.restricted}>{t.title.slice(0, 60) || t.url}</option>)}
        </select>
        <button className="primary" disabled={tabId === null || busy} onClick={run}>{busy ? "Testing…" : "Test"}</button>
      </div>
      {tab && !tab.restricted && <GrantHint url={tab.url} />}
      <ErrorBox error={error} />
      {result && !result.valid && <Diagnostics items={result.diagnostics} />}
      {result?.valid && (
        <div className="col small">
          <div className="row">
            Result: <ResultPill r={result.result!} />
            {result.targetsTab === false && <span className="pill pill-warn">URL not targeted</span>}
          </div>
          {result.explanations?.map((e, i) => <div key={i} className="notice">{e}</div>)}
          {result.trace && <TraceView t={result.trace} />}
          {!result.trace && <span className="muted">No stop condition: the rule refreshes on every trigger.</span>}
        </div>
      )}
    </div>
  );
}

function GrantHint({ url }: { url: string }) {
  let origin: string | null = null;
  try {
    const u = new URL(url);
    if (u.protocol.startsWith("http")) origin = `${u.protocol}//${u.hostname}/*`;
  } catch {
    /* ignore */
  }
  const [has, setHas] = useState(true);
  useEffect(() => {
    if (origin) void chrome.permissions.contains({ origins: [origin] }).then(setHas);
  }, [origin]);
  if (has || !origin) return null;
  return (
    <div className="info small row">
      Page conditions need site access.
      <button className="small" onClick={() => void chrome.permissions.request({ origins: [origin!] }).then(setHas)}>Grant</button>
    </div>
  );
}

function ResultPill({ r }: { r: EvaluationResult }) {
  const tone = r.status === "matched" ? "ok" : r.status === "unknown" ? "warn" : "muted";
  return <span className={`pill pill-${tone}`} title={r.status === "unknown" ? r.reason : undefined}>{r.status.replace("_", " ")}</span>;
}

function TraceView({ t }: { t: EvaluationTrace }) {
  const r = t.result;
  const details = r.status !== "unknown" ? r.details : undefined;
  return (
    <ul className="trace">
      <li>
        <ResultPill r={r} /> <code>{t.type}</code>
        {r.status === "unknown" && <span className="muted"> — {r.reason}</span>}
        {details?.count !== undefined && <span className="muted"> — {details.count} element(s)</span>}
        {details?.element && (
          <span className="muted">
            {" "}
            &lt;{details.element.tag}
            {details.element.id ? `#${details.element.id}` : ""}
            {details.element.classes?.length ? `.${details.element.classes.join(".")}` : ""}&gt;
            {details.element.textPreview ? ` “${details.element.textPreview}”` : ""}
          </span>
        )}
        {details?.note && <span className="muted"> — {details.note}</span>}
        {t.children?.map((c, i) => <TraceView key={i} t={c} />)}
      </li>
    </ul>
  );
}

/* Selector tester (results shown inline under UNTIL). */
let selectorListener: ((r: unknown) => void) | null = null;
async function testSelector(tabId: number, selector: string) {
  try {
    const r = await api("testSelector", { tabId, selector });
    selectorListener?.({ selector, ...(r as object) });
  } catch (e) {
    selectorListener?.({ selector, ok: false, error: (e as Error).message });
  }
}

function SelectorResult() {
  const [r, setR] = useState<{ selector: string; ok: boolean; count?: number; error?: string; samples?: { tag: string; id?: string; classes?: string[]; textPreview?: string }[] } | null>(null);
  useEffect(() => {
    selectorListener = (x) => setR(x as typeof r);
    return () => {
      selectorListener = null;
    };
  }, []);
  if (!r) return null;
  return (
    <div className="info small">
      <code>{r.selector}</code>:{" "}
      {r.ok ? (
        <>
          {r.count} match(es)
          {r.samples?.map((s, i) => (
            <div key={i} className="muted">
              &lt;{s.tag}{s.id ? `#${s.id}` : ""}{s.classes?.length ? `.${s.classes.join(".")}` : ""}&gt; {s.textPreview ? `“${s.textPreview}”` : ""}
            </div>
          ))}
        </>
      ) : (
        <span style={{ color: "var(--error)" }}>{r.error}</span>
      )}
      <button className="link small" style={{ marginLeft: 8 }} onClick={() => setR(null)}>dismiss</button>
    </div>
  );
}
