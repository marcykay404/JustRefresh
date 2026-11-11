import type { Diagnostic } from "../core/types";

export function diag(path: string, code: string, message: string, severity: "error" | "warning" = "error"): Diagnostic {
  return { path, code, message, severity };
}

export const MAX_SELECTOR_LENGTH = 500;

/**
 * Selector syntax check. Uses the DOM when available (UI pages, content
 * scripts); the service worker has no DOM, so it falls back to basic checks
 * and the content script reports invalid selectors as `unknown` at runtime.
 */
export function checkSelector(selector: string, path: string): Diagnostic[] {
  if (!selector.trim()) return [diag(path, "selector_empty", "Selector must not be empty")];
  if (selector.length > MAX_SELECTOR_LENGTH) return [diag(path, "selector_too_long", "Selector is too long")];
  const doc = (globalThis as { document?: Document }).document;
  if (doc && typeof doc.createDocumentFragment === "function") {
    try {
      doc.createDocumentFragment().querySelector(selector);
    } catch {
      return [diag(path, "selector_invalid", `"${selector}" is not a valid CSS selector`)];
    }
  }
  return [];
}
