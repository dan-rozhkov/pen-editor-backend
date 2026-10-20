import { describe, expect, it } from "vitest";
import { choose, mean, meanDefined, passAtK, passPowK } from "../src/evals/metrics.js";

describe("eval metrics", () => {
  it("computes binomial coefficients", () => {
    expect(choose(5, 2)).toBe(10);
    expect(choose(3, 5)).toBe(0);
  });

  it.each([
    // n, c, k, pass@k, pass^k
    [3, 2, 1, 1 - 1 / 3, 2 / 3],
    [3, 2, 2, 1, 1 / 3],
    [3, 3, 3, 1, 1],
    [3, 0, 3, 0, 0],
    [5, 2, 3, 1 - 1 / 10, 0],
    [4, 4, 2, 1, 1],
  ])("n=%i c=%i k=%i", (n, c, k, atK, powK) => {
    expect(passAtK(n, c, k)).toBeCloseTo(atK, 10);
    expect(passPowK(n, c, k)).toBeCloseTo(powK, 10);
  });

  it("returns null (not measurable) for both when n < k or n = 0", () => {
    expect(passAtK(2, 2, 3)).toBeNull();
    expect(passPowK(2, 2, 3)).toBeNull();
    expect(passAtK(0, 0, 1)).toBeNull();
    expect(passPowK(0, 0, 1)).toBeNull();
  });

  it("averages only the measurable values", () => {
    expect(meanDefined([1, null, 0])).toBe(0.5);
    expect(meanDefined([null, null])).toBeNull();
  });

  it("averages", () => {
    expect(mean([1, 0])).toBe(0.5);
    expect(mean([])).toBe(0);
  });
});
