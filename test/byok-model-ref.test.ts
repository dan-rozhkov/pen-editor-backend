import { describe, expect, it } from "vitest";
import {
  bareModelId,
  isByokProvider,
  parseModelRef,
  providerHandlesToolResultImages,
} from "../src/ai/modelRef.js";
import { modelSupportsVision } from "../src/ai/vision-messages.js";
import { makeConfig } from "./helpers.js";

describe("byok/ model refs", () => {
  it.each([
    ["byok/gpt-4o", "gpt-4o"],
    ["byok/meta-llama/llama-4", "meta-llama/llama-4"],
    ["byok/openai/gpt-4o:extended", "openai/gpt-4o:extended"],
  ])("parses %s", (ref, modelId) => {
    expect(parseModelRef(ref)).toEqual({ provider: "byok", modelId });
  });

  it("does not strip the byok/ prefix (round trip)", () => {
    expect(bareModelId("byok/meta-llama/llama-4")).toBe("byok/meta-llama/llama-4");
  });

  it("does not treat a lookalike as byok", () => {
    expect(parseModelRef("byokx/foo").provider).toBe("openrouter");
  });

  it("identifies the provider and never promises tool-result images", () => {
    expect(isByokProvider("byok")).toBe(true);
    expect(isByokProvider("opencode")).toBe(false);
    expect(providerHandlesToolResultImages(parseModelRef("byok/gpt-4o"))).toBe(false);
  });

  it("reports no vision for a byok model", () => {
    expect(modelSupportsVision(makeConfig(), "byok/gpt-4o")).toBe(false);
  });
});
