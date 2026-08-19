import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  atomsOf,
  bucketAtoms,
  confirmationsOf,
  cosine,
  extractScenarios,
  findDuplicate,
  MAX_ATOMS_PER_BUCKET,
  mergeSessionIds,
  SCENARIO_DEDUP_MAX_DISTANCE,
  type ExistingScenario,
} from "../src/analysis/scenarios.js";

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

const row = (session_id: string, user_id: string | null, corrections: unknown[]) => ({
  session_id,
  user_id,
  errors: [],
  corrections,
  memory_requests: [],
});

const existingScenario = (over: Partial<ExistingScenario> & { id: number }): ExistingScenario => ({
  title: "some pattern",
  embedding: null,
  session_ids: ["s1"],
  state: "open",
  ...over,
});

describe("atomsOf", () => {
  // Defect: interpolating optional fields unconditionally produced atoms
  // like "tool undefined: undefined" / "agent did: undefined / user wanted:
  // undefined" — non-empty strings that the trailing empty-text filter never
  // caught, so partial records were counted as evidence and reached the
  // extraction prompt.
  it("skips an error record missing tool or error", () => {
    const atoms = atomsOf({
      session_id: "s1",
      user_id: "u1",
      errors: [{ error: "boom" }, { tool: "batch_design" }, { tool: "batch_design", error: "boom" }],
      corrections: [],
      memory_requests: [],
    });
    expect(atoms).toHaveLength(1);
    expect(atoms[0].text).toBe("tool batch_design: boom");
  });

  it("skips a correction record missing what_agent_did or what_user_wanted", () => {
    const atoms = atomsOf({
      session_id: "s1",
      user_id: "u1",
      errors: [],
      corrections: [
        { what_user_wanted: "a draft" },
        { what_agent_did: "asked questions" },
        { what_agent_did: "asked questions", what_user_wanted: "a draft" },
      ],
      memory_requests: [],
    });
    expect(atoms).toHaveLength(1);
    expect(atoms[0].text).toBe("agent did: asked questions / user wanted: a draft");
  });
});

describe("bucketAtoms", () => {
  it("splits by user and puts unattributed sessions in the global bucket, global first", () => {
    // The global bucket needs the same viability (>=2 atoms from >=2
    // sessions) as any user bucket, so s3 and s4 together make it viable —
    // a single unattributed session alone would be dropped, same as the
    // "cannot show repetition" case below.
    const buckets = bucketAtoms([
      row("s1", "u1", [{ what_agent_did: "asked questions", what_user_wanted: "a draft", agent_complied: false }]),
      row("s2", "u1", [{ what_agent_did: "asked questions", what_user_wanted: "a draft", agent_complied: false }]),
      row("s3", null, [{ what_agent_did: "used stock photos", what_user_wanted: "generated art", agent_complied: true }]),
      row("s4", null, [{ what_agent_did: "used stock photos", what_user_wanted: "generated art", agent_complied: true }]),
    ]);
    // Global is pushed FIRST (defect 4): the per-run bucket cap in run.ts
    // slices from the front, and with the old "global last" ordering a
    // deployment with more users than the cap would starve the global
    // bucket forever, every run.
    expect(buckets.map((b) => [b.scope, b.userId, b.atoms.length])).toEqual([
      ["global", null, 2],
      ["user", "u1", 2],
    ]);
  });

  it("drops a bucket that cannot show repetition (single atom, single session)", () => {
    const buckets = bucketAtoms([row("s1", "u9", [{ what_agent_did: "a", what_user_wanted: "b", agent_complied: true }])]);
    expect(buckets.find((b) => b.userId === "u9")).toBeUndefined();
  });

  it("caps atoms per bucket, keeping the freshest and reporting the truncation", () => {
    // Rows are expected to arrive freshest-first (run.ts orders the query by
    // recency DESC) — a bucket over MAX_ATOMS_PER_BUCKET must keep the
    // front of the array and report how much it dropped, not silently keep
    // going until generateObject throws on an oversized prompt.
    const rows = Array.from({ length: MAX_ATOMS_PER_BUCKET + 5 }, (_, i) =>
      row(`s${i}`, "u1", [{ what_agent_did: `did-${i}`, what_user_wanted: `wanted-${i}`, agent_complied: false }]),
    );
    const [bucket] = bucketAtoms(rows);
    expect(bucket.atoms).toHaveLength(MAX_ATOMS_PER_BUCKET);
    expect(bucket.truncatedAtoms).toBe(5);
    // Freshest (first MAX_ATOMS_PER_BUCKET rows) survive, not the tail.
    expect(bucket.atoms[0].text).toContain("did-0");
    expect(bucket.atoms.at(-1)?.text).toContain(`did-${MAX_ATOMS_PER_BUCKET - 1}`);
  });

  it("reports zero truncation for a bucket under the cap", () => {
    const buckets = bucketAtoms([
      row("s1", "u1", [{ what_agent_did: "a", what_user_wanted: "b", agent_complied: false }]),
      row("s2", "u1", [{ what_agent_did: "a", what_user_wanted: "b", agent_complied: false }]),
    ]);
    expect(buckets[0].truncatedAtoms).toBe(0);
  });
});

