import { decideSafety } from "@/core/safety";
import { DEFAULT_SAFETY } from "@/core/defaults";
import { checkLimits, inActiveWindow, nextWindowStart, restoredDueAt } from "@/core/schedule";
import { canTransition, newRuntime, transition, IllegalTransitionError } from "@/core/state-machine";
import { intervalDelayMs } from "@/triggers/interval";
import { quietActivity } from "../helpers/fake-env";

describe("decideSafety", () => {
  const base = { safety: DEFAULT_SAFETY, fallbackRetryMs: 60_000 };
  it("allows a quiet page", () => expect(decideSafety({ ...base, activity: quietActivity() }).allowed).toBe(true));
  it("pauses during IME composition", () => {
    expect(decideSafety({ ...base, activity: quietActivity({ composing: true }) })).toMatchObject({ allowed: false, status: "paused_activity" });
  });
  it("waits out the remaining grace period", () => {
    expect(decideSafety({ ...base, activity: quietActivity({ sinceInputMs: 45_000 }) })).toMatchObject({ allowed: false, retryInMs: 15_000 });
  });
  it("treats ambiguous dirty state as unsafe", () => {
    expect(decideSafety({ ...base, activity: quietActivity({ dirty: "unknown" }) })).toMatchObject({ allowed: false, status: "paused_unsaved" });
    expect(decideSafety({ ...base, activity: quietActivity({ dirty: "dirty" }), ignoreUnsaved: true }).allowed).toBe(true);
  });
  it("is conservative when monitoring just started while editing", () => {
    expect(decideSafety({ ...base, activity: quietActivity({ monitoringForMs: 5_000, editing: true }) }).allowed).toBe(false);
  });
  it("applies the unavailable policy", () => {
    expect(decideSafety({ ...base, activity: null }).allowed).toBe(false);
    expect(decideSafety({ ...base, safety: { ...DEFAULT_SAFETY, onActivityUnavailable: "refresh" }, activity: null }).allowed).toBe(true);
  });
  it("optional mouse/scroll protection", () => {
    const s = { ...DEFAULT_SAFETY, pauseOnMouse: true, pauseOnScroll: true };
    expect(decideSafety({ ...base, safety: s, activity: quietActivity({ sincePointerMs: 1000 }) }).allowed).toBe(false);
    expect(decideSafety({ ...base, safety: s, activity: quietActivity({ sinceScrollMs: 1000 }) }).allowed).toBe(false);
    expect(decideSafety({ ...base, activity: quietActivity({ sincePointerMs: 1000 }) }).allowed).toBe(true);
  });
  it("disabled protection never blocks", () => {
    const s = { ...DEFAULT_SAFETY, pauseWhileTyping: false, protectUnsavedChanges: false };
    expect(decideSafety({ ...base, safety: s, activity: null }).allowed).toBe(true);
  });
});

describe("scheduling", () => {
  const at = (h: number, m: number, day = 1) => new Date(2026, 0, 4 + day, h, m).getTime(); // Jan 4 2026 is a Sunday
  it("active windows incl. days and midnight wrap", () => {
    const w = { days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "17:00" };
    expect(inActiveWindow(w, at(10, 0, 1))).toBe(true);
    expect(inActiveWindow(w, at(8, 59, 1))).toBe(false);
    expect(inActiveWindow(w, at(10, 0, 6))).toBe(false);
    const night = { days: [5], startTime: "22:00", endTime: "02:00" };
    expect(inActiveWindow(night, at(23, 0, 5))).toBe(true);
    expect(inActiveWindow(night, at(1, 0, 6))).toBe(true); // Saturday 1am belongs to Friday's window
    expect(inActiveWindow(night, at(1, 0, 5))).toBe(false);
    expect(nextWindowStart(w, at(18, 0, 5))).toBe(at(9, 0, 8));
  });
  it("limits", () => {
    expect(checkLimits({ maxRefreshes: 3 }, { refreshCount: 3, startedAt: 0 }, 1).reached).toBe(true);
    expect(checkLimits({ maxDurationSeconds: 60 }, { refreshCount: 0, startedAt: 0 }, 59_000).reached).toBe(false);
    expect(checkLimits({ stopAt: "2026-01-01T00:00:00Z" }, { refreshCount: 0, startedAt: 0 }, Date.parse("2026-01-02")).reached).toBe(true);
  });
  it("restored schedules are staggered and never in the past", () => {
    const now = 1_000_000;
    expect(restoredDueAt(now - 50_000, now + 60_000, now, 0)).toBe(now + 30_000);
    expect(restoredDueAt(now - 50_000, now + 60_000, now, 3)).toBe(now + 36_000);
    expect(restoredDueAt(now + 300_000, now + 60_000, now, 3)).toBe(now + 300_000);
  });
  it("randomized intervals stay in range", () => {
    expect(intervalDelayMs({ type: "interval", seconds: 30, randomMaxSeconds: 90 }, () => 0)).toBe(30_000);
    expect(intervalDelayMs({ type: "interval", seconds: 30, randomMaxSeconds: 90 }, () => 1)).toBe(90_000);
  });
});

describe("state machine", () => {
  it("only enters refreshing from evaluating", () => {
    expect(canTransition("evaluating", "refreshing")).toBe(true);
    for (const s of ["scheduled", "refreshing", "paused_activity", "completed", "idle"] as const) expect(canTransition(s, "refreshing")).toBe(false);
  });
  it("cannot evaluate from terminal states without rescheduling", () => {
    expect(canTransition("completed", "evaluating")).toBe(false);
    expect(canTransition("stopped", "scheduled")).toBe(true);
  });
  it("throws on illegal transitions", () => {
    expect(() => transition(newRuntime(1, "u", 0), "refreshing")).toThrow(IllegalTransitionError);
  });
});
