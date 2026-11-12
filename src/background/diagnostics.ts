/**
 * What the service worker is busy with, for when an extension page waits too
 * long for an answer: the startup step it is on, the requests still waiting,
 * and recent slow work. Answered at once (it doesn't wait for startup), so
 * the popup can say why it is still loading instead of only "Loading…".
 */
import type { HealthReport } from "../shared/messaging-types";

/** Work slower than this is logged and kept in the report. */
export const SLOW_MS = 2000;
const KEEP_SLOW = 20;

const startedAt = Date.now();
let step = "starting";
let stepAt = startedAt;
let readyAt: number | null = null;
let seq = 0;
const waiting = new Map<number, { what: string; at: number }>();
const slow: { what: string; ms: number; at: number }[] = [];

function noteSlow(what: string, ms: number) {
  if (ms < SLOW_MS) return;
  console.warn(`JustRefresh: ${what} took ${ms} ms`);
  slow.push({ what, ms, at: Date.now() });
  if (slow.length > KEEP_SLOW) slow.shift();
}

/** Move startup on to its next step (the time the previous one took is noted when slow). */
export function startupStep(name: string) {
  const now = Date.now();
  noteSlow(`startup: ${step}`, now - stepAt);
  step = name;
  stepAt = now;
}

export function startupDone() {
  startupStep("done");
  readyAt = Date.now();
}

/** Run `fn`, listed as waiting meanwhile, and noted if slow. */
export async function timed<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const id = ++seq;
  const at = Date.now();
  waiting.set(id, { what, at });
  try {
    return await fn();
  } finally {
    waiting.delete(id);
    noteSlow(what, Date.now() - at);
  }
}

export function healthReport(): HealthReport {
  const now = Date.now();
  return {
    upForMs: now - startedAt,
    ready: readyAt !== null,
    startupStep: readyAt === null ? step : null,
    startupStepForMs: readyAt === null ? now - stepAt : null,
    startupTookMs: readyAt === null ? null : readyAt - startedAt,
    waiting: [...waiting.values()].map((w) => ({ what: w.what, forMs: now - w.at })),
    slow: slow.map((s) => ({ what: s.what, ms: s.ms, agoMs: now - s.at })),
  };
}
