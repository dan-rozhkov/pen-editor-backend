import { describe, expect, it } from "vitest";
import { penTools } from "../src/ai/tools.js";
import { assert } from "./helpers.js";

const schema = penTools.browse_act.inputSchema as unknown as {
  safeParse: (v: unknown) => { success: true; data: unknown } | { success: false; error: unknown };
};

function parse(input: unknown) {
  const result = schema.safeParse(input);
  expect(result.success).toBe(true);
  assert(result.success);
  return result.data;
}

describe("browse_act input from strict-mode (OpenAI) models", () => {
  it("folds `action` plus a one-entry `actions` copy into one call and drops placeholders", () => {
    // Captured from openai/gpt-6-luna on OpenRouter, 2026-10-14.
    const input = {
      action: "click",
      target: "",
      index: 7,
      snapshotId: "snap-1",
      element: "",
      text: "",
      amount: 0,
      key: "",
      ms: 0,
      actions: [{ action: "click", target: "", index: 7, element: "", text: "", amount: 0, key: "", ms: 0 }],
    };
    expect(parse(input)).toEqual({ action: "click", index: 7, snapshotId: "snap-1" });
  });

  it("keeps a multi-entry batch and drops the top-level single-action fields", () => {
    const input = {
      action: "click",
      target: "",
      snapshotId: "s",
      actions: [
        { action: "type", index: 3, text: "Paris", target: "", ms: 0 },
        { action: "press", index: 0, key: "Enter", target: "", element: "" },
      ],
    };
    expect(parse(input)).toEqual({
      snapshotId: "s",
      actions: [
        { action: "type", index: 3, text: "Paris" },
        { action: "press", index: 0, key: "Enter" },
      ],
    });
  });

  it("drops a placeholder index 0 next to an explicit target or with no snapshotId", () => {
    expect(parse({ action: "click", target: "Sign in", index: 0, snapshotId: "s" })).toEqual({
      action: "click",
      target: "Sign in",
      snapshotId: "s",
    });
    expect(parse({ action: "scroll", index: 0, snapshotId: "", amount: 2 })).toEqual({
      action: "scroll",
      amount: 2,
    });
  });

  it("drops the placeholder index 0 from a window scroll and from actions with no element", () => {
    // Captured from openai/gpt-6-luna: index 0 here scrolled element 0, not the page.
    expect(parse({ action: "scroll", index: 0, snapshotId: "s", amount: 2 })).toEqual({
      action: "scroll",
      snapshotId: "s",
      amount: 2,
    });
    expect(parse({ action: "back", index: 0, snapshotId: "s", amount: 1 })).toEqual({
      action: "back",
      snapshotId: "s",
      amount: 1,
    });
    expect(parse({ action: "wait", index: 4, snapshotId: "s", ms: 2000 })).toEqual({
      action: "wait",
      snapshotId: "s",
      ms: 2000,
    });
  });

  it("keeps a non-zero index on a scroll (scroll inside that element)", () => {
    const input = { action: "scroll", index: 12, snapshotId: "s" };
    expect(parse(input)).toEqual(input);
  });

  it("leaves an ordinary call unchanged, including a real index 0", () => {
    const input = { action: "click", index: 0, snapshotId: "s" };
    expect(parse(input)).toEqual(input);
  });

  it("still rejects a call with neither `action` nor `actions`", () => {
    expect(schema.safeParse({ target: "", actions: [] }).success).toBe(false);
  });
});
