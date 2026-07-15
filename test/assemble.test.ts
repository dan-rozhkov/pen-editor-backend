import { describe, expect, it } from "vitest";
import {
  assembleSession,
  renderSessionText,
  type RawTraceDbRow,
} from "../src/analysis/assemble.js";

function row(overrides: Partial<RawTraceDbRow>): RawTraceDbRow {
  return {
    id: 1,
    session_id: "tab-1-1",
    created_at: new Date("2026-07-15T10:00:00Z"),
    model: "google/gemini-2.5-flash",
    agent_mode: "edits",
    payload: { messages: [], steps: [] },
    stream_error: null,
    input_tokens: 10,
    output_tokens: 5,
    ...overrides,
  };
}

const userMsg = { role: "user", parts: [{ type: "text", text: "make a card" }] };
const toolErrorMsg = {
  role: "assistant",
  parts: [
    {
      type: "tool-batch_design",
      toolCallId: "c1",
      state: "output-available",
      input: { operations: [] },
      output: '{"error":"Too many operations (30). Maximum is 25."}',
    },
  ],
};

describe("assembleSession", () => {
  it("uses the longest message history and merges stream errors from all rows", () => {
    const rows: RawTraceDbRow[] = [
      row({ id: 1, payload: { messages: [userMsg], steps: [{}] } }),
      row({
        id: 2,
        created_at: new Date("2026-07-15T10:01:00Z"),
        payload: { messages: [userMsg, toolErrorMsg, userMsg], steps: [{}, {}] },
        stream_error: "An error occurred.",
        input_tokens: 20,
        output_tokens: 7,
      }),
    ];
    const s = assembleSession(rows);
    expect(s.messages).toHaveLength(3);
    expect(s.requestCount).toBe(2);
    expect(s.streamErrors).toEqual(["An error occurred."]);
    expect(s.stepCount).toBe(3);
    expect(s.totalInputTokens).toBe(30);
    expect(s.totalOutputTokens).toBe(12);
    expect(s.startedAt.toISOString()).toBe("2026-07-15T10:00:00.000Z");
    expect(s.endedAt.toISOString()).toBe("2026-07-15T10:01:00.000Z");
  });
});

describe("renderSessionText", () => {
  it("renders roles, text, tool calls with errors, and stream errors; omits images", () => {
    const s = assembleSession([
      row({
        payload: {
          messages: [
            userMsg,
            { role: "user", parts: [{ type: "file", mediaType: "image/png", url: "data:..." }] },
            toolErrorMsg,
          ],
          steps: [],
        },
        stream_error: "boom",
      }),
    ]);
    const text = renderSessionText(s);
    expect(text).toContain("user: make a card");
    expect(text).toContain("[image omitted]");
    expect(text).toContain("[tool batch_design]");
    expect(text).toContain("Too many operations");
    expect(text).toContain("Stream errors:\nboom");
    expect(text).not.toContain("data:");
  });

  it("renders output-error tool parts with their errorText", () => {
    const erroredMsg = {
      role: "assistant",
      parts: [
        {
          type: "tool-generate_image",
          toolCallId: "c2",
          state: "output-error",
          input: { prompt: "a cat" },
          errorText: "Image generation timed out",
        },
      ],
    };
    const s = assembleSession([
      row({ payload: { messages: [erroredMsg], steps: [] } }),
    ]);
    const text = renderSessionText(s);
    expect(text).toContain("[tool generate_image]");
    expect(text).toContain('input: {"prompt":"a cat"}');
    expect(text).toContain("ERROR: Image generation timed out");
  });

  it("renders errored parts with no output or errorText as unknown error", () => {
    const erroredMsg = {
      role: "assistant",
      parts: [
        {
          type: "tool-get_guidelines",
          toolCallId: "c3",
          state: "output-error",
          input: { topic: "layout" },
        },
      ],
    };
    const s = assembleSession([
      row({ payload: { messages: [erroredMsg], steps: [] } }),
    ]);
    const text = renderSessionText(s);
    expect(text).toContain("[tool get_guidelines]");
    expect(text).toContain('input: {"topic":"layout"}');
    expect(text).toContain("ERROR: unknown error");
  });

  it("renders the final turn's text and tool calls from the longest row's steps", () => {
    const s = assembleSession([
      row({
        payload: {
          messages: [userMsg],
          steps: [
            {
              text: "Created a hero section.",
              toolCalls: [{ toolName: "batch_design", args: { operations: [] } }],
              toolResults: [{ toolName: "batch_design", result: { ok: true } }],
            },
            {
              text: "",
              toolCalls: [{ toolName: "generate_image", args: { prompt: "a cat" } }],
              toolResults: [
                { toolName: "generate_image", result: { error: "timed out" } },
              ],
            },
          ],
        },
      }),
    ]);
    const text = renderSessionText(s);
    expect(text).toContain("Final turn:");
    expect(text).toContain("assistant: Created a hero section.");
    expect(text).toContain("[tool batch_design]");
    expect(text).toContain('input: {"operations":[]}');
    expect(text).toContain('output: {"ok":true}');
    expect(text).toContain("[tool generate_image]");
    expect(text).toContain("ERROR: timed out");
  });

  it("omits the final-turn section when steps have no text or tool calls", () => {
    const s = assembleSession([row({ payload: { messages: [userMsg], steps: [{}] } })]);
    const text = renderSessionText(s);
    expect(text).not.toContain("Final turn:");
  });

  it("truncates to maxChars keeping head and tail", () => {
    const long = {
      role: "user",
      parts: [{ type: "text", text: "x".repeat(2000) }],
    };
    const s = assembleSession([
      row({ payload: { messages: Array.from({ length: 100 }, () => long), steps: [] } }),
    ]);
    const text = renderSessionText(s, 10_000);
    expect(text.length).toBeLessThanOrEqual(10_100);
    expect(text).toContain("[...truncated...]");
  });
});
