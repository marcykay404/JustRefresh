import { highlight } from "@/content/highlight";
import { mergeActivity, mergeFrames } from "@/core/frames";
import { clickElement } from "@/content/page-actions";
import { RuleEngine, type AlarmPort, type BrowserPort, type EngineTimeouts, type PagePort } from "@/core/rule-engine";
import type { ConditionNode, EvaluationResult, TabInfo } from "@/core/types";
import type { ActivitySnapshot } from "@/shared/messaging-types";
import { MemoryKV } from "@/storage/kv";
import { AuditRepository, ConfigRepository, HistoryRepository, RuntimeRepository } from "@/storage/repositories";
import { evaluateDomCondition } from "@/conditions/dom-eval";
import { JSDOM } from "jsdom";

export class FakeClock {
  t = Date.UTC(2026, 0, 5, 12, 0, 0);
  now = () => this.t;
  random = () => 0.5;
  advance(ms: number) {
    this.t += ms;
  }
}

export class FakeBrowser implements BrowserPort {
  tabs = new Map<number, TabInfo>();
  reloads: number[] = [];
  notifications: { title: string; message: string; sound?: boolean }[] = [];
  onReload?: (tabId: number) => void;
  /** Tabs whose reload call never returns (the reload is still recorded). */
  stallReload = new Set<number>();

  addTab(id: number, url: string, extra: Partial<TabInfo> = {}) {
    this.tabs.set(id, {
      id,
      url,
      title: `Tab ${id}`,
      windowId: 1,
      index: id,
      active: false,
      discarded: false,
      status: "complete",
      restricted: false,
      ...extra,
    });
  }
  async getTab(id: number) {
    return this.tabs.get(id) ?? null;
  }
  async listTabs() {
    return [...this.tabs.values()];
  }
  async reload(id: number) {
    this.reloads.push(id);
    this.onReload?.(id);
    if (this.stallReload.has(id)) await never();
  }
  navigations: { tabId: number; url: string }[] = [];
  async navigate(tabId: number, url: string) {
    this.navigations.push({ tabId, url });
  }
  async notify(_id: string, title: string, message: string, opts?: { sound?: boolean }) {
    this.notifications.push({ title, message, ...(opts?.sound ? { sound: true } : {}) });
  }
  posts: { url: string; body: unknown }[] = [];
  /** Webhook addresses that can't be reached. */
  unreachable = new Set<string>();
  async post(url: string, body: string) {
    if (this.unreachable.has(url)) throw new Error("Failed to fetch");
    this.posts.push({ url, body: JSON.parse(body) });
  }
}

export class FakeAlarms implements AlarmPort {
  alarms = new Map<string, number>();
  async set(name: string, when: number) {
    this.alarms.set(name, when);
  }
  async clear(name: string) {
    this.alarms.delete(name);
  }
  async getAll() {
    return [...this.alarms.entries()].map(([name, scheduledTime]) => ({ name, scheduledTime }));
  }
}

export const quietActivity = (over: Partial<ActivitySnapshot> = {}): ActivitySnapshot => ({
  monitoringForMs: 10 * 60_000,
  sinceKeyMs: null,
  sinceInputMs: null,
  sincePointerMs: null,
  sinceScrollMs: null,
  composing: false,
  editing: false,
  dirty: "clean",
  readyState: "complete",
  ...over,
});

/** Page port backed by per-tab jsdom documents (or an "unavailable" flag). */
export class FakePage implements PagePort {
  docs = new Map<number, Document>();
  activityByTab = new Map<number, ActivitySnapshot | null>();
  unavailable = new Set<number>();
  /** Tabs whose content-script calls never answer (e.g. page paused in a debugger). */
  stalled = new Set<number>();
  evaluateCalls = 0;

  /** The tab's frames (granted sites), after its top document, as Chrome reports them. */
  frames = new Map<number, Document[]>();
  /** Activity in the tab's frames (merged with the top frame's, as chromePage does). */
  frameActivity = new Map<number, ActivitySnapshot[]>();

