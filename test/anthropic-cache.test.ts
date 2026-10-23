import { describe, expect, it } from "vitest";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, type ModelMessage } from "ai";
import {
  cachedSystemPrompt,
  markCacheBreakpoint,
  usesAnthropicPromptCache,
} from "../src/ai/anthropicCache.js";

type WireMessage = { role: string; cache_control?: unknown; content?: unknown };

// Runs the REAL OpenRouter provider against a stub fetch and returns the
// messages it put on the wire, so the test pins what Anthropic receives.
async function wireMessages(messages: ModelMessage[]): Promise<WireMessage[]> {
  let body: { messages: WireMessage[] } | undefined;
  const openrouter = createOpenRouter({
    apiKey: "test",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "x",
          model: "anthropic/claude-haiku-5.5",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  await generateText({
    model: openrouter("anthropic/claude-haiku-5.5"),
    instructions: cachedSystemPrompt("SYSTEM"),
    messages,
  });
  return body!.messages;
}

const CANVAS: ModelMessage = { role: "user", content: "<canvas_context>changes every request</canvas_context>" };

const toolLoopHistory: ModelMessage[] = [
  { role: "user", content: "open the site" },
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "a", toolName: "browse_open", input: {} },
      { type: "tool-call", toolCallId: "b", toolName: "browse_snapshot", input: {} },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "a", toolName: "browse_open", output: { type: "text", value: "opened" } },
      { type: "tool-result", toolCallId: "b", toolName: "browse_snapshot", output: { type: "text", value: "snapshot" } },
    ],
  },
];

function breakpoints(messages: WireMessage[]): number {
  return JSON.stringify(messages).split('"cache_control"').length - 1;
}

describe("Anthropic cache breakpoints", () => {
  it("opts in only anthropic/ ids", () => {
    expect(usesAnthropicPromptCache("anthropic/claude-haiku-5.5")).toBe(true);
    expect(usesAnthropicPromptCache("deepseek/deepseek-v4.1-flash")).toBe(false);
  });

  it("marks the system prompt and the last history message, never canvas_context", async () => {
    const wire = await wireMessages([...markCacheBreakpoint(toolLoopHistory), CANVAS]);
    expect(wire.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool", "user"]);
    expect(JSON.stringify(wire[0])).toContain('"cache_control":{"type":"ephemeral"}');
    // Parallel tool results become separate wire messages: only the LAST one
    // is marked, so the total stays within Anthropic's limit of four.
    expect(wire[3].cache_control).toBeUndefined();
    expect(wire[4].cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(wire[5])).not.toContain("cache_control");
    expect(breakpoints(wire)).toBe(2);
  });

  it("marks a trailing user message on its text part", async () => {
    const wire = await wireMessages(markCacheBreakpoint([{ role: "user", content: "hello" }]));
    expect(JSON.stringify(wire[1])).toContain('"cache_control":{"type":"ephemeral"}');
    expect(breakpoints(wire)).toBe(2);
  });

  it("keeps existing openrouter options and does not mutate the input", () => {
    const history: ModelMessage[] = [
      { role: "assistant", content: "hi", providerOptions: { openrouter: { reasoning_details: [] } } },
    ];
    const [marked] = markCacheBreakpoint(history);
    expect(marked.providerOptions).toEqual({
      openrouter: { reasoning_details: [], cacheControl: { type: "ephemeral" } },
    });
    expect(history[0].providerOptions).toEqual({ openrouter: { reasoning_details: [] } });
  });

  it("returns an empty history unchanged", () => {
    expect(markCacheBreakpoint([])).toEqual([]);
  });
});
