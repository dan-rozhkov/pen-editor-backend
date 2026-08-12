import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { makeConfig } from "./helpers.js";
import { createMemoryStore, type MemoryStore } from "../src/ai/memory/store.js";
import { createLearnedSkillStore, type LearnedSkillStore } from "../src/ai/skills/learnedStore.js";
import { MEMORY_REVIEW_PROMPT } from "../src/ai/memory/prompts.js";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";

const holders = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("../src/ai/provider.js", () => ({
  createModel: vi.fn(() => holders.model),
}));

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const capturedCalls: Array<{ prompt: unknown; tools: unknown }> = [];

function reviewModel(text = "Nothing to save."): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options: { prompt: unknown; tools?: unknown }) => {
      capturedCalls.push({ prompt: options.prompt, tools: options.tools });
      const result: LanguageModelV3GenerateResult = {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [],
      };
      return result;
    },
  });
}

function lastPromptText(): string {
  const call = capturedCalls.at(-1) as { prompt: Array<Record<string, unknown>> };
  return JSON.stringify(call.prompt);
}

function lastToolNames(): string[] {
  const call = capturedCalls.at(-1) as { tools?: Array<{ name: string }> };
  return (call.tools ?? []).map((t) => t.name).sort();
}

let harness: PgliteHarness;
let memoryStore: MemoryStore;
let learnedSkillStore: LearnedSkillStore;

beforeAll(async () => {
  harness = await createPgliteHarness([
    "agent_memory",
    "agent_review_state",
    "agent_selfimprove_audit",
    "agent_skills",
  ]);
  memoryStore = createMemoryStore(
    makeConfig({ TRACE_DATABASE_URL: "postgres://unused" }),
    harness.pool,
  )!;
  learnedSkillStore = createLearnedSkillStore(
    makeConfig({ TRACE_DATABASE_URL: "postgres://unused" }),
    harness.pool,
  )!;
});

afterEach(async () => {
  await harness.reset();
  capturedCalls.length = 0;
});

afterAll(async () => {
  await harness.close();
});

function input(overrides: Record<string, unknown> = {}) {
  return {
    config: makeConfig({ SELF_SKILLS_ENABLED: true, TRACE_DATABASE_URL: "postgres://unused" }),
    store: memoryStore,
    userId: "u1",
    system: "SYSTEM PROMPT",
    turnTools: {},
    modelMessages: [{ role: "user" as const, content: "make the header tighter" }],
    assistantText: "Done.",
    stepCount: 5,
    turnComplete: true,
    learnedSkillStore,
    auditDb: harness.db,
    ...overrides,
  };
}

