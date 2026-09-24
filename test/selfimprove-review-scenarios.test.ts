// Task 6: wiring `agent_scenarios` evidence into `maybeRunReview`. Reuses
// two existing conventions rather than inventing new ones:
//   - the doGenerate-capture rig from test/reviewFakes.ts (generateText,
//     not doStream),
//   - the real-Postgres-engine PGlite harness + row seeding (`seedScenario`)
//     shared with test/scenario-feed-pglite.test.ts, because fetchDueScenarios /
//     markScenariosOffered / settleScenarios run real SQL
//     (`ANY($1::bigint[])`, a CASE-guarded jsonb write) that a hand-rolled
//     fake would risk getting subtly wrong.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import {
  fakeReviewCounterStore,
  generateCaptureRig,
  reviewInput,
  seedScenario,
  textResult,
  neverRespondingGenerateModel,
  throwingGenerateModel,
  toolCallResult,
  type ScenarioSeed,
} from "./reviewFakes.js";
import type { MemoryStore } from "../src/ai/memory/store.js";
import type { TraceQueryable } from "../src/tracing/traceStore.js";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";
import { MAX_SCENARIOS_PER_REVIEW } from "../src/ai/selfimprove/scenarioFeed.js";

const holders = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("../src/ai/provider.js", () => ({
  createModel: vi.fn(() => holders.model),
}));

// maybeRunReview drives generateText (doGenerate) — see test/reviewFakes.ts.
// Only the store's counter half is faked; scenario reads/writes below run
// against the real PGlite-backed `auditDb`, exactly like maybeRunReview does
// in production (memory's and skills' counters live in agent_memory /
// agent_review_state; scenarios live in the separate agent_scenarios table).
const { capturedCalls, reviewModel, multiStepReviewModel } = generateCaptureRig();
const fakeStore = fakeReviewCounterStore;

const MESSAGES: ModelMessage[] = [{ role: "user", content: "make the header tighter" }];

let harness: PgliteHarness;

beforeAll(async () => {
  harness = await createPgliteHarness(["agent_scenarios"]);
});
afterEach(async () => {
  await harness.reset();
  capturedCalls.length = 0;
});
afterAll(async () => {
  await harness.close();
});

// Same row seeding as test/scenario-feed-pglite.test.ts, with this file's
// defaults: a user-scope row already over the confirmation threshold.
function seed(row: Partial<ScenarioSeed> = {}): Promise<number> {
  return seedScenario(harness.db, {
    scope: "user",
    title: "ONLY-IN-USER-MESSAGE-MARKER",
    confirmations: 5,
    sessionIds: ["s1", "s2", "s3"],
    ...row,
  });
}

async function scenarioRow(
  id: number,
): Promise<{ state: string; offer_count: number; distilled_into: unknown }> {
  const { rows } = await harness.db.query(
    "SELECT state, offer_count, distilled_into FROM agent_scenarios WHERE id = $1",
    [id],
  );
  return rows[0] as { state: string; offer_count: number; distilled_into: unknown };
}

function input(overrides: Record<string, unknown> = {}) {
  return reviewInput(
    { store: fakeStore(), modelMessages: MESSAGES, assistantText: "Done.", auditDb: harness.db },
    overrides,
  );
}

function lastAuditCall(store: MemoryStore): { action: string; payload: Record<string, unknown> } {
  const calls = (store.writeAudit as unknown as { mock: { calls: Array<[Record<string, unknown>]> } })
    .mock.calls.map(([e]) => e)
    .filter((e) => e.subsystem === "review");
  return calls.at(-1) as { action: string; payload: Record<string, unknown> };
}

