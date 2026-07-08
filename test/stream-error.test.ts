import { describe, expect, it } from "vitest";
import { InvalidToolInputError, NoSuchToolError } from "ai";
import { streamErrorMessage } from "../src/routes/chat.js";

// The chat route pipes the UI message stream with onError: streamErrorMessage.
// Without it, pipeUIMessageStreamToResponse masks every error to a generic
// "An error occurred.", hiding actionable tool-input validation guidance (like
// batch_design's 25-operation limit message) from the model.

describe("streamErrorMessage", () => {
  it("surfaces the message for invalid tool input (e.g. the batch_design limit)", () => {
    const err = new InvalidToolInputError({
      toolName: "batch_design",
      toolInput: "{...}",
      cause: new Error(
        "Too many operations (30). Maximum is 25. Split the work into multiple sequential batch_design calls.",
      ),
    });
    const message = streamErrorMessage(err);
    expect(message).toBe(err.message);
    expect(message).toContain("Too many operations (30)");
    expect(message).toContain("Maximum is 25");
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
