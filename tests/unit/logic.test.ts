import { triAnd, triNot, triOr } from "@/conditions/logical";
import { evaluateConditionTree, explainTrace } from "@/core/evaluator";
import type { EvaluationResult } from "@/core/types";

const M: EvaluationResult = { status: "matched" };
const N: EvaluationResult = { status: "not_matched" };
const U: EvaluationResult = { status: "unknown", reason: "x" };

describe("Kleene tri-state logic", () => {
  it.each([
    [[M, M], "matched"],
    [[M, N], "not_matched"],
    [[M, U], "unknown"],
    [[N, U], "not_matched"],
    [[U, U], "unknown"],
  ])("AND %#", (inputs, expected) => expect(triAnd(inputs as EvaluationResult[]).status).toBe(expected));
  it.each([
    [[N, N], "not_matched"],
    [[M, N], "matched"],
    [[M, U], "matched"],
    [[N, U], "unknown"],
  ])("OR %#", (inputs, expected) => expect(triOr(inputs as EvaluationResult[]).status).toBe(expected));
  it("NOT", () => {
    expect(triNot(M).status).toBe("not_matched");
    expect(triNot(N).status).toBe("matched");
    expect(triNot(U).status).toBe("unknown");
  });
});

describe("evaluateConditionTree", () => {
  const base = {
    now: 1000,
    tab: { id: 1, url: "https://example.com/a", status: "complete" },
    runtime: { refreshCount: 100, navigationCount: 0, startedAt: 0 },
  };

  it("batches page leaves into a single round-trip", async () => {
    const calls: number[] = [];
    const out = await evaluateConditionTree(
      {
        type: "all",
        conditions: [
          { type: "dom.exists", selector: "#a" },
          { type: "not", condition: { type: "dom.text", selector: "#b", operator: "contains", value: "x" } },
          { type: "url.match", pattern: "example.com" },
        ],
      },
      {
        ...base,
        pageEvaluator: async (leaves) => {
          calls.push(leaves.length);
          return [M, N];
        },
      },
    );
    expect(calls).toEqual([1 + 1]);
    expect(out.result.status).toBe("matched");
    expect(out.trace.children).toHaveLength(3);
  });

  it("decides despite unknown page leaves when browser leaves are decisive", async () => {
    const out = await evaluateConditionTree(
      {
        type: "any",
        conditions: [
          { type: "dom.exists", selector: "#a" },
          { type: "refreshCount", operator: ">=", value: 100 },
        ],
      },
      {
        ...base,
        pageEvaluator: async () => {
          throw new Error("no content script");
        },
      },
    );
    expect(out.result.status).toBe("matched");
  });

  it("reports unknown with a reason, never false", async () => {
    const out = await evaluateConditionTree(
      { type: "dom.exists", selector: "#a" },
      {
        ...base,
        pageEvaluator: async () => {
          throw new Error("Cannot access page");
        },
      },
    );
    expect(out.result).toMatchObject({ status: "unknown", code: "content_script_unavailable" });
    expect(explainTrace(out.trace)).toMatch(/Cannot access page/);
  });
});
