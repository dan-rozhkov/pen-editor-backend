// Shared LLM + MCP mocks for tests that drive the real chat turn
// (`/api/chat` through buildApp(), or prepareChatTurn directly).
//
// HOISTING CONTRACT — read before adding imports here. `vi.mock` calls are
// hoisted above every import in a test file, so a factory cannot close over
// a statically imported binding. Instead each test file writes:
//
//   vi.mock("../src/ai/provider.js", async (importOriginal) =>
//     (await import("./chatMocks.js")).mockProviderModule(await importOriginal()));
//   vi.mock("../src/ai/mcp.js", async () =>
//     (await import("./chatMocks.js")).mockMcpModule());
//
// and imports `chatMocks` from this file normally — the factory's dynamic
// import and the file's static import resolve to the SAME module instance
// (one module graph per test file), so setting `chatMocks.model` in a test
// is what the mocked createModel returns. The path passed to vi.mock must
// stay a literal in the test file itself: vitest resolves it relative to
// the file that calls vi.mock.
//
// Because this module is imported from INSIDE the provider.js / mcp.js mock
// factories, it must never import src/ at runtime (type-only imports are
// fine) — importing src/app.js here would re-enter the very module whose
// mock is still being built. Server/HTTP mechanics live in chatHarness.ts.
import { vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

// Per-test-file mutable state behind the mocked createModel/getMCPTools.
// Module state is per file (vitest isolates each test file's module graph),
// so two files never see each other's model.
export const chatMocks = {
  model: undefined as unknown,
  mcpTools: {} as Record<string, unknown>,
  // Every options object getMCPTools was called with, in order — lets a test
  // assert on what reached it (e.g. a mobbinAccessToken threaded from a
  // request header) without replacing the whole mock.
  mcpToolCalls: [] as Array<{ mobbinAccessToken?: string; modelSupportsVision?: boolean } | undefined>,
};

// Only createModel is faked — bareModelId, parseModelRef, isOpenCodeProvider
// (and anything else the module exports) must stay the REAL implementation:
// src/ai/chatTurn.ts calls bareModelId on every prepareChatTurn() run and the
// chat route's opencode-key-required check depends on the parsers.
export function mockProviderModule<T extends object>(actual: T): T {
  return { ...actual, createModel: vi.fn(() => chatMocks.model) };
}

// The Mobbin client cache hands out a lease per turn; prepareChatTurn and the
// chat route both call attachMobbinRelease/releaseMCPTools, so a mock of this
// module must declare them or the route 500s on an undefined call.
export function mockMcpModule() {
  return {
    getMCPTools: vi.fn(
      async (_config: unknown, opts?: { mobbinAccessToken?: string; modelSupportsVision?: boolean }) => {
        chatMocks.mcpToolCalls.push(opts);
        return chatMocks.mcpTools;
      },
    ),
    closeAllMCPClients: vi.fn(async () => {}),
    attachMobbinRelease: vi.fn(),
    releaseMCPTools: vi.fn(),
  };
}

export const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

type Usage = Extract<LanguageModelV3StreamPart, { type: "finish" }>["usage"];

export function textStreamChunks(text: string, usage: Usage = USAGE): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ];
}

export function toolCallStreamChunks(
  toolName: string,
  input: Record<string, unknown>,
  usage: Usage = USAGE,
): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
  ];
}

// A model whose every doStream call replays the same scripted chunks.
export function mockModel(chunks: LanguageModelV3StreamPart[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks, chunkDelayInMs: null }),
    }),
  });
}

// A multi-step model: the Nth doStream call (one per agent step inside a
// single streamText turn) replays the Nth script; the last one repeats.
export function sequenceModel(...steps: LanguageModelV3StreamPart[][]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const chunks = steps[Math.min(call, steps.length - 1)];
      call += 1;
      return { stream: simulateReadableStream({ chunks, chunkDelayInMs: null }) };
    },
  });
}

// The default every chat test starts from: a model that just says "ok", no
// MCP tools.
export function resetChatMocks(): void {
  chatMocks.model = mockModel(textStreamChunks("ok"));
  chatMocks.mcpTools = {};
  chatMocks.mcpToolCalls = [];
}

export function userMessage(text: string): Record<string, unknown> {
  return { id: "m1", role: "user", parts: [{ type: "text", text }] };
}
