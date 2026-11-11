/**
 * Global reload spacing. When many alarms fire together (browser resume,
 * wake from sleep) reloads are serialized with a minimum gap instead of
 * hitting every tab at once.
 */
export function createThrottle(spacingMs: number, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
  let nextSlot = 0;
  return async () => {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + spacingMs;
    if (slot > now) await sleep(slot - now);
  };
}
