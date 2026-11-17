import { validateRule } from "@/core/rule-schema";
import { matchesAny } from "@/core/url-pattern";
import { describeRule, intervalChips, intervalLabel, untilRule } from "@/ui/popup/describe";
import { countdownOf } from "@/ui/shared/format";
import { newRuntime } from "@/core/state-machine";
import type { TabRuntime } from "@/core/types";

describe("popup wording helpers", () => {
  it("labels intervals in words", () => {
    expect([5, 30, 60, 90, 300, 3600, 5400, 7200].map(intervalLabel)).toEqual([
      "5 sec",
      "30 sec",
      "1 min",
      "1 min 30 sec",
      "5 min",
      "1 hour",
      "1 hr 30 min",
      "2 hours",
    ]);
  });

  it("offers fast chips only when fast intervals are allowed", () => {
    expect(intervalChips(false)).toEqual([30, 60, 300, 900, 3600]);
    expect(intervalChips(true)[0]).toBe(10);
  });

  it("summarises a rule in one line", () => {
    const base = {
      trigger: { type: "interval", seconds: 600 } as never,
      actions: { onMatched: [{ type: "stopRefresh" }, { type: "notify" }], onNotMatched: [{ type: "refresh" }] } as never,
    };
    expect(describeRule({ ...base, stopWhen: { type: "dom.text", operator: "contains", value: "S$ 3", selector: ".price" } as never })).toBe(
      "Refreshing every 10 min until “S$ 3” appears in .price, then notify me",
    );
    expect(describeRule({ ...base, stopWhen: undefined })).toBe("Refreshing every 10 min");
    expect(
      describeRule({
        ...base,
        stopWhen: {
          type: "any",
          conditions: [
            { type: "dom.exists", selector: "#a" },
            { type: "dom.exists", selector: "#b" },
          ],
        } as never,
      }),
    ).toBe("Refreshing every 10 min until #a appears on the page or #b appears on the page, then notify me");
  });

  it("names the random range and a refresh limit", () => {
    const rule = {
      trigger: { type: "interval", seconds: 60, randomMaxSeconds: 108000 } as never,
      stopWhen: {
        type: "any",
        conditions: [
          { type: "dom.text", operator: "contains", value: "3 successful checks" },
          { type: "refreshCount", operator: ">=", value: 40 },
        ],
      } as never,
      actions: { onMatched: [{ type: "stopRefresh" }, { type: "notify" }], onNotMatched: [{ type: "refresh" }] } as never,
    };
    expect(describeRule(rule)).toBe(
      "Refreshing at random intervals of 1 min to 30 hours until “3 successful checks” appears or it has refreshed 40 times, then notify me",
    );
    // A random maximum no larger than the interval is just the interval.
    expect(describeRule({ ...rule, trigger: { type: "interval", seconds: 60, randomMaxSeconds: 60 } as never }, null)).toMatch(/^Refreshing every 1 min until/);
    const random = (seconds: number, randomMaxSeconds: number, effective?: number) =>
      describeRule({ ...rule, stopWhen: undefined, trigger: { type: "interval", seconds, randomMaxSeconds } as never }, effective);
    expect(random(300, 360)).toBe("Refreshing at random intervals of 5 to 6 min");
    expect(random(3600, 7200)).toBe("Refreshing at random intervals of 1 to 2 hours");
    expect(random(3600, 7170)).toBe("Refreshing at random intervals of 1 to 2 hours");
    expect(random(3600, 5400)).toBe("Refreshing at random intervals of 1 hour to 1 hr 30 min");
    // A range too small to show reads as the interval.
    expect(random(3600, 3620)).toBe("Refreshing every 1 hour");
    // Fast intervals turned off: the popup passes the interval in effect (30 s).
    expect(random(5, 20, 30)).toBe("Refreshing every 30 sec");
    expect(random(10, 60, 30)).toBe("Refreshing at random intervals of 30 sec to 1 min");
  });

  it("joins with and, and words other refresh counts", () => {
    const rule = (conditions: unknown[], type = "all") => ({
      trigger: { type: "interval", seconds: 600 } as never,
      stopWhen: { type, conditions } as never,
      actions: { onMatched: [{ type: "stopRefresh" }], onNotMatched: [{ type: "refresh" }] } as never,
    });
    const shown = { type: "dom.exists", selector: "#ok" };
    expect(describeRule(rule([shown, { type: "refreshCount", operator: ">", value: 1 }]))).toContain(
      "until #ok appears on the page and it has refreshed more than once",
    );
    expect(describeRule(rule([shown, { type: "refreshCount", operator: ">=", value: 1 }], "any"))).toContain("or it has refreshed once");
  });

  it("keeps the count for nested or long condition lists", () => {
    const leaf = { type: "dom.exists", selector: "#a" };
    const rule = (conditions: unknown[]) => ({
      trigger: { type: "interval", seconds: 600 } as never,
      stopWhen: { type: "all", conditions } as never,
      actions: { onMatched: [{ type: "stopRefresh" }], onNotMatched: [{ type: "refresh" }] } as never,
    });
    expect(describeRule(rule([leaf, leaf, leaf, leaf]))).toContain("all of 4 conditions match");
    expect(describeRule(rule([leaf, { type: "any", conditions: [leaf, leaf] }]))).toContain("all of 2 conditions match");
    expect(describeRule(rule([leaf, { type: "refreshCount", operator: "<", value: 3 }]))).toContain("all of 2 conditions match");
  });
});