describe("maybeRunReview — skill branch", () => {
  it("does not fire before the 15-step threshold", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel();

    expect(await maybeRunReview(input({ stepCount: 10 }))).toBe("not-due");
    expect(await maybeRunReview(input({ stepCount: 4 }))).toBe("not-due");
    expect(capturedCalls).toHaveLength(0);
  });

  it("fires the skill-only prompt exactly on the request that crosses 15 accumulated steps, and resets the counter", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel();

    expect(await maybeRunReview(input({ stepCount: 10 }))).toBe("not-due");
    expect(capturedCalls).toHaveLength(0);
    expect(await maybeRunReview(input({ stepCount: 5 }))).toBe("ran");
    expect(capturedCalls).toHaveLength(1);

    expect(lastPromptText()).toContain("Preference order — a strong bias against creating new skills");
    // Memory is off in this config (MEMORY_ENABLED defaults false), so the
    // memory review prompt text must not leak in.
    expect(lastPromptText()).not.toContain(MEMORY_REVIEW_PROMPT.slice(0, 40));

    const state = await harness.pool.query(
      "SELECT steps_since_skill FROM agent_review_state WHERE user_id = $1",
      ["u1"],
    );
    expect((state.rows[0] as { steps_since_skill: number }).steps_since_skill).toBe(0);
  });

  it("accumulates steps_since_skill across mid-turn continuations, and only runs the review on the completed request", async () => {
    // Finding 2: a single user message can span several POST /api/chat
    // round-trips (one per client-executed tool call the browser has to run
    // and resend) — only the LAST of those is turnComplete. The old code
    // returned "mid-turn" before ever calling bumpCounters, so
    // steps_since_skill only ever accumulated the final request's own step
    // count. It must accumulate every request's steps, mid-turn included,
    // and only evaluate/act on due-ness once the turn actually completes.
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel();

    expect(await maybeRunReview(input({ stepCount: 4, turnComplete: false }))).toBe("mid-turn");
    expect(await maybeRunReview(input({ stepCount: 4, turnComplete: false }))).toBe("mid-turn");
    expect(await maybeRunReview(input({ stepCount: 4, turnComplete: false }))).toBe("mid-turn");
    // No review ran on any mid-turn request, even though 12 accumulated
    // steps would already be most of the way to the 15-step threshold.
    expect(capturedCalls).toHaveLength(0);

    const midState = await harness.pool.query(
      "SELECT steps_since_skill FROM agent_review_state WHERE user_id = $1",
      ["u1"],
    );
    expect((midState.rows[0] as { steps_since_skill: number }).steps_since_skill).toBe(12);

    // The completed request's own 3 steps push the total to 15 — crossing
    // the threshold — and this is the only request where a review runs.
    expect(await maybeRunReview(input({ stepCount: 3, turnComplete: true }))).toBe("ran");
    expect(capturedCalls).toHaveLength(1);

    const finalState = await harness.pool.query(
      "SELECT steps_since_skill FROM agent_review_state WHERE user_id = $1",
      ["u1"],
    );
    expect((finalState.rows[0] as { steps_since_skill: number }).steps_since_skill).toBe(0);
  });

  it("whitelists exactly the memory and skill tools when both subsystems are enabled", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel();

    const outcome = await maybeRunReview(
      input({
        config: makeConfig({
          SELF_SKILLS_ENABLED: true,
          MEMORY_ENABLED: true,
          TRACE_DATABASE_URL: "postgres://unused",
        }),
        stepCount: 15,
      }),
    );
    expect(outcome).toBe("ran");
    expect(lastToolNames()).toEqual(["memory", "skill_manage", "skill_view"]);
  });

  it("uses the combined prompt when both counters cross their threshold in one request", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel();
    const config = makeConfig({
      SELF_SKILLS_ENABLED: true,
      MEMORY_ENABLED: true,
      TRACE_DATABASE_URL: "postgres://unused",
    });

    // Pre-seed both counters one short of their threshold.
    await harness.pool.query(
      "INSERT INTO agent_review_state (user_id, turns_since_memory, steps_since_skill) VALUES ($1, 9, 14)",
      ["u1"],
    );

    const outcome = await maybeRunReview(input({ config, stepCount: 1 }));
    expect(outcome).toBe("ran");
    expect(capturedCalls).toHaveLength(1);
    const text = lastPromptText();
    expect(text).toContain("Memory captures");
    expect(text).toContain("Preference order — a strong bias against creating new skills");
  });

  it("still bumps the step counter but never runs a skill review when SELF_SKILLS_ENABLED is off", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel();
    const config = makeConfig({
      SELF_SKILLS_ENABLED: false,
      MEMORY_ENABLED: true,
      TRACE_DATABASE_URL: "postgres://unused",
    });

    // Enough steps to cross what SKILL_REVIEW_INTERVAL would be, but the
    // flag is off — memory alone is not due yet (needs 10 turns), so no
    // review fires at all.
    const outcome = await maybeRunReview(input({ config, stepCount: 30 }));
    expect(outcome).toBe("not-due");
    expect(capturedCalls).toHaveLength(0);

    // The column still accumulated — flipping the flag on later resumes
    // from here rather than starting a fresh count.
    const state = await harness.pool.query(
      "SELECT steps_since_skill FROM agent_review_state WHERE user_id = $1",
      ["u1"],
    );
    expect((state.rows[0] as { steps_since_skill: number }).steps_since_skill).toBe(30);
  });

  it("omits skill_manage/skill_view even when a memory-only review fires, if SELF_SKILLS_ENABLED is off", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel();
    const config = makeConfig({
      SELF_SKILLS_ENABLED: false,
      MEMORY_ENABLED: true,
      TRACE_DATABASE_URL: "postgres://unused",
    });
    await harness.pool.query(
      "INSERT INTO agent_review_state (user_id, turns_since_memory) VALUES ($1, 9)",
      ["u1"],
    );

    const outcome = await maybeRunReview(input({ config, stepCount: 1 }));
    expect(outcome).toBe("ran");
    expect(lastToolNames()).toEqual(["memory"]);
  });

  it("reuses the turn's exact system string (warm prefix cache)", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel();

    await maybeRunReview(input({ stepCount: 15 }));
    const call = capturedCalls.at(-1) as { prompt: Array<{ role: string; content: unknown }> };
    const system = call.prompt.find((m) => m.role === "system");
    expect(system?.content).toBe("SYSTEM PROMPT");
  });

  it("does not run the skill tools when learnedSkillStore/auditDb are not wired, even with the flag on — but still stubs `memory` since MEMORY_ENABLED is off here", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel();

    const outcome = await maybeRunReview(
      input({ stepCount: 15, learnedSkillStore: null, auditDb: null }),
    );
    expect(outcome).toBe("ran");
    // input()'s default config has SELF_SKILLS_ENABLED true, MEMORY_ENABLED
    // false — a skill-only review in that shape gets a `memory` stub (see
    // finding 1) so a model that reaches for it despite the prompt's
    // conditioned wording gets a harmless result instead of NoSuchToolError.
    expect(lastToolNames()).toEqual(["memory"]);
  });

  it("swallows a failing review (broken db) so it can never affect the user response", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel();
    const brokenStore = {
      bumpCounters: vi.fn(async () => {
        throw new Error("db down");
      }),
    } as unknown as MemoryStore;

    await expect(maybeRunReview(input({ store: brokenStore, stepCount: 15 }))).resolves.toBe(
      "disabled",
    );
    expect(capturedCalls).toHaveLength(0);
  });

  it("still returns disabled with both flags off, without touching the store", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel();
    const spyStore = { ...memoryStore, bumpCounters: vi.fn() } as unknown as MemoryStore;

    const outcome = await maybeRunReview(
      input({
        config: makeConfig({ SELF_SKILLS_ENABLED: false, MEMORY_ENABLED: false }),
        store: spyStore,
        stepCount: 30,
      }),
    );
    expect(outcome).toBe("disabled");
    expect(spyStore.bumpCounters).not.toHaveBeenCalled();
  });
});
