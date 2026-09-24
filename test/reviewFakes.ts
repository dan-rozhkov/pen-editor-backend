// Fakes for the background self-improve review (`maybeRunReview`,
// src/ai/selfimprove/review.ts) and anything else driven by generateText.
//
// generateText calls the model's doGenerate, not doStream — the streaming
// seam in chatMocks.ts is only for streamText. This module imports no mocked
// `src/` module at runtime (provider.js stays untouched), so it is safe to
// import statically next to a `vi.mock("../src/ai/provider.js", ...)`.
import { vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import type { ModelMessage, ToolSet } from "ai";
import { penTools } from "../src/ai/tools.js";
import type { MemoryStore } from "../src/ai/memory/store.js";
import type { TraceQueryable } from "../src/tracing/traceStore.js";
import { makeConfig } from "./helpers.js";

export const GENERATE_USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

export function textResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: GENERATE_USAGE,
    warnings: [],
  };
}

export function toolCallResult(
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
    usage: GENERATE_USAGE,
    warnings: [],
  };
}

export interface CapturedGenerateCall {
  system?: unknown;
  prompt: unknown;
  tools: unknown;
}

// Records every doGenerate call into `captured` and answers with `results` in
// order, repeating the last one. A plain counter, not MockLanguageModelV3's
// array form: that form indexes by call count *after* pushing (1-based), so
// passing the array straight through would skip results[0].
export function capturingGenerateModel(
  captured: CapturedGenerateCall[],
  ...results: LanguageModelV3GenerateResult[]
): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options: { system?: unknown; prompt: unknown; tools?: unknown }) => {
      captured.push({ system: options.system, prompt: options.prompt, tools: options.tools });
      const result = results[Math.min(call, results.length - 1)];
      call += 1;
      return result;
    },
  });
}

// One capture list plus the two model shapes review tests use: a single
// canned answer, or a scripted multi-step run.
export function generateCaptureRig() {
  const capturedCalls: CapturedGenerateCall[] = [];
  return {
    capturedCalls,
    reviewModel: (result: LanguageModelV3GenerateResult) =>
      capturingGenerateModel(capturedCalls, result),
    multiStepReviewModel: (results: LanguageModelV3GenerateResult[]) =>
      capturingGenerateModel(capturedCalls, ...results),
  };
}

// A provider that fails outright on every call.
export function throwingGenerateModel(message = "provider exploded"): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error(message);
    },
  });
}

// A provider that never answers, but rejects once the caller's abortSignal
// fires — what a real provider's fetch does. A bare `new Promise(() => {})`
// would ignore the signal and hang the test instead of exercising a timeout.
export function neverRespondingGenerateModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: (options: { abortSignal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener("abort", () => {
          reject(options.abortSignal!.reason);
        });
      }),
  });
}

export interface ReviewDueFlags {
  memoryReviewDue?: boolean;
  skillReviewDue?: boolean;
}

// Only the counter half of MemoryStore is meaningful here: bumpCounters
// reports the due flags maybeRunReview gates on; everything else is a spy.
export function fakeReviewCounterStore(due: ReviewDueFlags = {}): MemoryStore {
  return {
    loadSnapshot: vi.fn(async () => ({ memory: [], user: [] })),
    applyOperations: vi.fn(async () => ({
      ok: true as const,
      entries: ["x"],
      usage: { current: 1, limit: 1375 },
    })),
    bumpCounters: vi.fn(async () => ({
      turnsSinceMemory: due.memoryReviewDue ? 10 : 1,
      stepsSinceSkill: due.skillReviewDue ? 20 : 1,
      memoryReviewDue: due.memoryReviewDue ?? false,
      skillReviewDue: due.skillReviewDue ?? false,
    })),
    writeAudit: vi.fn(),
    close: vi.fn(),
  } as unknown as MemoryStore;
}

// A complete maybeRunReview input: memory on, user "u1", the real penTools as
// the turn's tool set. `base` carries each file's own defaults, `overrides`
// the per-test tweaks.
export function reviewInput(
  base: { store: MemoryStore; modelMessages: ModelMessage[] } & Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    config: makeConfig({ MEMORY_ENABLED: true }),
    userId: "u1",
    system: "SYSTEM PROMPT",
    turnTools: penTools as unknown as ToolSet,
    assistantText: "Understood.",
    stepCount: 3,
    turnComplete: true,
    ...base,
    ...overrides,
  };
}

export interface ScenarioSeed {
  scope: "user" | "global";
  userId?: string | null;
  kind?: string;
  title?: string;
  recipe?: string;
  confirmations?: number;
  sessionIds?: string[];
  state?: string;
  offerCount?: number;
}

// Inserts one `agent_scenarios` row into a real (PGlite) database and returns
// its id. A user-scope row defaults to user "u1", a global one to no user.
export async function seedScenario(db: TraceQueryable, row: ScenarioSeed): Promise<number> {
  const { rows } = (await db.query(
    `INSERT INTO agent_scenarios
       (scope, user_id, kind, title, recipe, confirmations, session_ids, state, offer_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      row.scope,
      row.userId ?? (row.scope === "user" ? "u1" : null),
      row.kind ?? "correction",
      row.title ?? "starts with questions",
      row.recipe ?? "show a draft first",
      row.confirmations ?? 1,
      row.sessionIds ?? ["s1"],
      row.state ?? "open",
      row.offerCount ?? 0,
    ],
  )) as { rows: unknown[] };
  return Number((rows[0] as { id: number | string }).id);
}
