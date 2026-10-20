import { describe, expect, it } from "vitest";
import type { TasteCheckScreenResult } from "../src/ai/tasteCheck.js";
import {
  calibrate,
  groupByTask,
  computeRuleStats,
  findingsToVerdicts,
  formatTable,
  type LabelsFile,
  type Verdict,
} from "../src/evals/calibrate.js";

function pairs(spec: Array<[Verdict, Verdict, number]>) {
  return spec.flatMap(([human, judge, count]) =>
    Array.from({ length: count }, () => ({ human, judge })),
  );
}

describe("computeRuleStats", () => {
  it("computes agreement and kappa on a hand-checked set", () => {
    // 20 screens: both fail 6, both pass 10, judge pass/human fail 2, judge fail/human pass 2.
    // po = 16/20 = 0.8; humanFail = 8/20 = .4; judgeFail = 8/20 = .4
    // pe = .16 + .36 = .52; kappa = (.8-.52)/.48 = 0.58333
    const s = computeRuleStats(
      "r",
      pairs([
        ["fail", "fail", 6],
        ["pass", "pass", 10],
        ["fail", "pass", 2],
        ["pass", "fail", 2],
      ]),
    );
    expect(s.n).toBe(20);
    expect(s.agreement).toBeCloseTo(0.8, 10);
    expect(s.kappa).toBeCloseTo(0.58333, 4);
    expect(s.falsePass).toBe(2);
    expect(s.falseFail).toBe(2);
    expect(s.notEnoughLabels).toBe(false);
  });

  it("reports kappa as null when expected agreement is 1", () => {
    const s = computeRuleStats("r", pairs([["pass", "pass", 12]]));
    expect(s.agreement).toBe(1);
    expect(s.kappa).toBeNull();
  });

  it("flags rules with fewer than 10 labels", () => {
    expect(computeRuleStats("r", pairs([["pass", "pass", 9]])).notEnoughLabels).toBe(true);
    expect(computeRuleStats("r", pairs([["pass", "pass", 10]])).notEnoughLabels).toBe(false);
  });
});

describe("findingsToVerdicts", () => {
  it("maps findings to fail, other rules to pass, and omits unchecked screens", () => {
    const results: TasteCheckScreenResult[] = [
      {
        id: "a",
        findings: [{ rule: "emoji_icons", title: "t", fix: "f", noul: 0.9 }],
      },
      { id: "b", findings: [] },
    ];
    const v = findingsToVerdicts(results, ["emoji_icons", "ai_palette"]);
    expect(v.a).toEqual({ emoji_icons: "fail", ai_palette: "pass" });
    expect(v.b).toEqual({ emoji_icons: "pass", ai_palette: "pass" });
    expect(v.c).toBeUndefined();
  });
});

describe("calibrate", () => {
  it("excludes unknown labels and screens without a verdict", () => {
    const labels: LabelsFile = {
      runDir: ".",
      rules: ["r"],
      screens: [
        { file: "s1", task: "t", labels: { r: "fail" } },
        { file: "s2", task: "t", labels: { r: "unknown" } },
        { file: "s3", task: "t", labels: { r: "pass" } },
        { file: "s4", task: "t", labels: { r: "pass" } },
      ],
    };
    const verdicts = {
      s1: { r: "fail" as const },
      s2: { r: "fail" as const },
      s3: { r: "fail" as const },
    };
    const [stat] = calibrate(labels, verdicts, (s) => s.file);
    expect(stat.n).toBe(2);
    expect(stat.agreement).toBe(0.5);
    expect(stat.falseFail).toBe(1);
  });
});

describe("formatTable", () => {
  it("prints the not-enough-labels note and n/a kappa", () => {
    const out = formatTable([computeRuleStats("r", pairs([["pass", "pass", 3]]))]);
    expect(out).toContain("not enough labels");
    expect(out).toContain("n/a");
  });
});

describe("groupByTask", () => {
  it("groups screens by task preserving order", () => {
    const grouped = groupByTask([
      { task: "a", file: "1" },
      { task: "b", file: "2" },
      { task: "a", file: "3" },
    ]);
    expect([...grouped.keys()]).toEqual(["a", "b"]);
    expect(grouped.get("a")?.map((s) => s.file)).toEqual(["1", "3"]);
  });
});