describe("Refresh until something appears", () => {
  const url = "https://shop.example.com/item/42?colour=red";
  it("creates a valid rule for exactly this page that stops and notifies with a sound", () => {
    const input = untilRule({ url, site: "shop.example.com", seconds: 60, text: "  In stock ", mode: "appears" });
    const v = validateRule(input);
    expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(v.valid).toBe(true);
    const r = v.normalized!;
    expect(r.enabled).toBe(true);
    expect(r.stopWhen).toMatchObject({ type: "dom.text", operator: "contains", value: "In stock", caseSensitive: false });
    expect(r.actions.onMatched.map((a) => a.type)).toEqual(["stopRefresh", "highlight", "notify"]);
    expect(r.actions.onMatched[1]).toMatchObject({ text: "In stock" });
    expect(r.actions.onMatched[2]).toMatchObject({ sound: true, title: "Found “In stock”" });
    expect(r.actions.onNotMatched.map((a) => a.type)).toEqual(["refresh"]);
    expect(describeRule(r)).toBe("Refreshing every 1 min until “In stock” appears, then highlight “In stock” and notify me");
  });

  it("matches this exact page only", () => {
    const pattern = untilRule({ url, site: "shop.example.com", seconds: 60, text: "x", mode: "appears" }).target.patterns[0]!;
    expect(matchesAny([pattern], url)).not.toBeNull();
    expect(matchesAny([pattern], "https://shop.example.com/item/43?colour=red")).toBeNull();
  });

  it("supports 'disappears'", () => {
    const r = untilRule({ url, site: "shop.example.com", seconds: 300, text: "Sold out", mode: "disappears" });
    // Gone only after it was seen: a login or error page doesn't count.
    expect(r.stopWhen).toEqual({ type: "dom.text_lost", value: "Sold out", caseSensitive: false });
    expect(r.actions!.onMatched!.map((a) => a.type)).toEqual(["stopRefresh", "notify"]);
    expect(validateRule(r).valid).toBe(true);
    expect(describeRule(validateRule(r).normalized!)).toBe("Refreshing every 5 min until “Sold out” disappears, then notify me");
  });
});

