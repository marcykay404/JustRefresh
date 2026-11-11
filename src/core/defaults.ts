import type { Config, SafetyConfig, Settings } from "./types";
import { CONFIG_SCHEMA_VERSION } from "./types";

export const DEFAULT_SAFETY: SafetyConfig = {
  pauseWhileTyping: true,
  protectUnsavedChanges: true,
  inactivityGraceSeconds: 60,
  pauseOnMouse: false,
  pauseOnScroll: false,
  onUnknown: "pause",
  maxUnknownRetries: 3,
  onActivityUnavailable: "pause",
};

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  paused: false,
  defaultIntervalSeconds: 300,
  defaultSafety: DEFAULT_SAFETY,
  historyLimit: 500,
  historyRetentionDays: 7,
  notificationsEnabled: true,
  skipDiscardedTabs: true,
  redactUrlsForAgents: true,
  nativeBridgeEnabled: false,
};

export const INTERVAL_PRESETS: { label: string; seconds: number }[] = [
  { label: "30 seconds", seconds: 30 },
  { label: "1 minute", seconds: 60 },
  { label: "2 minutes", seconds: 120 },
  { label: "5 minutes", seconds: 300 },
  { label: "10 minutes", seconds: 600 },
  { label: "15 minutes", seconds: 900 },
  { label: "30 minutes", seconds: 1800 },
  { label: "1 hour", seconds: 3600 },
];

export function defaultConfig(): Config {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    settings: structuredClone(DEFAULT_SETTINGS),
    rules: {},
    exclusions: [],
    tabOverrides: {},
    agents: {},
    approvals: [],
  };
}
