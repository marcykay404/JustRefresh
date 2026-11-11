import { validateRule } from "@/core/rule-schema";
import { matchesAny } from "@/core/url-pattern";
import { normalizeAddress, TEMPLATES, type TemplateValues } from "@/ui/dashboard/templates";

const values = (t: (typeof TEMPLATES)[number]): TemplateValues => ({
  url: "https://www.shop.example.com/item/42",
  text: t.text?.initial ?? "",
  seconds: t.initialSeconds,
  start: "08:00",
  end: "18:00",
});

describe("templates", () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))("%s builds a valid rule with the defaults", (_id, t) => {
    const v = validateRule(t.build(values(t)));
    expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(v.valid).toBe(true);
    expect(v.normalized!.enabled).toBe(true);
  });

  it("describes each rule in words before it is saved", () => {
    const byId = Object.fromEntries(TEMPLATES.map((t) => [t.id, t.describe(values(t))]));
    expect(byId["back-in-stock"]).toBe(
      "Refresh shop.example.com/item/42 every 1 min until “In stock” appears, then stop and notify you with a sound. It waits while you're typing.",
    );
    expect(byId["work-hours-dashboard"]).toBe("Refresh shop.example.com/item/42 every 5 to 6 min, Monday to Friday, 08:00 to 18:00. It waits while you're typing.");
    expect(byId["stay-signed-in"]).toBe("Refresh any open shop.example.com page every 10 min so it doesn't log you out. It waits while you're typing.");
  });

  it("page templates match only that page; 'Stay signed in' matches the whole site", () => {
    const page = TEMPLATES.find((t) => t.id === "back-in-stock")!;
    const site = TEMPLATES.find((t) => t.id === "stay-signed-in")!;
    const p = page.build(values(page)).target.patterns;
    const s = site.build(values(site)).target.patterns;
    expect(matchesAny(p, "https://www.shop.example.com/item/42")).not.toBeNull();
    expect(matchesAny(p, "https://www.shop.example.com/item/43")).toBeNull();
    expect(matchesAny(s, "https://www.shop.example.com/account")).not.toBeNull();
    expect(matchesAny(s, "https://other.example.com/")).toBeNull();
  });

  it("work hours become a Monday–Friday schedule", () => {
    const t = TEMPLATES.find((x) => x.id === "work-hours-dashboard")!;
    expect(t.build({ ...values(t), start: "09:30", end: "17:00" }).schedule).toEqual({ days: [1, 2, 3, 4, 5], startTime: "09:30", endTime: "17:00" });
  });

  it("accepts typed addresses with or without https://", () => {
    expect(normalizeAddress("shop.example.com/item")).toBe("https://shop.example.com/item");
    expect(normalizeAddress("http://intranet.local/x")).toBe("http://intranet.local/x");
    expect(normalizeAddress("chrome://settings")).toBeNull();
    expect(normalizeAddress("  ")).toBeNull();
  });
});