describe("describing a rule from its actions (approval card, popup)", () => {
  const interval = { type: "interval", seconds: 60 } as never;
  const cond = { type: "dom.text", operator: "contains", value: "Sold out" } as never;
  const d = (actions: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    describeRule({ trigger: interval, stopWhen: undefined, actions: { onMatched: [], onNotMatched: [], ...actions } as never, ...extra } as never);

  it("doesn't say Refreshing when nothing refreshes", () => {
    expect(d({ onNotMatched: [{ type: "notify" }] })).toBe("Every 1 min: notify me (no refresh)");
    expect(d({ onNotMatched: [{ type: "refresh" }, { type: "notify" }] })).toBe("Refreshing every 1 min, and each time: notify me");
  });

  it("an unusual shape is spelled out instead of read as 'until'", () => {
    expect(d({ onMatched: [{ type: "refresh" }], onNotMatched: [] }, { stopWhen: cond })).toBe(
      "Every 1 min: when “Sold out” appears, refresh; otherwise do nothing",
    );
    expect(d({ onMatched: [{ type: "notify" }], onNotMatched: [{ type: "refresh" }] }, { stopWhen: cond })).toBe(
      "Every 1 min: when “Sold out” appears, notify me; otherwise refresh",
    );
  });

  it("mentions what happens when the page can't be checked, and timed pauses", () => {
    expect(
      d({ onMatched: [{ type: "stopRefresh" }], onNotMatched: [{ type: "refresh" }], onUnknown: [{ type: "pauseRefresh", minutes: 30 }] }, { stopWhen: cond }),
    ).toBe("Refreshing every 1 min until “Sold out” appears; if the page can't be checked: pause for 30 min");
  });

  it("page-load rules that only look", () => {
    expect(
      describeRule({ trigger: { type: "navigation" } as never, stopWhen: cond, actions: { onMatched: [{ type: "notify" }], onNotMatched: [] } as never }),
    ).toBe("Checking each time the page loads: notify me when “Sold out” appears");
    expect(describeRule({ trigger: { type: "navigation" } as never, actions: { onMatched: [], onNotMatched: [] } as never })).toBe(
      "Runs each time the page loads",
    );
  });
});

describe("unknown trigger or condition names (review)", () => {
  it("names like __proto__ or constructor are treated as unknown, never looked up on Object.prototype", () => {
    const actions = { onMatched: [], onNotMatched: [{ type: "refresh" }] } as never;
    expect(describeRule({ trigger: { type: "constructor" } as never, actions })).toBe("Refreshing on its constructor trigger");
    expect(describeRule({ trigger: { type: "__proto__" } as never, actions })).toBe("Refreshing on its __proto__ trigger");
  });
});

it("describes click and webhook actions plainly, saying where a webhook sends and whether the page address goes too", async () => {
  const { actionsPhrase } = await import("@/ui/popup/describe");
  expect(actionsPhrase([{ type: "click", selector: "#add" } as never, { type: "stopRefresh" }])).toBe("click #add and stop");
  expect(actionsPhrase([{ type: "webhook", url: "http://localhost:9000/hook" } as never])).toBe("send a message to http://localhost:9000/hook");
  expect(actionsPhrase([{ type: "webhook", url: "http://127.0.0.1:2375/x", includePageUrl: true } as never])).toBe(
    "send a message to http://127.0.0.1:2375/x (with the page address)",
  );
  expect(actionsPhrase([{ type: "refresh", keepScroll: true } as never])).toBe("refresh (keeping the scroll position)");
});

describe("countdown progress", () => {
  const rt = (patch: Partial<TabRuntime>) => ({ ...newRuntime(1, "https://example.com/", 0), ...patch });
  it("measures the wait actually scheduled, not the rule's interval", () => {
    // Randomized: 60 s interval, but this wait runs 10 hours from the last check.
    const r = rt({ startedAt: 0, lastAttemptAt: 1000, nextDueAt: 1000 + 10 * 3600_000 });
    expect(countdownOf(r, 1000 + 5 * 3600_000, 60, 108000)).toEqual({ countdown: 5 * 3600_000, progress: 50 });
  });
  it("counts a randomized wait from the start before the first check", () => {
    expect(countdownOf(rt({ startedAt: 0, nextDueAt: 60_000 }), 15_000, 30, 120).progress).toBe(25);
  });
  it("uses the interval for a fixed one, even when the wait was restarted later (Resume, Refresh now)", () => {
    const r = rt({ startedAt: 0, lastAttemptAt: 0, nextDueAt: 3600_000 + 600_000 });
    expect(countdownOf(r, 3600_000, 600).progress).toBe(0);
  });
  it("uses the interval when the random maximum isn't above it (fast intervals off clamp both to 30 s)", () => {
    const r = rt({ startedAt: 0, lastAttemptAt: 0, nextDueAt: 3600_000 + 30_000 });
    expect(countdownOf(r, 3600_000 + 15_000, 30, 20).progress).toBe(50);
    expect(countdownOf(r, 3600_000 + 15_000, 30, 30).progress).toBe(50);
  });
  it("caps a randomized wait at the random maximum", () => {
    // Resumed an hour after the last check, with 10 min of a 60 s–20 min random wait to go.
    const r = rt({ startedAt: 0, lastAttemptAt: 0, nextDueAt: 3600_000 + 600_000 });
    expect(countdownOf(r, 3600_000, 60, 1200).progress).toBe(50);
  });
  it("is never ahead of the time left when the times don't add up, and is empty with nothing scheduled", () => {
    expect(countdownOf(rt({ startedAt: 0, lastAttemptAt: 90_000, nextDueAt: 60_000 }), 30_000, 30, 120).progress).toBe(0);
    expect(countdownOf(rt({ nextDueAt: null }), 0, 60)).toEqual({ countdown: null, progress: 0 });
    expect(countdownOf(null, 0, 60)).toEqual({ countdown: null, progress: 0 });
  });
});
