/**
 * Events back to agents (#27 phase 3): what happened to an agent's own rules
 * and approval requests, so it doesn't have to keep asking.
 *
 *  - Kept here, in the extension, not in the bridge: an agent's session is
 *    short, and the next one asks "what happened since event N?". The
 *    extension also checks the agent's key on every read; the bridge only
 *    knows the name an agent claims.
 *  - Only for the agent that created the rule (or asked for the approval), and
 *    only while it is approved with the status:read permission.
 *  - No page text: reasons are JustRefresh's own words, as in History, and
 *    page addresses are hidden as the user's settings say when handed out.
 */
import type { AgentEvent, AgentEventKind, ApprovalRequest, Config, ExecutionStatus, Rule } from "../core/types";
import type { AgentEventRepository, AgentEventState } from "../storage/repositories";
import { redactUrl } from "./permissions";

/** The same error on the same tab is reported again only after this long. */
export const ERROR_REPEAT_MS = 10 * 60_000;
/** Calls one agent may have waiting at once; another lets the oldest return early. */
export const MAX_WAITS_PER_AGENT = 2;

export type RuleEventKind = Extract<AgentEventKind, `rule.${string}`>;

export interface RuleEventInput {
  kind: RuleEventKind;
  rule: Rule;
  tabId: number;
  url: string;
  status?: ExecutionStatus;
  reason?: string;
  streak?: number;
}

export interface EventFilter {
  since?: number;
  ruleId?: string;
  kinds?: AgentEventKind[];
}

export interface EventPage {
  events: AgentEvent[];
  /** Pass back as `since` to get only what comes after. */
  cursor: number;
  /** Some events after `since` were trimmed away (more than 100, or older than a week), or `since` is from before a reset. */
  truncated: boolean;
  /** A waiting call that returned early because the same agent started another one past the limit. */
  interrupted?: true;
}

/** Any address in free text (a scheme with //, or one of the schemes without, then up to the next space). */
const ADDRESS = /\b(?:[a-z][\w+.-]*:\/\/|(?:data|about|blob|javascript|mailto):)\S+/gi;
/** Punctuation that usually ends the sentence, not the address. */
const TRAILING = /[)\]>.,;:'"]+$/;

