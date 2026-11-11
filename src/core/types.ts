/**
 * Core domain types for Smart Auto Refresh.
 *
 * Three kinds of data are kept strictly separate:
 *  - Rule definitions & configuration (persisted in chrome.storage.local)
 *  - Runtime execution state (persisted in chrome.storage.session)
 *  - UI state (lives only inside UI components)
 */

export const RULE_SCHEMA_VERSION = 1 as const;
export const CONFIG_SCHEMA_VERSION = 1 as const;

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

export type EvaluationResult =
  | { status: "matched"; details?: MatchDetails }
  | { status: "not_matched"; details?: MatchDetails }
  | { status: "unknown"; reason: string; code?: UnknownCode };

export type EvaluationStatus = EvaluationResult["status"];

export type UnknownCode =
  | "missing_permission"
  | "page_not_ready"
  | "restricted_url"
  | "content_script_unavailable"
  | "timeout"
  | "invalid_selector"
  | "cross_origin"
  | "tab_unavailable"
  | "evaluation_error";

export interface MatchDetails {
  /** Number of elements matched by the selector (DOM conditions). */
  count?: number;
  /** Minimal structural description of the first matched element. */
  element?: ElementSummary;
  /** Free-form explanation for humans/agents. */
  note?: string;
}

export interface ElementSummary {
  tag: string;
  id?: string;
  classes?: string[];
  /** Truncated text preview. Only returned to user-facing callers. */
  textPreview?: string;
}

/** Evaluation trace node: mirrors the condition tree. */
export interface EvaluationTrace {
  type: string;
  result: EvaluationResult;
  children?: EvaluationTrace[];
}

/* ------------------------------------------------------------------ */
/* Conditions / triggers / actions (declarative data)                 */
/* ------------------------------------------------------------------ */

/** Any condition node. Concrete shapes are defined by registry handlers. */
export interface ConditionNode {
  type: string;
  [key: string]: unknown;
}

export interface TriggerConfig {
  type: string;
  [key: string]: unknown;
}