describe("maybeRunReview — scenario evidence", () => {
  it("makes a review due on a confirmed scenario even with cold counters (memoryReviewDue: false, skillReviewDue: false)", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));
    await seed({ confirmations: 5 });
    const store = fakeStore({ memoryReviewDue: false, skillReviewDue: false });

    expect(await maybeRunReview(input({ store }))).toBe("ran");
    expect(capturedCalls).toHaveLength(1);
  });

  it("puts the scenario block in the user message and never in the system prompt", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));
    await seed({ confirmations: 5, title: "ONLY-IN-USER-MESSAGE-MARKER" });
    const store = fakeStore({ memoryReviewDue: false, skillReviewDue: false });

    expect(await maybeRunReview(input({ store }))).toBe("ran");

    // The AI SDK's LanguageModelV3 doGenerate has no separate `system` field
    // — the provider spec folds the turn's system prompt into `prompt[0]`
    // as a `{ role: "system" }` message (same assertion shape as
    // memory-review.test.ts). That first message must stay byte-identical
    // to what was passed in — the whole point of the split is keeping the
    // provider's prefix cache warm.
    const prompt = capturedCalls[0].prompt as Array<{ role: string; content: unknown }>;
    expect(prompt[0].role).toBe("system");
    expect(prompt[0].content).toBe("SYSTEM PROMPT");

    const lastUser = prompt.at(-1);
    expect(lastUser?.role).toBe("user");
    expect(JSON.stringify(lastUser)).toContain("ONLY-IN-USER-MESSAGE-MARKER");
  });

  it("distills the offered scenario when the run wrote something (called the memory tool), and records which tool", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    const id = await seed({ confirmations: 5 });
    holders.model = multiStepReviewModel([
      toolCallResult("memory", {
        target: "user",
        operations: [{ action: "add", content: "Prefers a draft before committing" }],
      }),
      textResult("Saved."),
    ]);
    const store = fakeStore({ memoryReviewDue: false, skillReviewDue: false });

    expect(await maybeRunReview(input({ store }))).toBe("ran");
    const row = await scenarioRow(id);
    expect(row.state).toBe("distilled");
    // Defect 4: distilled_into used to be a fixed literal that said WHO
    // distilled the scenario but not WHAT it turned into. It must now carry
    // the write tool(s) the run actually called, not just the constant.
    expect(row.distilled_into).toMatchObject({ via: "background_review", tools: ["memory"] });
  });

  it("gets the current memory snapshot in the review prompt even when ONLY the scenario triggered the review (both counters cold)", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));
    await seed({ confirmations: 5 });
    const store = fakeStore({ memoryReviewDue: false, skillReviewDue: false });
    // Defect 1: the fallback prompt (picked because both real due-flags are
    // false) is MEMORY_REVIEW_PROMPT whenever MEMORY_ENABLED is on — it
    // tells the model to save via the memory tool. Without the snapshot the
    // model has no list of what's already saved to check against first, and
    // will happily write a duplicate of an existing entry.
    store.loadSnapshot = vi.fn(async () => ({
      memory: ["EXISTING-MEMORY-ENTRY-MARKER: prefers dark mode"],
      user: [],
    }));

    expect(await maybeRunReview(input({ store }))).toBe("ran");

    const prompt = capturedCalls[0].prompt as Array<{ role: string; content: unknown }>;
    const lastUser = prompt.at(-1);
    const serialized = JSON.stringify(lastUser);
    expect(serialized).toContain("Current memory contents");
    expect(serialized).toContain("EXISTING-MEMORY-ENTRY-MARKER");
  });

  it("rejects a scenario the second time a review declines it", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    // Already offered once (offer_count: 1) and left standing as 'offered'.
    const id = await seed({ confirmations: 5, state: "offered", offerCount: 1 });
    holders.model = reviewModel(textResult("Nothing to save."));
    const store = fakeStore({ memoryReviewDue: false, skillReviewDue: false });

    expect(await maybeRunReview(input({ store }))).toBe("ran");
    const row = await scenarioRow(id);
    expect(row.state).toBe("rejected");
    expect(row.offer_count).toBe(2);

    // A rejected scenario is never offered again.
    holders.model = reviewModel(textResult("Nothing to save."));
    capturedCalls.length = 0;
    expect(await maybeRunReview(input({ store: fakeStore({ memoryReviewDue: false }) }))).toBe(
      "not-due",
    );
  });

  it("never puts a global-scope scenario's text in the review prompt — only this user's own rows are fed to review", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));
    await seed({ scope: "global", confirmations: 9, title: "GLOBAL-SCOPE-MARKER-DO-NOT-LEAK" });
    const store = fakeStore({ memoryReviewDue: false, skillReviewDue: false });

    // Cold on everything: a real (non-global) scenario has to be the ONLY
    // due-source here, or the run would be "not-due" and never call the
    // model at all — proving the global row genuinely never reaches review.
    expect(await maybeRunReview(input({ store }))).toBe("not-due");
    expect(capturedCalls).toHaveLength(0);
  });

  it("records the offered scenario ids in the audit payload", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    const id = await seed({ confirmations: 5 });
    holders.model = reviewModel(textResult("Nothing to save."));
    const store = fakeStore({ memoryReviewDue: false, skillReviewDue: false });

    expect(await maybeRunReview(input({ store }))).toBe("ran");
    expect(lastAuditCall(store).payload.scenario_ids).toEqual([id]);
  });

  it("records scenario_ids as an empty array, not omitted, on a counter-triggered review with nothing due", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));
    // Both populations (with evidence / without) must be countable from a
    // single query over this column — the empty-array run must still carry
    // the key, not omit it.
    const store = fakeStore({ memoryReviewDue: true });

    expect(await maybeRunReview(input({ store }))).toBe("ran");
    expect(lastAuditCall(store).payload.scenario_ids).toEqual([]);
  });

  it("offers at most MAX_SCENARIOS_PER_REVIEW even when more are due", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    // Defect 3: global-scope rows are never fed into a review's prompt
    // anymore (see fetchDueScenarios' doc comment) — seed the user's OWN
    // rows so this test still exercises the cap, not the scope filter.
    await seed({ scope: "user", confirmations: 6, title: "low" });
    await seed({ scope: "user", confirmations: 9, title: "high" });
    await seed({ scope: "user", confirmations: 8, title: "mid" });
    holders.model = reviewModel(textResult("Nothing to save."));
    const store = fakeStore({ memoryReviewDue: false, skillReviewDue: false });

    expect(await maybeRunReview(input({ store }))).toBe("ran");
    const ids = lastAuditCall(store).payload.scenario_ids as unknown[];
    expect(ids).toHaveLength(MAX_SCENARIOS_PER_REVIEW);
  });

  it("marks scenarios offered BEFORE generateText — a failed/timed-out run still counts as an offer", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    const id = await seed({ confirmations: 5 });
    holders.model = throwingGenerateModel();
    const store = fakeStore({ memoryReviewDue: false, skillReviewDue: false });

    // The run itself fails — but the offer must already be recorded, or a
    // provider that reliably throws on this prompt would re-offer the same
    // scenario forever instead of retiring it after two silent offers.
    expect(await maybeRunReview(input({ store }))).toBe("disabled");
    const row = await scenarioRow(id);
    expect(row.state).toBe("offered");
    expect(row.offer_count).toBe(1);
  });

  it("records scenario_ids in the audit payload on a run that throws — run.ts's evidence classification depends on it", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    const id = await seed({ confirmations: 5 });
    holders.model = throwingGenerateModel();
    const store = fakeStore({ memoryReviewDue: false, skillReviewDue: false });

    expect(await maybeRunReview(input({ store }))).toBe("disabled");
    const call = lastAuditCall(store);
    expect(call.action).toBe("failed");
    expect(call.payload.scenario_ids).toEqual([id]);
  });

  it("records scenario_ids in the audit payload on a run that times out", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    const id = await seed({ confirmations: 5 });
    holders.model = neverRespondingGenerateModel();
    const store = fakeStore({ memoryReviewDue: false, skillReviewDue: false });

    expect(await maybeRunReview(input({ store, reviewTimeoutMs: 20 }))).toBe("timed-out");
    const call = lastAuditCall(store);
    expect(call.action).toBe("timed-out");
    expect(call.payload.scenario_ids).toEqual([id]);
  }, 10_000);

  it("does not let a failure reading scenarios cost a review the counters already earned", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));
    const store = fakeStore({ memoryReviewDue: true });
    const brokenAuditDb: TraceQueryable = {
      query: vi.fn(async () => {
        throw new Error("agent_scenarios is unreachable");
      }),
      end: vi.fn(),
    };

    // Cold on scenarios, but the memory counter alone is enough to be due.
    expect(await maybeRunReview(input({ store, auditDb: brokenAuditDb }))).toBe("ran");
    expect(lastAuditCall(store).payload.scenario_ids).toEqual([]);
  });

  it("does not let a failure writing (offering/settling) scenarios cost a review the counters already earned", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    await seed({ confirmations: 5 });
    holders.model = reviewModel(textResult("Nothing to save."));
    const store = fakeStore({ memoryReviewDue: true });
    // Reads succeed against the real harness; every write (markScenariosOffered,
    // settleScenarios — both UPDATEs) fails.
    const writeFailingDb: TraceQueryable = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.trim().toUpperCase().startsWith("UPDATE")) {
          throw new Error("agent_scenarios is read-only right now");
        }
        return harness.db.query(sql, params);
      },
      end: () => harness.db.end(),
    };

    expect(await maybeRunReview(input({ store, auditDb: writeFailingDb }))).toBe("ran");
    expect(lastAuditCall(store).action).toBe("nothing-saved");
  });
});
