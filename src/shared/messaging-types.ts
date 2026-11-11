/**
 * Typed message contracts between the service worker, content scripts and
 * extension pages. Every request carries a requestId; responses echo it so
 * late/stale responses can be discarded.
 */
import type { ConditionNode, EvaluationResult, ElementSummary } from "../core/types";

export const CONTENT_PROTOCOL = "justrefresh/1" as const;

export interface ActivitySnapshot {
  /** Milliseconds since the monitor started observing this document. */
  monitoringForMs: number;
  /** Milliseconds since the last keyboard input (null = none observed). */
  sinceKeyMs: number | null;
  /** Milliseconds since the last input/change event in an editable. */
  sinceInputMs: number | null;
  sincePointerMs: number | null;
  sinceScrollMs: number | null;
  /** IME composition in progress. */
  composing: boolean;
  /** Focus is in an editable element (input, textarea, contenteditable). */
  editing: boolean;
  /**
   * Conservative unsaved-change detection:
   *  - "dirty": a form control differs from its default value
   *  - "unknown": ambiguous (e.g. contenteditable was edited)
   *  - "clean": nothing detected (page-level app state may still be unsaved)
   */
  dirty: "clean" | "dirty" | "unknown";
  readyState: DocumentReadyState;
  /** The page is the result of submitting a form with POST: reloading it would send the form again. */
  formResult?: boolean;
}

export type ContentRequest =
  | { protocol: typeof CONTENT_PROTOCOL; requestId: string; kind: "ping" }
  | { protocol: typeof CONTENT_PROTOCOL; requestId: string; kind: "activity" }
  | {
      protocol: typeof CONTENT_PROTOCOL;
      requestId: string;
      kind: "evaluate";
      conditions: ConditionNode[];
      includeText: boolean;
    }
  | { protocol: typeof CONTENT_PROTOCOL; requestId: string; kind: "testSelector"; selector: string; includeText: boolean };

export type ContentResponse =
  | { requestId: string; kind: "pong"; readyState: DocumentReadyState }
  | { requestId: string; kind: "activity"; activity: ActivitySnapshot }
  | { requestId: string; kind: "evaluate"; results: EvaluationResult[] }
  | {
      requestId: string;
      kind: "testSelector";
      result: { ok: true; count: number; samples: ElementSummary[] } | { ok: false; error: string };
    }
  | { requestId: string; kind: "error"; error: string };

/** Requests from extension pages (popup/dashboard) to the service worker. */
export interface ApiRequest {
  channel: "justrefresh-api";
  method: string;
  params?: unknown;
}

export type ApiResponse<T = unknown> = { ok: true; result: T } | { ok: false; error: { code: string; message: string; diagnostics?: unknown[] } };

/* Service worker → offscreen document (alert sound). */
export const OFFSCREEN_CHANNEL = "jr-offscreen" as const;
export interface OffscreenMessage {
  channel: typeof OFFSCREEN_CHANNEL;
  kind: "play";
}