export interface ActionConfig {
  type: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* URL patterns                                                        */
/* ------------------------------------------------------------------ */

export type PatternType = "exact" | "domain" | "glob" | "regex";

/** Strings are auto-detected; objects state the type explicitly. */
export type UrlPatternInput = string | { type: PatternType; value: string };

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

export type UnknownPolicy = "pause" | "skip" | "refresh" | "stop";

export interface SafetyConfig {
  pauseWhileTyping: boolean;
  protectUnsavedChanges: boolean;
  inactivityGraceSeconds: number;
  pauseOnMouse: boolean;
  pauseOnScroll: boolean;
  /** Policy when a stop condition evaluates to `unknown`. */
  onUnknown: UnknownPolicy;
  /** Max consecutive unknown retries before staying paused. */
  maxUnknownRetries: number;
  /** Policy when activity detection is unavailable (no content script). */
  onActivityUnavailable: "pause" | "refresh";
}

export interface LimitsConfig {
  maxRefreshes?: number;
  maxDurationSeconds?: number;
  /** ISO-8601 timestamp; stop refreshing at/after this moment. */
  stopAt?: string;
}

export interface ActiveWindow {
  /** 0 = Sunday … 6 = Saturday. Empty/absent = every day. */
  days?: number[];
  /** "HH:MM" 24h local time. If end < start the window wraps midnight. */
  startTime?: string;
  endTime?: string;
}

export interface RuleTarget {
  type: "url";
  patterns: UrlPatternInput[];
  exclusions: UrlPatternInput[];
}

export interface RuleActions {
  onMatched: ActionConfig[];
  onNotMatched: ActionConfig[];
  onUnknown?: ActionConfig[];
}

export interface RuleOrigin {
  type: "user" | "agent" | "import";
  agentId?: string;
}

export interface Rule {
  schemaVersion: typeof RULE_SCHEMA_VERSION;
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  target: RuleTarget;
  trigger: TriggerConfig;
  stopWhen?: ConditionNode;
  actions: RuleActions;
  safety: SafetyConfig;
  limits: LimitsConfig;
  schedule?: ActiveWindow;
  /** Metadata maintained by the Rule Management API. */
  meta: RuleMeta;
}

export interface RuleMeta {
  createdAt: number;
  updatedAt: number;
  /** Monotonic revision for optimistic concurrency control. */
  revision: number;
  origin: RuleOrigin;
  /** Agent-created rules start as drafts awaiting user approval. */
  draft: boolean;
}

/** Shape accepted from UI / import / agents (meta & defaults optional). */
export type RuleInput = Partial<Omit<Rule, "meta" | "safety" | "target" | "actions" | "limits">> & {
  name: string;
  target: Partial<RuleTarget> & { patterns: UrlPatternInput[] };
  trigger: TriggerConfig;
  safety?: Partial<SafetyConfig> & { maxRefreshes?: number };
  actions?: Partial<RuleActions>;
  limits?: LimitsConfig;
};

export type RulePatch = Partial<RuleInput>;

/* ------------------------------------------------------------------ */
/* Exclusions & per-tab overrides                                      */
/* ------------------------------------------------------------------ */

export interface Exclusion {
  id: string;
  pattern: UrlPatternInput;
  reason?: string;
  createdAt: number;
}

export interface TabOverride {
  tabId: number;
  /** `custom`: tab-specific refresh. `excluded`: temporarily excluded. */
  mode: "custom" | "excluded";
  intervalSeconds?: number;
  /** User stopped auto refresh for this tab (custom mode). */
  stopped?: boolean;
  /** User paused this tab. */
  paused?: boolean;
  safety?: Partial<SafetyConfig>;
  limits?: LimitsConfig;
  /** Incremented on every change so running executions restart. */
  revision: number;
  /** Restoration hints (tab IDs are not stable across restarts). */
  restore: { url: string; windowIndex: number; tabIndex: number; title?: string };
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface Settings {
  enabled: boolean;
  paused: boolean;
  defaultIntervalSeconds: number;
  defaultSafety: SafetyConfig;
  historyLimit: number;
  historyRetentionDays: number;
  notificationsEnabled: boolean;
  /** Skip discarded (memory-saver) tabs instead of waking them. */
  skipDiscardedTabs: boolean;
  /** Redact query strings and fragments from URLs returned to agents. */
  redactUrlsForAgents: boolean;
  /** Allow the native-messaging MCP bridge to connect. */
  nativeBridgeEnabled: boolean;
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

export type AgentScope =
  | "tabs:read"
  | "rules:read"
  | "rules:write"
  | "rules:test"
  | "rules:activate"
  | "rules:delete"
  | "status:read";

export const ALL_AGENT_SCOPES: AgentScope[] = [
  "tabs:read",
  "rules:read",
  "rules:write",
  "rules:test",
  "rules:activate",
  "rules:delete",
  "status:read",
];

export interface AgentRecord {
  id: string;
  name: string;
  transport: "extension" | "native" | "internal";
  /** For transport=extension: the calling extension id. */
  extensionId?: string;
  scopes: AgentScope[];
  /** Trusted capability: activation/deletion apply without per-request approval. */
  trustedActivation: boolean;
  status: "pending" | "approved" | "revoked";
  createdAt: number;
  lastSeenAt?: number;
}

export interface ApprovalRequest {
  id: string;
  kind: "activate" | "delete";
  ruleId: string;
  ruleRevision: number;
  agentId: string;
  createdAt: number;
  status: "pending" | "approved" | "rejected" | "stale";
}

/* ------------------------------------------------------------------ */
/* Persisted configuration                                             */
/* ------------------------------------------------------------------ */

export interface Config {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  settings: Settings;
  rules: Record<string, Rule>;
  exclusions: Exclusion[];
  tabOverrides: Record<string, TabOverride>;
  agents: Record<string, AgentRecord>;
  approvals: ApprovalRequest[];
}

/* ------------------------------------------------------------------ */
/* Runtime state                                                       */
/* ------------------------------------------------------------------ */

export type ExecutionStatus =
  | "idle"
  | "scheduled"
  | "evaluating"
  | "refreshing"
  | "paused_activity"
  | "paused_unsaved"
  | "paused_global"
  | "paused_user"
  | "paused_unknown"
  | "excluded"
  | "completed"
  | "stopped"
  | "error";

export const STATUS_LABELS: Record<ExecutionStatus, string> = {
  idle: "Idle",
  scheduled: "Scheduled",
  evaluating: "Evaluating",
  refreshing: "Refreshing",
  paused_activity: "Paused: User Activity",
  paused_unsaved: "Paused: Unsaved Changes",
  paused_global: "Paused: Global",
  paused_user: "Paused",
  paused_unknown: "Paused: Unknown Condition",
  excluded: "Excluded",
  completed: "Completed",
  stopped: "Stopped",
  error: "Error",
};

export interface TabRuntime {
  tabId: number;
  /** Effective controller id: rule id or `tab:<tabId>`. */
  controllerId: string | null;
  /** Revision of the controller when the run started. */
  controllerRevision: number;
  status: ExecutionStatus;
  reason?: string;
  url: string;
  /** Incremented whenever controller/url changes; stale async results are dropped. */
  generation: number;
  startedAt: number;
  nextDueAt: number | null;
  lastAttemptAt: number | null;
  lastNavigationAt: number | null;
  refreshCount: number;
  navigationCount: number;
  unknownStreak: number;
  pendingReload: { startedAt: number; generation: number } | null;
  /** For paused_user: automatic resume time (null = until user resumes). */
  resumeAt: number | null;
  /** Explicit user override: ignore unsaved-change protection for the next reload. */
  ignoreUnsavedOnce?: boolean;
  lastEvaluation: { at: number; status: EvaluationStatus; reason?: string } | null;
  lastError: string | null;
}

/* ------------------------------------------------------------------ */
/* History & audit                                                     */
/* ------------------------------------------------------------------ */

export interface HistoryEntry {
  at: number;
  ruleId: string | null;
  tabId: number;
  url?: string;
  trigger: string;
  condition?: EvaluationStatus;
  action: string;
  outcome: "ok" | "skipped" | "error";
  reason?: string;
  actor: "system" | "user" | "agent";
  agentId?: string;
}

export interface AuditEntry {
  at: number;
  agentId: string;
  operation: string;
  ruleId?: string;
  outcome: "ok" | "denied" | "pending_approval" | "error";
  detail?: string;
}

/* ------------------------------------------------------------------ */
/* Actor                                                               */
/* ------------------------------------------------------------------ */

export type Actor =
  | { type: "user" }
  | { type: "system" }
  | { type: "agent"; agentId: string };

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

export interface TabInfo {
  id: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  active: boolean;
  discarded: boolean;
  status?: string;
  restricted: boolean;
}

export interface Diagnostic {
  path: string;
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];
  /** Normalized rule (defaults filled) when valid. */
  normalized?: Rule;
}