describe("cosine", () => {
  it("is 1 for identical and 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("returns 0 for a zero vector instead of NaN", () => {
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
});

describe("findDuplicate", () => {
  const existing = [existingScenario({ id: 7, title: "keeps asking questions", embedding: [1, 0] })];

  it("matches a near-identical title embedding", () => {
    expect(findDuplicate("keeps asking things", [0.99, 0.01], existing)?.id).toBe(7);
  });

  it("does not match a distant one", () => {
    expect(findDuplicate("totally different pattern", [0, 1], existing)).toBeNull();
  });

  // Defect 2: without EMBEDDINGS_API_KEY every embedding is always null, so
  // the old rule "no embedding on the candidate -> never match" meant
  // dedup NEVER fired and agent_scenarios grew every run. A candidate with
  // no embedding must still match an existing row by exact normalized title.
  it("falls back to an exact normalized-title match when the candidate has no embedding", () => {
    expect(findDuplicate("Keeps Asking Questions", null, existing)?.id).toBe(7);
    expect(findDuplicate("  keeps   asking questions  ", null, existing)?.id).toBe(7);
  });

  it("fallback does not match a different title", () => {
    expect(findDuplicate("uses stock photos", null, existing)).toBeNull();
  });

  it("falls back to title match when the EXISTING row has no embedding (candidate does)", () => {
    const noEmbeddingRow = [existingScenario({ id: 9, title: "uses stock photos", embedding: null })];
    expect(findDuplicate("uses stock photos", [1, 0], noEmbeddingRow)?.id).toBe(9);
  });

  it("matches regardless of state — state-based skip/merge is the caller's job", () => {
    const terminal = [existingScenario({ id: 3, title: "rejected pattern", state: "rejected", embedding: [1, 0] })];
    expect(findDuplicate("rejected pattern", [1, 0], terminal)?.id).toBe(3);
  });

  it("uses the documented distance threshold", () => {
    expect(SCENARIO_DEDUP_MAX_DISTANCE).toBe(0.15);
  });

  // Defect 2: when both sides have an embedding, the old code `continue`d
  // straight past the title check. An embedding-model swap between runs (or
  // a corrupt/truncated stored vector) can leave two rows with an IDENTICAL
  // normalized title but a cosine distance above the threshold — that is
  // still a guaranteed duplicate and must merge, not insert a new row.
  it("matches on exact title even when both sides have a (mismatched) embedding", () => {
    const rows = [existingScenario({ id: 11, title: "keeps asking questions", embedding: [1, 0] })];
    // Same title, but the embedding is orthogonal — far past maxDistance.
    expect(findDuplicate("keeps asking questions", [0, 1], rows)?.id).toBe(11);
  });
});

describe("mergeSessionIds", () => {
  it("unions without duplicates and keeps order stable", () => {
    expect(mergeSessionIds(["s1", "s2"], ["s2", "s3"])).toEqual(["s1", "s2", "s3"]);
  });
});

describe("confirmationsOf", () => {
  it("counts DISTINCT session ids, not atoms", () => {
    // Three complaints from the same session must count as ONE confirmation —
    // this is the invariant the whole review-trigger threshold rests on.
    expect(confirmationsOf(["s1", "s1", "s1"])).toBe(1);
    expect(confirmationsOf(["s1", "s2", "s1", "s3"])).toBe(3);
  });
});

describe("extractScenarios", () => {
  it("returns only scenarios whose session_ids exist among the atoms", async () => {
    const model = objectModel([
      {
        scenarios: [
          { kind: "correction", title: "starts with questions", recipe: "show a draft first", session_ids: ["s1", "s2"] },
          { kind: "workflow", title: "hallucinated session", recipe: "x", session_ids: ["nope"] },
        ],
      },
    ]);
    const out = await extractScenarios(model, [
      { sessionId: "s1", kind: "correction", text: "a" },
      { sessionId: "s2", kind: "correction", text: "b" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].session_ids).toEqual(["s1", "s2"]);
  });

  it("scrubs PII out of title and recipe", async () => {
    const model = objectModel([
      {
        scenarios: [
          {
            kind: "preference",
            title: "wants updates at john@example.com",
            recipe: "email john@example.com the summary",
            session_ids: ["s1", "s2"],
          },
        ],
      },
    ]);
    const out = await extractScenarios(model, [
      { sessionId: "s1", kind: "preference", text: "a" },
      { sessionId: "s2", kind: "preference", text: "b" },
    ]);
    expect(out[0].title).not.toContain("john@example.com");
    expect(out[0].recipe).not.toContain("john@example.com");
  });

  it("drops a scenario left with fewer than two known session ids after filtering", async () => {
    const model = objectModel([
      {
        scenarios: [
          { kind: "error", title: "only one real session", recipe: "r", session_ids: ["s1", "nope"] },
        ],
      },
    ]);
    const out = await extractScenarios(model, [{ sessionId: "s1", kind: "error", text: "a" }]);
    expect(out).toHaveLength(0);
  });
});
