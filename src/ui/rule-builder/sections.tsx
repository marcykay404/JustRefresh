/** The builder's sections, one card each: WHEN → ON → UNTIL → THEN, plus name and limits. */
import { Diagnostics, Field, Toggle } from "../shared/components";
import { patternToString } from "../../core/url-pattern";
import type { ActionConfig, ConditionNode, Diagnostic } from "../../core/types";
import { ConditionEditor, describeCondition } from "./ConditionEditor";
import { ActionList, IntervalInput, OptNumber, OptSelect, PatternList, TriToggle } from "./controls";
import { DAYS, toLocalInput, type Capabilities, type Draft } from "./draft";
import { defaultsFor } from "./SchemaForm";
import { SelectorResult, testSelector } from "./testing";

export interface SectionProps {
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  caps: Capabilities;
  diagnostics: Diagnostic[];
  /** Diagnostics for one part of the rule ("trigger", "actions", …). */
  errorsFor: (prefix: string) => Diagnostic[];
  advanced: boolean;
  testTab: number | null;
}

/** Name, priority, on/off and description. */
export function NameCard(p: SectionProps) {
  const { draft, set, diagnostics } = p;
  return (
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
  );
}

/** WHEN: the trigger (an interval, page loads, startup, manual). */
export function WhenCard(p: SectionProps) {
  const { draft, set, caps: c, errorsFor } = p;
  const trigger = draft.trigger as { type: string; seconds?: number; randomMaxSeconds?: number };
  const actions = draft.actions ?? {};
  const triggerCap = c.triggers.find((t) => t.type === trigger.type);
  return (
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
              actions: {
                ...actions,
                onNotMatched: ok
                  ? actions.onNotMatched?.length
                    ? actions.onNotMatched
                    : [{ type: "refresh" }]
                  : (actions.onNotMatched ?? []).filter((a) => a.type !== "refresh"),
              },
            });
          }}
        >
          {c.triggers.map((t) => (
            <option key={t.type} value={t.type}>
              {t.title}
            </option>
          ))}
        </select>
        {trigger.type === "interval" && (
          <IntervalInput
            seconds={trigger.seconds ?? 60}
            onChange={(s) => set({ trigger: { ...trigger, seconds: s } as Draft["trigger"] })}
            min={c.limits.minIntervalSeconds}
          />
        )}
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
              <IntervalInput
                seconds={trigger.randomMaxSeconds}
                onChange={(s) => set({ trigger: { ...trigger, randomMaxSeconds: s } as Draft["trigger"] })}
                min={c.limits.minIntervalSeconds}
              />
            </>
          )}
        </div>
      )}
      <span className="small muted">{triggerCap?.description}</span>
      <Diagnostics items={errorsFor("trigger")} />
    </div>
  );
}

/** ON: the pages it runs on, and exceptions. */
export function OnCard(p: SectionProps) {
  const { draft, set, errorsFor } = p;
  return (
    <div className="card col">
      <div className="section-title">ON</div>
      <PatternList label="Pages matching" items={draft.target.patterns} onChange={(p) => set({ target: { ...draft.target, patterns: p } })} />
      <PatternList label="Except pages matching" items={draft.target.exclusions ?? []} onChange={(p) => set({ target: { ...draft.target, exclusions: p } })} />
      <Diagnostics items={errorsFor("target")} />
    </div>
  );
}

/** UNTIL: the stop condition. */
export function UntilCard(p: SectionProps) {
  const { draft, set, caps: c, errorsFor, advanced, testTab } = p;
  const setStopWhen = (n: ConditionNode | null) => set({ stopWhen: n ?? undefined });
  const firstLeaf = c.conditions.find((x) => !["all", "any", "not"].includes(x.type))!;
  return (
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
            pickTab={testTab}
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
  );
}

/** THEN: actions when the condition matches, otherwise, and when the page can't be checked. */
export function ThenCard(p: SectionProps) {
  const { draft, set, caps: c, errorsFor, advanced } = p;
  const actions = draft.actions ?? {};
  const t = (draft.trigger as { type: string }).type;
  const refreshAllowed = t === "interval" || t === "startup" || t === "manual";
  return (
    <div className="card col">
      <div className="section-title">THEN</div>
      {draft.stopWhen && (
        <ActionList
          label="When the condition matches"
          items={actions.onMatched ?? []}
          caps={c.actions}
          allowRefresh={refreshAllowed}
          pickTab={p.testTab}
          onChange={(a) => set({ actions: { ...actions, onMatched: a } })}
        />
      )}
      <ActionList
        label={draft.stopWhen ? "Otherwise" : "Each time it fires"}
        items={actions.onNotMatched ?? []}
        caps={c.actions}
        allowRefresh={refreshAllowed}
        pickTab={p.testTab}
        onChange={(a) => set({ actions: { ...actions, onNotMatched: a } })}
      />
      {advanced && draft.stopWhen && (
        <ActionList
          label="When the page can't be checked (runs before the setting below)"
          items={actions.onUnknown ?? []}
          caps={c.actions}
          allowRefresh={false}
          pickTab={p.testTab}
          onChange={(a) => set({ actions: { ...actions, onUnknown: a.length ? a : undefined } })}
        />
      )}
      <Diagnostics items={errorsFor("actions")} />
    </div>
  );
}