  setHtml(tabId: number, html: string) {
    this.docs.set(tabId, new JSDOM(html).window.document);
  }
  setFrames(tabId: number, ...html: string[]) {
    this.frames.set(
      tabId,
      html.map((h) => new JSDOM(h).window.document),
    );
  }
  async evaluate(tabId: number, leaves: ConditionNode[], includeText: boolean): Promise<EvaluationResult[]> {
    this.evaluateCalls++;
    if (this.stalled.has(tabId)) await never();
    if (this.unavailable.has(tabId)) throw new Error("Content script unavailable");
    const doc = this.docs.get(tabId);
    if (!doc) throw new Error("No document");
    const all = [doc, ...(this.frames.get(tabId) ?? [])];
    return mergeFrames(
      leaves,
      all.map((d) => leaves.map((l) => evaluateDomCondition(l, d, { includeText }))),
    );
  }
  clicks: { tabId: number; selector: string }[] = [];
  scrollSaves: number[] = [];
  async click(tabId: number, selector: string) {
    if (this.stalled.has(tabId)) await never();
    if (this.unavailable.has(tabId)) throw new Error("Content script unavailable");
    const doc = this.docs.get(tabId);
    if (!doc) throw new Error("No document");
    const result = clickElement(doc, selector);
    if (result.ok) this.clicks.push({ tabId, selector });
    return result;
  }
  highlights: { tabId: number; selector?: string; text?: string }[] = [];
  async highlight(tabId: number, target: { selector?: string; text?: string }) {
    if (this.unavailable.has(tabId)) throw new Error("Content script unavailable");
    const doc = this.docs.get(tabId);
    if (!doc) throw new Error("No document");
    const result = highlight(doc.defaultView!, target, { busy: false });
    if (result.ok) this.highlights.push({ tabId, ...target });
    return result;
  }
  async saveScroll(tabId: number) {
    this.scrollSaves.push(tabId);
  }
  async activity(tabId: number) {
    if (this.stalled.has(tabId)) await never();
    if (this.unavailable.has(tabId)) return { activity: null, reason: "Content script unavailable" };
    const top = this.activityByTab.has(tabId) ? this.activityByTab.get(tabId)! : quietActivity();
    const frames = this.frameActivity.get(tabId) ?? [];
    return { activity: top && frames.length ? mergeActivity([top, ...frames]) : top };
  }
}

const never = () => new Promise<never>(() => undefined);

export function createEnv(opts: { timeouts?: Partial<EngineTimeouts> } = {}) {
  const clock = new FakeClock();
  const browser = new FakeBrowser();
  const alarms = new FakeAlarms();
  const page = new FakePage();
  const local = new MemoryKV();
  const session = new MemoryKV();
  const config = new ConfigRepository(local);
  const runtime = new RuntimeRepository(session);
  const history = new HistoryRepository(local, config, clock.now);
  const audit = new AuditRepository(local, clock.now);
  const engine = new RuleEngine({ browser, alarms, page, clock, stores: { config, runtime, history }, timeouts: opts.timeouts });
  return {
    clock,
    browser,
    alarms,
    page,
    local,
    session,
    config,
    runtime,
    history,
    audit,
    engine,
    /** Fire every alarm that is due, like Chrome would. */
    async fireDue() {
      const due = [...alarms.alarms.entries()].filter(([, t]) => t <= clock.t).map(([n]) => n);
      for (const n of due) {
        alarms.alarms.delete(n);
        await engine.handleAlarm(n);
      }
      return due.length;
    },
    /** Simulate our reload finishing. */
    async completeNavigation(tabId: number) {
      await engine.onTabUpdated(tabId, { status: "loading" });
      await engine.onTabUpdated(tabId, { status: "complete" });
    },
  };
}
