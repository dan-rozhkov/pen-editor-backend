import { describe, expect, it } from "vitest";
import { InvalidToolInputError, NoSuchToolError } from "ai";
import { streamErrorMessage } from "../src/routes/chat.js";

// The chat route pipes the UI message stream with onError: streamErrorMessage.
// Without it, pipeUIMessageStreamToResponse masks every error to a generic
// "An error occurred.", hiding actionable tool-input validation guidance (like
// batch_design's embed-only guard message) from the model.

describe("streamErrorMessage", () => {
  it("surfaces the message for invalid tool input (e.g. the batch_design embed-only guard)", () => {
    const err = new InvalidToolInputError({
      toolName: "batch_design",
      toolInput: "{...}",
      cause: new Error(
        'Prototype/slides flow is embed-only: batch_design may not create a native "frame" node.',
      ),
    });
    const message = streamErrorMessage(err);
    expect(message).toBe(err.message);
    expect(message).toContain("embed-only");
    expect(message).toContain("frame");
  });

  it("surfaces the message for an unknown tool", () => {
    const err = new NoSuchToolError({ toolName: "made_up_tool" });
    expect(streamErrorMessage(err)).toBe(err.message);
  });

  it("masks arbitrary errors so server internals do not leak", () => {
    expect(streamErrorMessage(new Error("ECONNREFUSED 10.0.0.5:5432"))).toBe(
      "An error occurred.",
    );
    expect(streamErrorMessage("some string")).toBe("An error occurred.");
    expect(streamErrorMessage(undefined)).toBe("An error occurred.");
  });
});
