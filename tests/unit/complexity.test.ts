/**
 * Cyclomatic and cognitive complexity stay within the limits in
 * eslint.config.js. complexity-baseline.json (empty now) can list functions
 * allowed over them, which may only get simpler (see scripts/complexity.mjs).
 */
// @ts-expect-error plain JS module without types
import { compare, lowered, measure, readBaseline } from "../../scripts/complexity.mjs";

it("no function is more complex than allowed", async () => {
  const { offenders, errors } = await measure();
  expect(errors).toEqual([]);
  expect(compare(offenders, readBaseline())).toEqual([]);
}, 60_000);

describe("the ratchet", () => {
  const base = { cyclomatic: { "a.ts | function a()": 20 }, cognitive: {} };
  it("passes when nothing changed", () => {
    expect(compare({ cyclomatic: { "a.ts | function a()": 20 }, cognitive: {} }, base)).toEqual([]);
  });
  it("fails on a new function over the limit", () => {
    expect(compare({ cyclomatic: { "a.ts | function a()": 20, "b.ts | function b()": 16 }, cognitive: {} }, base)).toEqual([
      "cyclomatic 16 (over the limit): b.ts | function b(). Split or simplify it.",
    ]);
  });
  it("fails when a listed function gets worse, and asks to lower the baseline when it improves", () => {
    expect(compare({ cyclomatic: { "a.ts | function a()": 21 }, cognitive: {} }, base)[0]).toMatch(/rose from 20 to 21/);
    expect(compare({ cyclomatic: { "a.ts | function a()": 18 }, cognitive: {} }, base)[0]).toMatch(/fell from 20 to 18.*complexity:update/);
  });
  it("asks to remove a listed function once it is within the limit", () => {
    expect(compare({ cyclomatic: {}, cognitive: {} }, base)[0]).toMatch(/now within the limit: a.ts/);
  });
  it("--update only lowers the baseline: never adds a new offender or raises one", () => {
    expect(lowered({ cyclomatic: { "a.ts | function a()": 18 }, cognitive: {} }, base)).toEqual({ cyclomatic: { "a.ts | function a()": 18 }, cognitive: {} });
    expect(lowered({ cyclomatic: {}, cognitive: {} }, base)).toEqual({ cyclomatic: {}, cognitive: {} });
    const worse = { cyclomatic: { "a.ts | function a()": 25, "b.ts | function b()": 16 }, cognitive: { "c.ts | function c()": 30 } };
    const next = lowered(worse, base);
    expect(next).toEqual(base);
    expect(compare(worse, next)).toHaveLength(3);
  });
});

it("the limits can't be switched off with an inline comment", async () => {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: process.cwd() });
  const branches = Array.from({ length: 20 }, (_, i) => `  if (x === ${i}) return ${i};`).join("\n");
  for (const comment of ["// eslint-disable-next-line complexity, sonarjs/cognitive-complexity", "/* eslint-disable */", '/* eslint complexity: ["error", 99] */']) {
    const [r] = await eslint.lintText(`${comment}\nexport function f(x: number) {\n${branches}\n  return -1;\n}\n`, { filePath: "src/__probe.ts" });
    expect(r!.messages.some((m) => m.ruleId === "complexity"), comment).toBe(true);
  }
}, 30_000);
