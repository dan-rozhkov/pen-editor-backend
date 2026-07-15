import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

export interface SummaryItem {
  id: number;
  summary: string;
}

export interface ClusterAssignment {
  name: string;
  description: string;
  summaryIds: number[];
}

const clusteringSchema = z.object({
  clusters: z.array(
    z.object({
      name: z.string().describe("Short cluster name (a problem or pattern)"),
      description: z.string().describe("1-2 sentences: what unites these sessions"),
      summary_ids: z.array(z.number()),
    }),
  ),
});

const CLUSTERING_SYSTEM = `You group session summaries of an AI design agent into clusters of recurring problems and usage patterns, to guide agent improvements.

Rules:
- Prefer clusters that are ACTIONABLE for improving the agent (recurring tool failures, misunderstood requests, workflow friction) over generic topical groups.
- 3-10 clusters for typical inputs; small inputs may yield fewer.
- Every summary id should appear in exactly one cluster.
- Cluster names/descriptions must not contain personal data or verbatim quotes.`;

export async function clusterSummaries(
  model: LanguageModel,
  items: SummaryItem[],
): Promise<ClusterAssignment[]> {
  const prompt = items.map((i) => `[${i.id}] ${i.summary}`).join("\n\n");
  const { object } = await generateObject({
    model,
    schema: clusteringSchema,
    system: CLUSTERING_SYSTEM,
    prompt,
  });

  const validIds = new Set(items.map((i) => i.id));
  const seen = new Set<number>();
  const result: ClusterAssignment[] = [];
  for (const c of object.clusters) {
    const ids = c.summary_ids.filter((id) => validIds.has(id) && !seen.has(id));
    ids.forEach((id) => seen.add(id));
    if (ids.length > 0) {
      result.push({ name: c.name, description: c.description, summaryIds: ids });
    }
  }
  const leftover = items.map((i) => i.id).filter((id) => !seen.has(id));
  if (leftover.length > 0) {
    result.push({
      name: "Unclustered",
      description: "Sessions the model did not assign to any cluster",
      summaryIds: leftover,
    });
  }
  return result;
}
