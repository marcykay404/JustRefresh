/** The service worker's health report: what it's busy with while a page waits. */
import { healthReport, startupDone, startupStep, timed } from "@/background/diagnostics";

describe("health report", () => {
  it("says which startup step it's on, what is waiting, and what was slow", async () => {
    vi.useFakeTimers();
    try {
      startupStep("checking tab 3 of 40 (github.com)");
      vi.advanceTimersByTime(2500);
      let release!: () => void;
      const running = timed("request getTabState", () => new Promise<void>((r) => (release = r)));
      vi.advanceTimersByTime(4000);
      const during = healthReport();
      expect(during.ready).toBe(false);
      expect(during.startupStep).toBe("checking tab 3 of 40 (github.com)");
      expect(during.startupStepForMs).toBeGreaterThanOrEqual(6500);
      expect(during.waiting).toEqual([{ what: "request getTabState", forMs: 4000 }]);

      startupDone();
      release();
      await running;
      const after = healthReport();
      expect(after.ready).toBe(true);
      expect(after.waiting).toEqual([]);
      expect(after.slow.map((s) => s.what)).toEqual(["startup: checking tab 3 of 40 (github.com)", "request getTabState"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
