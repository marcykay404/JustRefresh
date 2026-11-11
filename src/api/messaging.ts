/** Internal messaging helpers for extension pages (popup, dashboard). */
import type { ApiRequest, ApiResponse } from "../shared/messaging-types";
import { ApiError } from "./permissions";

export function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.tab) return false; // content scripts are never trusted callers
  const base = chrome.runtime.getURL("");
  return typeof sender.url === "string" && sender.url.startsWith(base);
}

export function isApiRequest(msg: unknown): msg is ApiRequest {
  return !!msg && typeof msg === "object" && (msg as ApiRequest).channel === "sar-api" && typeof (msg as ApiRequest).method === "string";
}

export function toErrorResponse(e: unknown): ApiResponse {
  if (e instanceof ApiError) return { ok: false, error: { code: e.code, message: e.message, diagnostics: e.diagnostics } };
  return { ok: false, error: { code: "internal", message: (e as Error)?.message ?? String(e) } };
}
