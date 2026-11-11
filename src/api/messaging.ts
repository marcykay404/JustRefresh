/** Internal messaging helpers for extension pages (popup, dashboard). */
import type { ApiRequest, ApiResponse } from "../shared/messaging-types";
import { ApiError } from "./permissions";

export function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  // Content scripts share our extension id but run on web-page URLs; only
  // documents served from the extension's own origin are trusted. (Extension
  // pages opened in a tab, like the dashboard, do carry `sender.tab`.)
  const base = chrome.runtime.getURL("");
  const origin = (sender as { origin?: string }).origin;
  if (origin !== undefined && `${origin}/` !== base) return false;
  return typeof sender.url === "string" && sender.url.startsWith(base);
}

export function isApiRequest(msg: unknown): msg is ApiRequest {
  return !!msg && typeof msg === "object" && (msg as ApiRequest).channel === "sar-api" && typeof (msg as ApiRequest).method === "string";
}

export function toErrorResponse(e: unknown): ApiResponse {
  if (e instanceof ApiError) return { ok: false, error: { code: e.code, message: e.message, diagnostics: e.diagnostics } };
  return { ok: false, error: { code: "internal", message: (e as Error)?.message ?? String(e) } };
}
