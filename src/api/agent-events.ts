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
import { ApiError, redactUrl } from "./permissions";

/** The same error on the same tab is reported again only after this long. */
export const ERROR_REPEAT_MS = 10 * 60_000;
/** Calls one agent may have waiting at once. */
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
  /** Some events after `since` were trimmed away (more than 100, or older than a week). */
  truncated: boolean;
}

/** An event as an agent sees it. */
export function publicEvent(e: AgentEvent, redact: boolean): Omit<AgentEvent, "agentId"> {
  const { agentId: _agent, ...rest } = e;
  return rest.url === undefined ? rest : { ...rest, url: redactUrl(rest.url, redact) };
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

export class AgentEvents {
  private readonly listeners = new Set<(added: AgentEvent[]) => void>();
  private readonly waiting = new Map<string, number>();

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
    if (type !== "agent" || !agentId || !eligible(await this.deps.config.get(), agentId)) return;
    const now = this.deps.now();
    const event: Omit<AgentEvent, "seq"> = {
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

  /** Approval requests that stopped waiting between two versions of the config. */
  async approvals(before: Config, after: Config): Promise<void> {
    const was = new Map(before.approvals.map((a) => [a.id, a.status]));
    const settled = after.approvals.filter((a) => was.get(a.id) === "pending" && a.status !== "pending" && eligible(after, a.agentId));
    if (!settled.length) return;
    const now = this.deps.now();
    await this.add((s) =>
      settled.flatMap((a) => {
        const kind = APPROVAL_EVENT[a.status]!;
        // Two calls can see the same change (each compares with the config it started from).
        if (s.events.some((e) => e.approvalId === a.id && e.kind === kind)) return [];
        return [{ at: now, kind, agentId: a.agentId, ruleId: a.ruleId, approvalId: a.id, approvalKind: a.kind }];
      }),
    );
  }

  forget(agentId: string): Promise<void> {
    return this.deps.store.forget(agentId);
  }

  async list(agentId: string | null, f: EventFilter): Promise<EventPage> {
    const s = await this.deps.store.read();
    const events = s.events.filter((e) => matches(e, agentId, f));
    const dropped = agentId === null ? Math.max(0, ...Object.values(s.dropped)) : (s.dropped[agentId] ?? 0);
    return {
      events,
      // Nothing yet: from now on (a first call without since waits for what comes next).
      cursor: events.length ? events[events.length - 1].seq : (f.since ?? s.seq),
      truncated: f.since !== undefined && f.since < dropped,
    };
  }

  /**
   * The events after `since`, or, if there are none yet, the first ones to
   * come within `ms`. Listens before it looks, so nothing slips in between.
   */
  async wait(agentId: string | null, f: EventFilter, ms: number): Promise<EventPage> {
    if (ms <= 0) return this.list(agentId, f);
    const key = agentId ?? "";
    if ((this.waiting.get(key) ?? 0) >= MAX_WAITS_PER_AGENT) {
      throw new ApiError("conflict", `Already waiting for events ${MAX_WAITS_PER_AGENT} times; wait for those to return first`);
    }
    this.waiting.set(key, (this.waiting.get(key) ?? 0) + 1);
    let stop = () => undefined as void;
    try {
      let woken!: () => void;
      const arrived = new Promise<void>((resolve) => (woken = resolve));
      const off = this.onEvents((added) => added.some((e) => matches(e, agentId, { ...f, since: undefined })) && woken());
      const timer = setTimeout(woken, ms);
      stop = () => {
        off();
        clearTimeout(timer);
      };
      const first = await this.list(agentId, f);
      if (first.events.length) return first;
      await arrived;
      return await this.list(agentId, { ...f, since: first.cursor });
    } finally {
      stop();
      this.waiting.set(key, (this.waiting.get(key) ?? 1) - 1);
    }
  }

  private async add(pick: (s: AgentEventState) => Omit<AgentEvent, "seq">[]) {
    const added = await this.deps.store.append(pick);
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
