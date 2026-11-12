/** Storage keys, in a module of their own so extension pages can watch them without the repositories. */
export const CONFIG_KEY = "config";
export const CONFIG_BACKUP_KEY = "config.backup";
export const HISTORY_KEY = "history";
export const AUDIT_KEY = "audit";
/** Events for agents about their own rules and requests (see api/agent-events.ts). */
export const AGENT_EVENTS_KEY = "agentEvents";
/** storage.session: one entry per tab, "rt:<tabId>". */
export const RUNTIME_PREFIX = "rt:";
/** storage.session: the desktop-app bridge's connection state, for the dashboard. */
export const BRIDGE_STATUS_KEY = "bridge.status";
