/**
 * Bounded waiting for browser calls that can stall indefinitely (e.g.
 * `chrome.scripting.executeScript` into a page paused in a debugger, or a tab
 * controlled by another extension through `chrome.debugger`). The underlying
 * call cannot be cancelled; we only stop waiting for it.
 */
export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not respond within ${ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`}`);
    this.name = "TimeoutError";
  }
}

/** Resolve/reject with `p`, or reject with TimeoutError after `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