/** PROTECTION & LIMITS: activity protection, time and refresh limits, active days and hours. */
export function LimitsCard(p: SectionProps) {
  const { draft, set, errorsFor } = p;
  const safety = draft.safety ?? {};
  const limits = draft.limits ?? {};
  return (
    <div className="card col">
      <div className="section-title">PROTECTION & LIMITS</div>
      <span className="small muted">“Same as Settings” uses your defaults from Settings → Activity protection, filled in when the rule is saved.</span>
      <div className="row">
        <TriToggle label="Wait while I'm typing" value={safety.pauseWhileTyping} onChange={(v) => set({ safety: { ...safety, pauseWhileTyping: v } })} />
        <TriToggle
          label="Don't refresh over unsaved form changes"
          value={safety.protectUnsavedChanges}
          onChange={(v) => set({ safety: { ...safety, protectUnsavedChanges: v } })}
        />
        <TriToggle label="Wait while I move the mouse" value={safety.pauseOnMouse} onChange={(v) => set({ safety: { ...safety, pauseOnMouse: v } })} />
        <TriToggle label="Wait while I scroll" value={safety.pauseOnScroll} onChange={(v) => set({ safety: { ...safety, pauseOnScroll: v } })} />
      </div>
      <div className="row">
        <Field label="Quiet time before a postponed refresh (seconds)">
          <OptNumber
            placeholder="Same as Settings"
            value={safety.inactivityGraceSeconds}
            onChange={(v) => set({ safety: { ...safety, inactivityGraceSeconds: v } })}
          />
        </Field>
        <Field label="When the page can't be checked">
          <OptSelect
            value={safety.onUnknown}
            options={[
              ["pause", "Pause, retry, then notify me"],
              ["skip", "Skip this time and keep trying"],
              ["refresh", "Treat it as not found and keep refreshing"],
              ["stop", "Stop and notify me"],
            ]}
            onChange={(v) => set({ safety: { ...safety, onUnknown: v as never } })}
          />
        </Field>
        <Field label="Retries before giving up">
          <OptNumber placeholder="Same as Settings" value={safety.maxUnknownRetries} onChange={(v) => set({ safety: { ...safety, maxUnknownRetries: v } })} />
        </Field>
        <Field label="When JustRefresh can't see inside the page">
          <OptSelect
            value={safety.onActivityUnavailable}
            options={[
              ["pause", "Don't refresh (safe)"],
              ["refresh", "Refresh without protection"],
            ]}
            onChange={(v) => set({ safety: { ...safety, onActivityUnavailable: v as never } })}
          />
        </Field>
      </div>
      <div className="row">
        <Field label="Stop after this many refreshes" hint="Clicks by the rule count too">
          <OptNumber placeholder="No limit" value={limits.maxRefreshes} onChange={(v) => set({ limits: { ...limits, maxRefreshes: v } })} />
        </Field>
        <Field label="Stop after (minutes)">
          <OptNumber
            placeholder="No limit"
            value={limits.maxDurationSeconds !== undefined ? limits.maxDurationSeconds / 60 : undefined}
            onChange={(v) => set({ limits: { ...limits, maxDurationSeconds: v === undefined ? undefined : Math.round(v * 60) } })}
          />
        </Field>
        <Field label="Stop at this time">
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
        <input
          type="time"
          value={draft.schedule?.startTime ?? ""}
          onChange={(e) => set({ schedule: { ...draft.schedule, startTime: e.target.value || undefined } })}
          aria-label="Start time"
        />
        <span>to</span>
        <input
          type="time"
          value={draft.schedule?.endTime ?? ""}
          onChange={(e) => set({ schedule: { ...draft.schedule, endTime: e.target.value || undefined } })}
          aria-label="End time"
        />
      </div>
      <Diagnostics items={[...errorsFor("safety"), ...errorsFor("limits"), ...errorsFor("schedule")]} />
    </div>
  );
}

const WHEN: Record<string, string> = {
  navigation: "When a page finishes loading",
  urlChange: "When the URL changes",
  startup: "When the browser starts",
  manual: "Only when run manually",
};

function whenText(t: { type: string; seconds?: number; randomMaxSeconds?: number }): string {
  if (t.type !== "interval") return Object.hasOwn(WHEN, t.type) ? WHEN[t.type]! : "Only when run manually";
  return `Every ${t.seconds}s${t.randomMaxSeconds ? `–${t.randomMaxSeconds}s (random)` : ""}`;
}

const actionNames = (a?: ActionConfig[]) => (a?.length ? a.map((x) => x.type).join(", ") : "nothing");

export function Summary({ draft }: { draft: Draft }) {
  const { patterns, exclusions } = draft.target;
  const except = exclusions?.length ? ` except ${exclusions.map(patternToString).join(", ")}` : "";
  const then = draft.stopWhen
    ? `${actionNames(draft.actions?.onMatched)}; otherwise ${actionNames(draft.actions?.onNotMatched)}`
    : actionNames(draft.actions?.onNotMatched);
  return (
    <div className="small col" style={{ gap: 4 }}>
      <div>
        <strong>WHEN</strong> {whenText(draft.trigger as { type: string; seconds?: number; randomMaxSeconds?: number })}
      </div>
      <div>
        <strong>ON</strong> {patterns.map(patternToString).join(", ") || "—"}
        {except}
      </div>
      {draft.stopWhen && (
        <div>
          <strong>UNTIL</strong> {describeCondition(draft.stopWhen)}
        </div>
      )}
      <div>
        <strong>THEN</strong> {then}
      </div>
      {draft.limits?.maxRefreshes && <div className="muted">At most {draft.limits.maxRefreshes} refreshes</div>}
    </div>
  );
}
