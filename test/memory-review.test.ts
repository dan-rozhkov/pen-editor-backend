import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import type { ModelMessage, ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { makeConfig } from "./helpers.js";
import { DEFAULT_MEMORY_REVIEW_INTERVAL } from "../src/config.js";
import { MEMORY_REVIEW_PROMPT } from "../src/ai/memory/prompts.js";
import { penTools } from "../src/ai/tools.js";
import type { MemoryStore } from "../src/ai/memory/store.js";

const holders = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("../src/ai/provider.js", () => ({
  createModel: vi.fn(() => holders.model),
}));

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const capturedCalls: Array<{ prompt: unknown; tools: unknown }> = [];

// generateText (used by maybeRunReview) calls doGenerate, not doStream — the
// streaming seam other tests use (e.g. chat-route.test.ts) is only for
// streamText. Follows the same mock shape as test/showcase-runner.test.ts,
// which also drives generateText.
function reviewModel(result: LanguageModelV3GenerateResult): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options: { prompt: unknown; tools?: unknown }) => {
      capturedCalls.push({ prompt: options.prompt, tools: options.tools });
      return result;
    },
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

function toolCallResult(
  toolName: string,
  input: Record<string, unknown>,
): LanguageModelV3GenerateResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: `call-${toolName}-${Math.random()}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: USAGE,
    warnings: [],
  };
}

// Same "1-based index" gotcha as test/showcase-runner.test.ts's mockModel —
// MockLanguageModelV3's array form indexes by call count *after* pushing, so
// a plain counter is used instead of passing the array straight through.
function multiStepReviewModel(results: LanguageModelV3GenerateResult[]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options: { prompt: unknown; tools?: unknown }) => {
      capturedCalls.push({ prompt: options.prompt, tools: options.tools });
      const result = results[Math.min(call, results.length - 1)];
      call += 1;
      return result;
    },
  });
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

const MESSAGES: ModelMessage[] = [{ role: "user", content: "I only ever want short answers" }];

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

describe("maybeRunReview", () => {
  it("does nothing without a userId, without a store, or with MEMORY_ENABLED off", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));

    expect(await maybeRunReview(input({ userId: undefined }))).toBe("disabled");
    expect(await maybeRunReview(input({ store: null }))).toBe("disabled");
    expect(
      await maybeRunReview(input({ config: makeConfig({ MEMORY_ENABLED: false }) })),
    ).toBe("disabled");
    expect(capturedCalls).toHaveLength(0);
  });

  it("bumps the counters but does not run the review before the threshold", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));
    const store = fakeStore(false);

    expect(await maybeRunReview(input({ store }))).toBe("not-due");
    expect(store.bumpCounters).toHaveBeenCalledWith({
      userId: "u1",
      turns: 1,
      steps: 3,
      // The configured threshold is passed through verbatim — the review
      // owns no copy of it.
      memoryInterval: DEFAULT_MEMORY_REVIEW_INTERVAL,
    });
    expect(capturedCalls).toHaveLength(0);
  });

  it("replays the conversation with the review prompt and offers the memory tool plus stubs", async () => {
    capturedCalls.length = 0;
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));

    expect(await maybeRunReview(input())).toBe("ran");
    expect(capturedCalls).toHaveLength(1);

    const prompt = capturedCalls[0].prompt as Array<{
      role: string;
      content: string | Array<{ type: string; text?: string }>;
    }>;
    expect(prompt[0].role).toBe("system");
    expect(JSON.stringify(prompt)).toContain("I only ever want short answers");
    expect(JSON.stringify(prompt)).toContain("Understood.");
    const lastContent = prompt[prompt.length - 1].content;
    const lastText =
      typeof lastContent === "string"
        ? lastContent
        : lastContent.map((p) => p.text ?? "").join("");
    expect(lastText).toContain(MEMORY_REVIEW_PROMPT);

    // The memory tool is real; every other name (get_editor_state,
    // batch_design, ...) is a stub so the model can't hit NoSuchToolError
    // when the (unchanged, byte-for-byte) system prompt's Mandatory-flow
    // text tells it to call one of them first.
    const tools = capturedCalls[0].tools as Array<{ name: string }>;
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("memory");
    expect(toolNames).toContain("get_editor_state");
    expect(toolNames.length).toBeGreaterThan(1);
  });

  it("does not throw when the model reaches for a non-memory tool — it gets a stub result and can continue", async () => {
    capturedCalls.length = 0;
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = multiStepReviewModel([
      // get_variables takes no input fields, unlike e.g. get_editor_state
      // (which requires `include_schema`) — using it keeps this test about
      // the stub wiring, not an unrelated schema-validation failure.
      toolCallResult("get_variables", {}),
      textResult("Nothing to save."),
    ]);

    await expect(maybeRunReview(input())).resolves.toBe("ran");
    // Two model calls: the tool-call step, then the follow-up after the stub
    // result was fed back — proof the SDK didn't throw NoSuchToolError.
    expect(capturedCalls).toHaveLength(2);
    expect(JSON.stringify(capturedCalls[1].prompt)).toContain(
      "not available during a background self-improvement review",
    );
  });

  // Instrumentation, and the reason for it: a review that runs and declines
  // leaves no trace anywhere in production (ENABLE_AGENT_LOGGING is off
  // there), so "the review never fired" and "it fired and saved nothing"
  // were indistinguishable — and they call for opposite fixes.
  it("audits every review run, including one that saves nothing", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));
    const store = fakeStore(true);

    expect(await maybeRunReview(input({ store }))).toBe("ran");
    expect(store.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        origin: "background_review",
        subsystem: "review",
        action: "nothing-saved",
      }),
    );
  });

  it("labels a review that wrote something 'saved', and records which tools it reached for", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = multiStepReviewModel([
      toolCallResult("memory", {
        target: "user",
        operations: [{ action: "add", content: "Prefers short answers" }],
      }),
      textResult("Saved."),
    ]);
    const store = fakeStore(true);

    expect(await maybeRunReview(input({ store }))).toBe("ran");
    const entry = (store.writeAudit as unknown as { mock: { calls: Array<[Record<string, unknown>]> } })
      .mock.calls.map(([e]) => e)
      .find((e) => e.subsystem === "review");
    expect(entry).toMatchObject({ action: "saved" });
    // toolsCalled carries EVERY tool, not just the writing ones: a review
    // burning its steps on stubbed pen tools looks identical to one that
    // genuinely had nothing to save, and only this field separates them.
    expect((entry!.payload as { toolsCalled: string[] }).toolsCalled).toContain("memory");
    expect(entry!.payload).toMatchObject({ memoryDue: true });
  });

  // A failed audit insert is instrumentation failing, not the review failing
  // — reporting "disabled" here would mislabel a run that did its job.
  it("still reports 'ran' when the audit insert itself fails", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));
    const store = fakeStore(true);
    (store.writeAudit as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("audit table is gone"),
    );

    expect(await maybeRunReview(input({ store }))).toBe("ran");
  });

  it("skips running a review on a mid-turn continuation request, but still bumps steps (turns: 0)", async () => {
    // steps_since_skill must accumulate on every request, mid-turn included
    // — see the steps_since_skill fix. `turns: 0` keeps turns_since_memory
    // itself from moving on a continuation, which isn't a completed user
    // turn. No generateText call happens either way.
    capturedCalls.length = 0;
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));
    const store = fakeStore(true);

    expect(await maybeRunReview(input({ store, turnComplete: false }))).toBe("mid-turn");
    expect(store.bumpCounters).toHaveBeenCalledTimes(1);
    expect(store.bumpCounters).toHaveBeenCalledWith(
      expect.objectContaining({ turns: 0 }),
    );
    expect(capturedCalls).toHaveLength(0);
  });

  it("re-reads the memory snapshot fresh and appends it to the review's user message, not the system prompt", async () => {
    capturedCalls.length = 0;
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));
    const store = fakeStore(true);
    // Simulate a foreground write during THIS turn that the turn-start
    // system-prompt snapshot (input().system, fixed at "SYSTEM PROMPT")
    // cannot reflect.
    (store.loadSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: ["User prefers concise responses"],
      memory: [],
    });

    expect(await maybeRunReview(input({ store }))).toBe("ran");
    expect(store.loadSnapshot).toHaveBeenCalledWith("u1");

    const prompt = capturedCalls[0].prompt as Array<{
      role: string;
      content: string | Array<{ type: string; text?: string }>;
    }>;
    // The system message must stay exactly "SYSTEM PROMPT" — untouched, for
    // the provider prefix cache — while the fresh snapshot shows up in the
    // trailing user message instead.
    expect(prompt[0].content).toBe("SYSTEM PROMPT");
    const lastContent = prompt[prompt.length - 1].content;
    const lastText =
      typeof lastContent === "string"
        ? lastContent
        : lastContent.map((p) => p.text ?? "").join("");
    expect(lastText).toContain("User prefers concise responses");
  });

  it("swallows a review failure so it can never affect the user response", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    const store = {
      bumpCounters: vi.fn(async () => {
        throw new Error("db down");
      }),
    } as unknown as MemoryStore;
    await expect(maybeRunReview(input({ store }))).resolves.toBe("disabled");
  });

  // Finding 1: the review's stub set must cover the FULL turn tool set
  // prepareChatTurn assembles — not just penTools — since the shared system
  // prompt can steer the model toward load_skill or an MCP tool just as
  // easily as a client-executed pen tool.
  describe("stubs the full turn tool set, not just penTools", () => {
    const executeTracker = vi.fn(async () => "real style guide result");

    function turnToolsWithExtras(): ToolSet {
      return {
        // Simulates getSkillTools()'s load_skill — client-executed, no
        // server-side execute.
        load_skill: tool({
          description: "Load a skill",
          inputSchema: z.object({ name: z.string() }),
        }),
        // Simulates an MCP tool discovered for this turn — also no execute.
        refero_search_screens: tool({
          description: "Search screens",
          inputSchema: z.object({ query: z.string() }),
        }),
        // Simulates a real backend tool (get_guidelines/get_style_guide*
        // shape): HAS a server-side execute and must run for real, unstubbed.
        get_style_guide: tool({
          description: "Real backend tool",
          inputSchema: z.object({}),
          execute: executeTracker,
        }),
      } as unknown as ToolSet;
    }

    it("does not throw when the model calls a non-penTools tool (load_skill) — it resolves to the stub result", async () => {
      capturedCalls.length = 0;
      const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
      holders.model = multiStepReviewModel([
        toolCallResult("load_skill", { name: "prototype" }),
        textResult("Nothing to save."),
      ]);

      await expect(
        maybeRunReview(input({ turnTools: turnToolsWithExtras() })),
      ).resolves.toBe("ran");
      // Two model calls: the load_skill call, then the follow-up fed the
      // stub result — proof the SDK didn't throw NoSuchToolError for a tool
      // that isn't in penTools at all.
      expect(capturedCalls).toHaveLength(2);
      expect(JSON.stringify(capturedCalls[1].prompt)).toContain(
        "not available during a background self-improvement review",
      );
    });

    it("passes tools with a real server-side execute through unstubbed — the real execute runs, not the stub", async () => {
      capturedCalls.length = 0;
      executeTracker.mockClear();
      const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
      holders.model = multiStepReviewModel([
        toolCallResult("get_style_guide", {}),
        textResult("Nothing to save."),
      ]);

      await expect(
        maybeRunReview(input({ turnTools: turnToolsWithExtras() })),
      ).resolves.toBe("ran");

      // The real execute ran (not skipped/stubbed)...
      expect(executeTracker).toHaveBeenCalledTimes(1);
      // ...and its actual return value — not the stub's "not available"
      // string — is what the model saw in the follow-up step.
      expect(JSON.stringify(capturedCalls[1].prompt)).toContain(
        "real style guide result",
      );
      expect(JSON.stringify(capturedCalls[1].prompt)).not.toContain(
        "not available during a background self-improvement review",
      );
    });
  });

  // Finding 6: a stuck/slow provider must not hold the transcript in memory
  // forever — the run has a wall-clock cap.
  it("times out rather than hanging forever when the model never responds", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = new MockLanguageModelV3({
      // A real provider's underlying fetch would reject once the abortSignal
      // fires; this simulates that (a bare `new Promise(() => {})` would
      // ignore the signal entirely and hang the test instead of exercising
      // the timeout path).
      doGenerate: (options: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () => {
            reject(options.abortSignal!.reason);
          });
        }),
    });

    const store = fakeStore(true);
    const outcome = await maybeRunReview(input({ store, reviewTimeoutMs: 20 }));
    expect(outcome).toBe("timed-out");

    // Found live on 2026-08-15: a production session reset BOTH counters and
    // then produced no audit row for six minutes, because the row was only
    // written on the completed path. That is indistinguishable from "the
    // review never fired" — the exact confusion this row exists to end — and
    // it hides the failures most worth knowing about.
    expect(store.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ subsystem: "review", action: "timed-out" }),
    );
  }, 10_000);

  it("audits a review that throws, and reports the error on the row", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("provider exploded");
      },
    });
    const store = fakeStore(true);

    expect(await maybeRunReview(input({ store }))).toBe("disabled");
    const entry = (store.writeAudit as unknown as { mock: { calls: Array<[Record<string, unknown>]> } })
      .mock.calls.map(([e]) => e)
      .find((e) => e.subsystem === "review");
    expect(entry).toMatchObject({ action: "failed" });
    expect(String((entry!.payload as { error: unknown }).error)).toContain("provider exploded");
  });

  // A throw BEFORE generateText is not a review that failed — it is one that
  // never started. Recording it as a failure would corrupt the very ratio the
  // row exists to measure.
  it("writes no review row when the run dies before it ever reaches the model", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));
    const store = fakeStore(true);
    (store.bumpCounters as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("postgres is down"),
    );

    expect(await maybeRunReview(input({ store }))).toBe("disabled");
    expect(store.writeAudit).not.toHaveBeenCalled();
  });
});
