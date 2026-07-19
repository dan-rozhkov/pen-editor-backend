import { describe, expect, it } from "vitest";
import { resolveTaskPolicy } from "../src/ai/taskPolicy.js";

describe("resolveTaskPolicy", () => {
  it("resolves 'prototype' from the current slash command", () => {
    expect(
      resolveTaskPolicy({ messages: [], slashSkillName: "prototype" }),
    ).toBe("prototype");
  });

  it("resolves 'slides' from the current slash command", () => {
    expect(
      resolveTaskPolicy({ messages: [], slashSkillName: "slides" }),
    ).toBe("slides");
  });

  it("resolves 'native' for an unrelated or unknown slash command", () => {
    expect(
      resolveTaskPolicy({ messages: [], slashSkillName: "edits" }),
    ).toBe("native");
    expect(
      resolveTaskPolicy({ messages: [], slashSkillName: "polish" }),
    ).toBe("native");
  });

  it("resolves 'native' with no messages and no slash command", () => {
    expect(resolveTaskPolicy({ messages: [] })).toBe("native");
  });

  it("detects a load_skill(prototype) dynamic-tool part in history", () => {
    const messages = [
      {
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "load_skill",
            input: { name: "prototype" },
          },
        ],
      },
    ];
    expect(resolveTaskPolicy({ messages })).toBe("prototype");
  });

  it("detects a load_skill(slides) dynamic-tool part in history", () => {
    const messages = [
      {
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "load_skill",
            input: { name: "slides" },
          },
        ],
      },
    ];
    expect(resolveTaskPolicy({ messages })).toBe("slides");
  });

  it("detects a typed tool-load_skill part shape", () => {
    const messages = [
      {
        role: "assistant",
        parts: [{ type: "tool-load_skill", input: { name: "prototype" } }],
      },
    ];
    expect(resolveTaskPolicy({ messages })).toBe("prototype");
  });

  it("detects a legacy tool-invocation shape with args instead of input", () => {
    const messages = [
      {
        role: "assistant",
        parts: [
          {
            type: "tool-invocation",
            toolInvocation: {
              toolName: "load_skill",
              args: { name: "slides" },
            },
          },
        ],
      },
    ];
    expect(resolveTaskPolicy({ messages })).toBe("slides");
  });

  it("walks content[] as well as parts[]", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "dynamic-tool",
            toolName: "load_skill",
            input: { name: "prototype" },
          },
        ],
      },
    ];
    expect(resolveTaskPolicy({ messages })).toBe("prototype");
  });

  it("resolves 'native' when history has no load_skill(prototype|slides) call", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "load_skill",
            input: { name: "polish" },
          },
        ],
      },
    ];
    expect(resolveTaskPolicy({ messages })).toBe("native");
  });

  it("the LATEST load_skill call wins when both prototype and slides appear", () => {
    const messages = [
      {
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "load_skill",
            input: { name: "prototype" },
          },
        ],
      },
      {
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "load_skill",
            input: { name: "slides" },
          },
        ],
      },
    ];
    expect(resolveTaskPolicy({ messages })).toBe("slides");
  });

  it("the LATEST load_skill call wins the other direction too", () => {
    const messages = [
      {
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "load_skill",
            input: { name: "slides" },
          },
        ],
      },
      {
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "load_skill",
            input: { name: "prototype" },
          },
        ],
      },
    ];
    expect(resolveTaskPolicy({ messages })).toBe("prototype");
  });

  it("a current slash command wins over stale history (checked first)", () => {
    const messages = [
      {
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "load_skill",
            input: { name: "slides" },
          },
        ],
      },
    ];
    expect(
      resolveTaskPolicy({ messages, slashSkillName: "prototype" }),
    ).toBe("prototype");
  });
});
