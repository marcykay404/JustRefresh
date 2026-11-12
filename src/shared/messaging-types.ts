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

/**
 * Where each frame's content script puts its FrameApi, on its isolated-world
 * global (the page can't see it). The extension calls it in every frame at
 * once with scripting.executeScript({ allFrames: true, func }).
 */
export const FRAME_API = "__justRefreshFrame__";

export interface FrameApi {
  /** The extension version that set it up (a copy left by an older version is ignored). */
  version: string;
  activity(): ActivitySnapshot;
  evaluate(conditions: ConditionNode[], includeText: boolean): EvaluationResult[];
  testSelector(selector: string, includeText: boolean): { ok: true; count: number; samples: ElementSummary[] } | { ok: false; error: string };
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
  | { protocol: typeof CONTENT_PROTOCOL; requestId: string; kind: "testSelector"; selector: string; includeText: boolean }
  /** Click the first element matching the selector (never one that submits a form). */
  | { protocol: typeof CONTENT_PROTOCOL; requestId: string; kind: "click"; selector: string }
  /** Highlight an element or a text on the page, and scroll to it unless the page is in use. */
  | { protocol: typeof CONTENT_PROTOCOL; requestId: string; kind: "highlight"; selector?: string; text?: string }
  /** Remember the scroll position for the refresh that follows. */
  | { protocol: typeof CONTENT_PROTOCOL; requestId: string; kind: "saveScroll" }
  /** Start / stop the element picker; the choice is sent as a PickMessage. */
  | { protocol: typeof CONTENT_PROTOCOL; requestId: string; kind: "pick"; session: string }
  | { protocol: typeof CONTENT_PROTOCOL; requestId: string; kind: "cancelPick" };

export type ContentResponse =
  | { requestId: string; kind: "pong"; readyState: DocumentReadyState }
  | { requestId: string; kind: "activity"; activity: ActivitySnapshot }
  | { requestId: string; kind: "evaluate"; results: EvaluationResult[] }
  | {
      requestId: string;
      kind: "testSelector";
      result: { ok: true; count: number; samples: ElementSummary[] } | { ok: false; error: string };
    }
  | { requestId: string; kind: "click"; result: { ok: true } | { ok: false; error: string } }
  | { requestId: string; kind: "highlight"; result: { ok: true; scrolled: boolean } | { ok: false; error: string } }
  | { requestId: string; kind: "done" }
  | { requestId: string; kind: "error"; error: string };

/** Content script → the extension page that started the picker: the picked selector (null = cancelled or replaced). */
export const PICK_CHANNEL = "justrefresh-pick" as const;
export interface PickMessage {
  channel: typeof PICK_CHANNEL;
  /** Which Pick button asked (each start has its own). */
  session: string;
  selector: string | null;
  count?: number;
  positional?: boolean;
  /** Another Pick started in this tab and took over. */
  replaced?: boolean;
}

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
