/** Thin client for the Rule Management API (extension pages only). */
import type { ApiResponse } from "../../shared/messaging-types";
import type { Diagnostic } from "../../core/types";

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly diagnostics?: Diagnostic[],
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, params?: unknown): Promise<T> {
  const res = (await chrome.runtime.sendMessage({ channel: "justrefresh-api", method, params })) as ApiResponse<T> | undefined;
  if (!res) throw new ApiClientError("internal", "No response from the extension");
  if (!res.ok) throw new ApiClientError(res.error.code, res.error.message, res.error.diagnostics as Diagnostic[] | undefined);
  return res.result;
}

/** Request site access. MUST be called synchronously from a click handler. */
export function requestOrigins(origins: string[]): Promise<boolean> {
  return chrome.permissions.request({ origins });
}

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return `${u.protocol}//${u.hostname}/*`;
    if (u.protocol === "file:") return "file:///*";
  } catch {
    /* ignore */
  }
  return null;
}
