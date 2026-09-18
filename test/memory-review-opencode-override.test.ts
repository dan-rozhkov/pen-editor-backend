import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import type { ModelMessage, ToolSet } from "ai";
import { makeConfig } from "./helpers.js";
import { penTools } from "../src/ai/tools.js";
import type { MemoryStore } from "../src/ai/memory/store.js";

// Regression (defect 2): the background review is a helper role, like
// ANALYSIS_MODEL/VISION_MODEL/STRUCTURED_MODEL — per
// docs/specs/2026-09-18-opencode-byok-design.md, helper roles deliberately
// stay on OpenRouter and never spend the user's own OpenCode key.
// `maybeRunReview` used to pass the CHAT turn's `modelOverride` straight
// into `createModel(config, input.modelOverride)` with no `opencodeApiKey`
// — but `MaybeRunReviewInput` never carries that key at all (see
// runReviewSafe's only caller, src/routes/chat.ts, which never threads
// `opencodeApiKey` into the review). createModel throws for any
// OpenCode-provider ref with no key (src/ai/provider.ts), and
// `runReviewSafe` only `console.error`s a rejected promise — so every user
// who picked an OpenCode model in the composer silently lost the entire
// memory/skill review loop on every turn.
//
// createModel itself is mocked (as in test/memory-review.test.ts) so this
// test never depends on real network access or a real OpenRouter/OpenCode
// call — only on WHICH model reference maybeRunReview resolves to pass it.
const capturedCreateModelCalls: Array<{
  modelOverride: string | undefined;
}> = [];

const holders = vi.hoisted(() => ({ model: undefined as unknown }));

vi.mock("../src/ai/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/provider.js")>();
  return {
    ...actual,
    createModel: vi.fn((_config: unknown, modelOverride?: string) => {
      capturedCreateModelCalls.push({ modelOverride });
      return holders.model;
    }),
  };
});

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function reviewModel(result: LanguageModelV3GenerateResult): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => result,
  });
}

function textResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: USAGE,
    warnings: [],
  };
}

function fakeStore(memoryReviewDue: boolean): MemoryStore {
  return {
    loadSnapshot: vi.fn(async () => ({ memory: [], user: [] })),
    applyOperations: vi.fn(async () => ({
      ok: true as const,
      entries: ["x"],
      usage: { current: 1, limit: 1375 },
    })),
    bumpCounters: vi.fn(async () => ({
      turnsSinceMemory: memoryReviewDue ? 10 : 1,
      stepsSinceSkill: 3,
      memoryReviewDue,
    })),
    writeAudit: vi.fn(),
    close: vi.fn(),
  } as unknown as MemoryStore;
}

const MESSAGES: ModelMessage[] = [{ role: "user", content: "remember I like short answers" }];

function input(overrides: Record<string, unknown> = {}) {
  return {
    config: makeConfig({ MEMORY_ENABLED: true }),
    store: fakeStore(true),
    userId: "u1",
    system: "SYSTEM PROMPT",
    turnTools: penTools as unknown as ToolSet,
    modelMessages: MESSAGES,
    assistantText: "Understood.",
    stepCount: 3,
    turnComplete: true,
    ...overrides,
  };
}

describe("maybeRunReview with a user-picked OpenCode modelOverride", () => {
  it("does not pass the OpenCode ref to createModel and does not throw — it falls back to CHAT_MODEL", async () => {
    capturedCreateModelCalls.length = 0;
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));

    const outcome = await maybeRunReview(
      input({ modelOverride: "opencode-go/glm-5.3-flash" }),
    );

    // Without the fix, createModel(config, "opencode-go/glm-5.3-flash")
    // throws synchronously inside the try block (no opencodeApiKey ever
    // reaches maybeRunReview), which the outer catch reports as "failed" —
    // that is the silent-death symptom the bug report describes.
    expect(outcome).toBe("ran");
    expect(capturedCreateModelCalls).toHaveLength(1);
    // The OpenCode ref must NOT have reached createModel — it must have
    // been swapped for `undefined` (createModel's own "use config.CHAT_MODEL"
    // default), not for the literal opencode string.
    expect(capturedCreateModelCalls[0].modelOverride).toBeUndefined();
  });

  it("still passes an OpenRouter modelOverride through unchanged", async () => {
    capturedCreateModelCalls.length = 0;
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));

    const outcome = await maybeRunReview(
      input({ modelOverride: "google/gemini-2.5-flash" }),
    );

    expect(outcome).toBe("ran");
    expect(capturedCreateModelCalls).toHaveLength(1);
    expect(capturedCreateModelCalls[0].modelOverride).toBe("google/gemini-2.5-flash");
  });
});
