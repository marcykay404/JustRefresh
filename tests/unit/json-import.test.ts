import { BUNDLE_FORMAT, parseImport } from "@/integrations/json-import";
import { defaultRegistries } from "@/registries";
import { DEFAULT_SAFETY } from "@/core/defaults";
import { CONFIG_SCHEMA_VERSION } from "@/core/types";

const opts = { registries: defaultRegistries(), defaultSafety: DEFAULT_SAFETY, now: 0 };
const rule = (extra: Record<string, unknown> = {}) => ({ name: "r", target: { patterns: ["a.com"] }, trigger: { type: "interval", seconds: 60 }, ...extra });
const bundle = (extra: Record<string, unknown> = {}) => JSON.stringify({ format: BUNDLE_FORMAT, version: CONFIG_SCHEMA_VERSION, rules: [rule()], ...extra });

describe("parseImport", () => {
  it("rejects text that isn't JSON, and JSON that isn't a rule, rule list or bundle", () => {
    expect(parseImport("{", opts)).toMatchObject({ fatal: true, errors: [{ index: -1, diagnostics: [{ code: "json_invalid" }] }] });
    for (const json of ["42", '"text"', "null"]) {
      expect(parseImport(json, opts), json).toMatchObject({ fatal: true, errors: [{ diagnostics: [{ code: "shape_invalid" }] }] });
    }
  });

  it("accepts one rule or a list of rules, reporting invalid ones by index", () => {
    expect(parseImport(JSON.stringify(rule()), opts)).toMatchObject({ fatal: false, rules: [{ name: "r" }], errors: [] });
    const out = parseImport(JSON.stringify([rule(), { name: "bad" }]), opts);
    expect(out.rules).toHaveLength(1);
    expect(out.errors).toMatchObject([{ index: 1, name: "bad" }]);
  });

  it("gives a repeated id a new one", () => {
    const out = parseImport(JSON.stringify([rule({ id: "same" }), rule({ id: "same" })]), opts);
    expect(out.rules.map((r) => r.id)).toEqual(["same", ""]);
    expect(out.warnings[0]).toMatch(/Duplicate id "same"/);
  });

  it("exports are tagged justrefresh; exports made before the rename still import", () => {
    expect(BUNDLE_FORMAT).toBe("justrefresh");
    const old = parseImport(bundle({ format: "smart-auto-refresh" }), opts);
    expect(old).toMatchObject({ fatal: false, rules: [{ name: "r" }], errors: [] });
    // Any other format is read as a single rule (and fails validation as one).
    expect(parseImport(bundle({ format: "something-else" }), opts).rules).toEqual([]);
  });

  it("reads a bundle: invalid shape is fatal, bad exclusions are skipped, only importable settings are kept", () => {
    expect(parseImport(bundle({ rules: "nope" }), opts)).toMatchObject({ fatal: true, errors: [{ index: -1 }] });
    const out = parseImport(
      bundle({
        version: CONFIG_SCHEMA_VERSION + 1,
        exclusions: [{ pattern: "ok.com" }, { pattern: { type: "regex", value: "(" } }],
        settings: { paused: true, nativeBridgeEnabled: true, allowedExtensionIds: ["x"] },
      }),
      opts,
    );
    expect(out.fatal).toBe(false);
    expect(out.rules).toHaveLength(1);
    expect(out.exclusions).toEqual([{ pattern: "ok.com" }]);
    expect(out.settings).toEqual({ paused: true });
    expect(out.warnings.some((w) => /newer than supported/.test(w))).toBe(true);
    expect(out.warnings.some((w) => /Skipped exclusion/.test(w))).toBe(true);
    const plain = parseImport(bundle(), opts);
    expect(Object.keys(plain).sort()).toEqual(["errors", "exclusions", "fatal", "rules", "settings", "warnings"]);
    expect(plain.settings).toBeUndefined();
    expect(Object.keys(parseImport("[", opts)).sort()).toEqual(["errors", "exclusions", "fatal", "rules", "warnings"]);
  });
});
