/**
 * Visual rule builder: WHEN → ON → UNTIL → THEN.
 * A client of the Rule Management API like any agent: it validates, tests
 * (dry run) and saves through the same methods. The sections are in
 * sections.tsx, inputs in controls.tsx, testing in testing.tsx.
 */
import { useEffect, useMemo, useState } from "react";
import { api, ApiClientError } from "../shared/api";
import { useApi } from "../shared/hooks";
import { downloadJson } from "../shared/format";
import { Diagnostics, ErrorBox, Toggle } from "../shared/components";
import type { Diagnostic, Rule, TabInfo } from "../../core/types";
import { isSimpleTree } from "./ConditionEditor";
import { useDialog } from "../shared/dialog";
import { takeBuilderDraft } from "../dashboard/templates";
import { clean, draftFromJson, initialDraft, stripMeta, type Capabilities, type Draft } from "./draft";
import { LimitsCard, NameCard, OnCard, Summary, ThenCard, UntilCard, WhenCard, type SectionProps } from "./sections";
import { TestPanel } from "./testing";

export { PatternList } from "./controls";

/** `fromTemplate`: start from the rule a template filled in (Templates → Customise in the Rule Builder). */
export function RuleBuilder({ ruleId, initialUrl, fromTemplate }: { ruleId?: string; initialUrl?: string; fromTemplate?: boolean }) {
  const dialog = useDialog();
  const caps = useApi<Capabilities>("getCapabilities");
  const tabs = useApi<TabInfo[]>("listTabs");
  const [existing, setExisting] = useState<Rule | null>(null);
  const [draft, setDraft] = useState<Draft>(() => {
    const fromTpl = fromTemplate ? takeBuilderDraft() : null;
    return fromTpl ? { ...initialDraft(), ...fromTpl, safety: fromTpl.safety ?? {}, limits: fromTpl.limits ?? {} } : initialDraft(initialUrl);
  });
  const [advanced, setAdvanced] = useState(false);
  const [view, setView] = useState<"visual" | "json">("visual");
  const [jsonText, setJsonText] = useState("");
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
  }, [view]);

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

  const errorsFor = (prefix: string) => diagnostics.filter((d) => d.path === prefix || d.path.startsWith(`${prefix}.`) || d.path.startsWith(`${prefix}[`));
  const section: SectionProps = { draft, set, caps: caps.data, diagnostics, errorsFor, advanced, testTab };
  const toggleAdvanced = (v: boolean) => {
    if (v || isSimpleTree(draft.stopWhen)) return setAdvanced(v);
    void dialog.alert({
      title: "Can't switch to simple mode",
      message: "This rule uses nested condition groups, which simple mode can't show. Remove the nesting in advanced mode first.",
    });
  };
  const applyJson = (text: string) => {
    const next = draftFromJson(text);
    setDraft(next.draft);
    setAdvanced(advanced || next.needsAdvanced);
    setView("visual");
  };

  return (
    <>
      <div className="row">
        <h1>{existing ? `Edit rule: ${existing.name}` : "New rule"}</h1>
        <RuleBadges rule={existing} />
        <span className="spacer" />
        <Toggle checked={advanced} onChange={toggleAdvanced} label="Advanced mode" />
        <div className="row" role="tablist">
          <button className={view === "visual" ? "primary" : ""} onClick={() => setView("visual")}>Visual</button>
          <button className={view === "json" ? "primary" : ""} onClick={() => setView("json")}>JSON</button>
        </div>
      </div>

      <div className="builder">
        <div className="col">
          {view === "json" ? (
            <JsonEditor text={jsonText} onText={setJsonText} onApply={applyJson} />
          ) : (
            <>
              <NameCard {...section} />
              <WhenCard {...section} />
              <OnCard {...section} />
              <UntilCard {...section} />
              <ThenCard {...section} />
              <LimitsCard {...section} />
            </>
          )}
        </div>

        <div className="col sticky">
          <SaveCard draft={cleaned} existing={existing} valid={valid} saved={saved} saveError={saveError} diagnostics={diagnostics} onSave={save} />
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

function RuleBadges({ rule }: { rule: Rule | null }) {
  return (
    <>
      {rule?.meta.draft && <span className="pill pill-warn">Draft</span>}
      {rule?.meta.origin.type === "agent" && <span className="pill pill-done">Created by {rule.meta.origin.agentId}</span>}
    </>
  );
}

/** Edit the rule as JSON (the format agents generate), then apply it back to the visual editor. */
function JsonEditor({ text, onText, onApply }: { text: string; onText: (t: string) => void; onApply: (t: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const apply = () => {
    try {
      onApply(text);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="card col">
      <span className="muted small">Edit the rule as JSON (same format agents generate). Apply to sync back to the visual editor.</span>
      <textarea rows={30} value={text} onChange={(e) => onText(e.target.value)} spellCheck={false} aria-label="Rule JSON" />
      {error && <div className="error-box">{error}</div>}
      <div className="row">
        <button className="primary" onClick={apply}>Apply JSON</button>
      </div>
    </div>
  );
}

/** Summary, validity, and Save / Export / Duplicate. */
function SaveCard(p: { draft: Draft; existing: Rule | null; valid: boolean; saved: string | null; saveError: unknown; diagnostics: Diagnostic[]; onSave: () => void }) {
  const { existing } = p;
  const conflict = p.saveError instanceof ApiClientError && p.saveError.code === "conflict";
  return (
    <div className="card col">
      <h3>Summary</h3>
      <Summary draft={p.draft} />
      <div className="row">
        <span className={`pill pill-${p.valid ? "ok" : "error"}`}>{p.valid ? "Valid" : "Invalid"}</span>
        <span className="spacer" />
        {existing && <button onClick={async () => downloadJson(`${existing.id}.json`, await api("exportConfig", { ruleIds: [existing.id] }))}>Export</button>}
        {existing && <button onClick={async () => { const r = await api<Rule>("duplicateRule", { id: existing.id }); location.hash = `/builder/${r.id}`; }}>Duplicate</button>}
        <button className="primary" disabled={!p.valid} onClick={p.onSave}>{existing ? "Save changes" : "Create rule"}</button>
      </div>
      {p.saved && <span className="pill pill-ok">{p.saved}</span>}
      {conflict ? <div className="error-box">This rule was changed elsewhere. Reload it before saving to avoid overwriting.</div> : <ErrorBox error={p.saveError} />}
      <Diagnostics items={p.diagnostics} />
    </div>
  );
}
