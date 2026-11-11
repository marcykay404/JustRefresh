import { tabBadge } from "@/core/badge";
import { newRuntime, transition } from "@/core/state-machine";

const fmt = (t: number) => `T${t}`;

describe("per-tab toolbar badge", () => {
  const base = newRuntime(1, "https://a.test/", 0);

  it("shows ON with the next refresh time while running", () => {
    const rt = transition(base, "scheduled", { nextDueAt: 5000 });
    expect(tabBadge(rt, fmt)).toEqual({ text: "ON", color: "#16a34a", title: "JustRefresh: Scheduled · next refresh at T5000" });
  });

  it("shows paused, completed and error states with their reason", () => {
    expect(tabBadge(transition(base, "paused_unsaved", { reason: "Unsaved form" }), fmt)).toMatchObject({
      text: "II",
      title: expect.stringContaining("Unsaved form"),
    });
    expect(tabBadge(transition(base, "scheduled", {}), fmt)?.text).toBe("ON");
    const done = transition(transition(base, "scheduled", {}), "evaluating", {});
    expect(tabBadge(transition(done, "completed", { reason: "Matched" }), fmt)).toMatchObject({ text: "✓" });
    expect(tabBadge(transition(base, "error", { reason: "boom" }), fmt)).toMatchObject({ text: "!", title: expect.stringContaining("boom") });
  });

  it("clears the tab badge for idle, stopped and excluded tabs (global badge shows instead)", () => {
    expect(tabBadge(null, fmt)).toBeNull();
    expect(tabBadge(base, fmt)).toBeNull();
    expect(tabBadge(transition(base, "excluded", {}), fmt)).toBeNull();
  });
});
