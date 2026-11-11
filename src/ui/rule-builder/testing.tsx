/** Testing a rule from the builder: dry run on a tab, condition trace, selector tester. */
import { useEffect, useState } from "react";
import { api } from "../shared/api";
import { Diagnostics, ErrorBox } from "../shared/components";
import type { Diagnostic, EvaluationResult, EvaluationTrace, TabInfo } from "../../core/types";
import type { Draft } from "./draft";

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

export function TestPanel({ draft, tabs, tabId, setTabId }: { draft: Draft; tabs: TabInfo[]; tabId: number | null; setTabId: (id: number) => void }) {
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
          {tabs.map((t) => (
            <option key={t.id} value={t.id} disabled={t.restricted}>
              {t.title.slice(0, 60) || t.url}
            </option>
          ))}
        </select>
        <button className="primary" disabled={tabId === null || busy} onClick={run}>
          {busy ? "Testing…" : "Test"}
        </button>
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
          {result.explanations?.map((e, i) => (
            <div key={i} className="notice">
              {e}
            </div>
          ))}
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
      <button className="small" onClick={() => void chrome.permissions.request({ origins: [origin!] }).then(setHas)}>
        Grant
      </button>
    </div>
  );
}

function ResultPill({ r }: { r: EvaluationResult }) {
  const tone = r.status === "matched" ? "ok" : r.status === "unknown" ? "warn" : "muted";
  return (
    <span className={`pill pill-${tone}`} title={r.status === "unknown" ? r.reason : undefined}>
      {r.status.replace("_", " ")}
    </span>
  );
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
        {t.children?.map((c, i) => (
          <TraceView key={i} t={c} />
        ))}
      </li>
    </ul>
  );
}

/* Selector tester (results shown inline under UNTIL). */
let selectorListener: ((r: unknown) => void) | null = null;
export async function testSelector(tabId: number, selector: string) {
  try {
    const r = await api("testSelector", { tabId, selector });
    selectorListener?.({ selector, ...(r as object) });
  } catch (e) {
    selectorListener?.({ selector, ok: false, error: (e as Error).message });
  }
}

export function SelectorResult() {
  const [r, setR] = useState<{
    selector: string;
    ok: boolean;
    count?: number;
    error?: string;
    samples?: { tag: string; id?: string; classes?: string[]; textPreview?: string }[];
  } | null>(null);
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
              &lt;{s.tag}
              {s.id ? `#${s.id}` : ""}
              {s.classes?.length ? `.${s.classes.join(".")}` : ""}&gt; {s.textPreview ? `“${s.textPreview}”` : ""}
            </div>
          ))}
        </>
      ) : (
        <span style={{ color: "var(--error)" }}>{r.error}</span>
      )}
      <button className="link small" style={{ marginLeft: 8 }} onClick={() => setR(null)}>
        dismiss
      </button>
    </div>
  );
}
