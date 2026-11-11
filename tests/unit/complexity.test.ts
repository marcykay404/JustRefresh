/**
 * Cyclomatic and cognitive complexity stay within the limits in
 * eslint.config.js. Functions already over them are in
 * complexity-baseline.json and may only get simpler (see scripts/complexity.mjs).
 */
// @ts-expect-error plain JS module without types
import { compare, measure, readBaseline } from "../../scripts/complexity.mjs";

it("no function is more complex than allowed (or than its baseline)", async () => {
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
});
