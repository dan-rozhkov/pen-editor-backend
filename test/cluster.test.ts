import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { clusterSummaries } from "../src/analysis/cluster.js";

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function objectModel(objects: Array<Record<string, unknown>>) {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        { type: "text", text: JSON.stringify(objects[Math.min(call++, objects.length - 1)]) },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
      warnings: [],
    }),
  });
}

const items = [
  { id: 1, summary: "batch_design failed with operation limit" },
  { id: 2, summary: "batch_design failed with unknown node id" },
  { id: 3, summary: "successful landing page creation" },
];

describe("clusterSummaries", () => {
  it("returns clusters and routes unassigned/invalid ids to Unclustered", async () => {
    const model = objectModel([
      {
        clusters: [
          {
            name: "batch_design failures",
            description: "Sessions where batch_design rejected operations",
            summary_ids: [1, 2, 99], // 99 is invalid — must be dropped
          },
        ],
      },
    ]);
    const clusters = await clusterSummaries(model, items);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].name).toBe("batch_design failures");
    expect(clusters[0].summaryIds).toEqual([1, 2]);
    expect(clusters[1].name).toBe("Unclustered");
    expect(clusters[1].summaryIds).toEqual([3]);
  });

  it("assigns each summary to exactly one cluster (first wins on duplicates)", async () => {
    const model = objectModel([
      {
        clusters: [
          { name: "A", description: "a", summary_ids: [1, 2] },
          { name: "B", description: "b", summary_ids: [2, 3] },
        ],
      },
    ]);
    const clusters = await clusterSummaries(model, items);
    expect(clusters.find((c) => c.name === "A")!.summaryIds).toEqual([1, 2]);
    expect(clusters.find((c) => c.name === "B")!.summaryIds).toEqual([3]);
    expect(clusters.find((c) => c.name === "Unclustered")).toBeUndefined();
  });
});
