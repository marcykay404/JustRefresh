import { readdirSync, readFileSync } from "node:fs";
import { validateRule } from "@/core/rule-schema";

describe("examples/ are valid rules", () => {
  for (const f of readdirSync("examples").filter((x) => x.endsWith(".json"))) {
    it(f, () => {
      const v = validateRule(JSON.parse(readFileSync(`examples/${f}`, "utf8")));
      expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    });
  }
});