/** Addresses in a text, with their query strings and #fragments hidden. */
export function redactText(text: string): string {
  return text.replace(ADDRESS, (found) => {
    const tail = TRAILING.exec(found)?.[0] ?? "";
    const url = found.slice(0, found.length - tail.length);
    const cut = url.search(/[?#]/);
    return (cut < 0 ? url : `${url.slice(0, cut)}${url[cut] === "?" ? "?" : "#"}…`) + tail;
  });
}

/** An event as an agent sees it: page addresses hidden as the settings say, in its reason too (some Chrome errors quote them). */
export function publicEvent(e: AgentEvent, redact: boolean): Omit<AgentEvent, "agentId"> {
  const { agentId: _agent, ...rest } = e;
  return {
    ...rest,
    ...(rest.url !== undefined ? { url: redactUrl(rest.url, redact) } : {}),
    ...(rest.reason !== undefined && redact ? { reason: redactText(rest.reason) } : {}),
  };
}

/** null agentId = the user: everyone's events. */
const matches = (e: AgentEvent, agentId: string | null, f: EventFilter) =>
  (agentId === null || e.agentId === agentId) &&
  (f.since === undefined || e.seq > f.since) &&
  (f.ruleId === undefined || e.ruleId === f.ruleId) &&
  (f.kinds === undefined || f.kinds.includes(e.kind));

const eligible = (config: Config, agentId: string) => {
  const a = config.agents[agentId];
  return !!a && a.status === "approved" && a.scopes.includes("status:read");
};

const APPROVAL_EVENT: Partial<Record<ApprovalRequest["status"], AgentEventKind>> = {
  approved: "approval.approved",
  rejected: "approval.rejected",
  stale: "approval.stale",
};

type NewEvent = Omit<AgentEvent, "seq">;

export class AgentEvents {
  private readonly listeners = new Set<(added: AgentEvent[]) => void>();
  /** Per agent, a way to let each waiting call return now (oldest first). */
  private readonly waiting = new Map<string, (() => void)[]>();

  constructor(
    private readonly deps: {
      store: AgentEventRepository;
      config: { get(): Promise<Config> };
      now: () => number;
    },
  ) {}

  /** Called with every batch of new events (the bridge writes them to the agent's file). */
  onEvents(fn: (added: AgentEvent[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Something happened in a tab run by an agent's rule. */
  async rule(input: RuleEventInput): Promise<void> {
    const { type, agentId } = input.rule.meta.origin;
    if (type !== "agent" || !agentId) return;
    const now = this.deps.now();
    const event: NewEvent = {
      at: now,
      kind: input.kind,
      agentId,
      ruleId: input.rule.id,
      tabId: input.tabId,
      url: input.url,
      ...(input.status ? { status: input.status } : {}),
      ...(input.reason ? { reason: input.reason.slice(0, 300) } : {}),
      ...(input.streak !== undefined ? { streak: input.streak } : {}),
    };
    await this.add((s) => (event.kind === "rule.error" && repeatedError(s, event, now) ? [] : [event]));
  }

  /**
   * Approval requests that stopped waiting between two versions of the
   * config: settled, or dropped from the (bounded) list while still waiting.
   * A request the "before" doesn't have was made by a call running at the
   * same time; if it's already settled, this is the only call that sees it.
   */
  async approvals(before: Config, after: Config): Promise<void> {
    const was = new Map(before.approvals.map((a) => [a.id, a.status]));
    const now = this.deps.now();
    const event = (a: ApprovalRequest, kind: AgentEventKind): NewEvent => ({
      at: now,
      kind,
      agentId: a.agentId,
      ruleId: a.ruleId,
      approvalId: a.id,
      approvalKind: a.kind,
    });
    const settled = after.approvals.filter((a) => a.status !== "pending" && (was.get(a.id) ?? "pending") === "pending");
    const kept = new Set(after.approvals.map((a) => a.id));
    const dropped = before.approvals.filter((a) => a.status === "pending" && !kept.has(a.id));
    const fresh = [...settled.map((a) => event(a, APPROVAL_EVENT[a.status]!)), ...dropped.map((a) => event(a, "approval.stale"))];
    if (!fresh.length) return;
    // Two calls can see the same change (each compares with the config it started from).
    await this.add((s) => fresh.filter((e) => !s.events.some((o) => o.approvalId === e.approvalId && o.kind === e.kind)));
  }

  forget(agentId: string): Promise<void> {
    return this.deps.store.forget(agentId);
  }

  async list(agentId: string | null, f: EventFilter): Promise<EventPage> {
    const s = await this.deps.store.read();
    // A cursor from before the events were reset (extension reinstalled, data cleared): start over.
    const reset = f.since !== undefined && f.since > s.seq;
    const filter = reset ? { ...f, since: undefined } : f;
    const events = s.events.filter((e) => matches(e, agentId, filter));
    const dropped = agentId === null ? Math.max(0, ...Object.values(s.dropped)) : (s.dropped[agentId] ?? 0);
    return {
      events,
      // Nothing yet: from now on (a first call without since waits for what comes next).
      cursor: events.length ? events[events.length - 1].seq : reset ? s.seq : (f.since ?? s.seq),
      truncated: reset || (f.since !== undefined && f.since < dropped),
    };
  }

  /**
   * The events after `since`, or, if there are none yet, the first ones to
   * come within `ms`. Listens before it looks, so nothing slips in between.
   * Waiting calls nobody reads any more (the client gave up and asked again)
   * would hold their places: a call past MAX_WAITS_PER_AGENT lets the oldest
   * return now, with what it has.
   */
  async wait(agentId: string | null, f: EventFilter, ms: number): Promise<EventPage> {
    if (ms <= 0) return this.list(agentId, f);
    const key = agentId ?? "";
    const queue = this.waiting.get(key) ?? [];
    this.waiting.set(key, queue);
    while (queue.length >= MAX_WAITS_PER_AGENT) queue.shift()!();
    let woken!: () => void;
    let interrupted = false;
    const arrived = new Promise<void>((resolve) => (woken = resolve));
    const interrupt = () => {
      interrupted = true;
      woken();
    };
    queue.push(interrupt);
    const off = this.onEvents((added) => added.some((e) => matches(e, agentId, { ...f, since: undefined })) && woken());
    const timer = setTimeout(woken, ms);
    try {
      const first = await this.list(agentId, f);
      if (first.events.length) return first;
      await arrived;
      const next = await this.list(agentId, { ...f, since: first.cursor });
      // A reset seen before the wait still applies to what came after it.
      return { ...next, truncated: next.truncated || first.truncated, ...(interrupted && !next.events.length ? { interrupted: true as const } : {}) };
    } finally {
      off();
      clearTimeout(timer);
      const i = queue.indexOf(interrupt);
      if (i >= 0) queue.splice(i, 1);
    }
  }

  /**
   * Store new events for agents that may still have them: checked inside the
   * store's write, so an agent removed meanwhile (its events just deleted)
   * gets none back.
   */
  private async add(pick: (s: AgentEventState) => NewEvent[]) {
    const added = await this.deps.store.append(async (s) => {
      const config = await this.deps.config.get();
      return pick(s).filter((e) => eligible(config, e.agentId));
    });
    if (!added.length) return;
    for (const l of this.listeners) {
      try {
        l(added);
      } catch (e) {
        console.warn("JustRefresh: event listener failed", e);
      }
    }
  }
}

/** The same error, on the same tab, reported a short while ago. */
function repeatedError(s: AgentEventState, e: Omit<AgentEvent, "seq">, now: number): boolean {
  return s.events.some((o) => o.kind === "rule.error" && o.ruleId === e.ruleId && o.tabId === e.tabId && o.reason === e.reason && now - o.at < ERROR_REPEAT_MS);
}
