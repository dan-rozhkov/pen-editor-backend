import { describe, expect, it } from "vitest";
import { sanitizeMessagesForProvider } from "../src/routes/chat.js";

describe("sanitizeMessagesForProvider", () => {
  it("removes reasoning/thinking/redacted_thinking blocks from parts", () => {
    const { messages, removedReasoningParts } = sanitizeMessagesForProvider([
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "thinking out loud" },
          { type: "thinking", thinking: "hmm" },
          { type: "redacted_thinking", data: "xxx" },
          { type: "text", text: "final answer" },
        ],
      },
    ]);

    expect(removedReasoningParts).toBe(3);
    expect(messages[0].parts).toEqual([{ type: "text", text: "final answer" }]);
  });

  it("removes reasoning blocks from content arrays too", () => {
    const { messages, removedReasoningParts } = sanitizeMessagesForProvider([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "secret" },
          { type: "text", text: "visible" },
        ],
      },
    ]);

    expect(removedReasoningParts).toBe(1);
    expect(messages[0].content).toEqual([{ type: "text", text: "visible" }]);
  });

  it("strips providerMetadata and callProviderMetadata from remaining blocks", () => {
    const { messages } = sanitizeMessagesForProvider([
      {
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "hello",
            providerMetadata: { anthropic: { signature: "abc" } },
            callProviderMetadata: { foo: "bar" },
          },
        ],
      },
    ]);

    const part = (messages[0].parts as Array<Record<string, unknown>>)[0];
    expect(part).toEqual({ type: "text", text: "hello" });
    expect(part).not.toHaveProperty("providerMetadata");
    expect(part).not.toHaveProperty("callProviderMetadata");
  });

  it("counts removed reasoning parts across multiple messages", () => {
    const { removedReasoningParts } = sanitizeMessagesForProvider([
      { role: "assistant", parts: [{ type: "reasoning", text: "a" }] },
      { role: "assistant", parts: [{ type: "reasoning", text: "b" }] },
      { role: "user", parts: [{ type: "text", text: "c" }] },
    ]);
    expect(removedReasoningParts).toBe(2);
  });

  it("returns 0 removed parts when there is nothing to remove", () => {
    const { messages, removedReasoningParts } = sanitizeMessagesForProvider([
      { role: "user", parts: [{ type: "text", text: "hi" }] },
    ]);
    expect(removedReasoningParts).toBe(0);
    expect(messages[0].parts).toEqual([{ type: "text", text: "hi" }]);
  });

  it("does not break on messages without parts/content", () => {
    const input = [{ role: "user" }, { role: "system", id: "x" }];
    const { messages, removedReasoningParts } =
      sanitizeMessagesForProvider(input);
    expect(removedReasoningParts).toBe(0);
    expect(messages).toEqual(input);
  });

  it("leaves string content untouched", () => {
    const { messages } = sanitizeMessagesForProvider([
      { role: "user", content: "plain string" },
    ]);
    expect(messages[0].content).toBe("plain string");
  });

  it("keeps non-object blocks as-is", () => {
    const { messages } = sanitizeMessagesForProvider([
      { role: "user", parts: ["raw-string", null, 42] },
    ]);
    expect(messages[0].parts).toEqual(["raw-string", null, 42]);
  });

  it("does not mutate the input messages", () => {
    const original = [
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "x" },
          { type: "text", text: "y", providerMetadata: { a: 1 } },
        ],
      },
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    sanitizeMessagesForProvider(original);
    expect(original).toEqual(snapshot);
  });
});
