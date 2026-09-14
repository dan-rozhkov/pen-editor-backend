import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { makeConfig } from "./helpers.js";

// The second dimension of applyVisionPreprocessing's decision: a provider
// whose AI SDK integration cannot carry an image found inside a TOOL-RESULT
// part, and JSON.stringifies it into tool-message text instead. No shipped
// provider does that today (OpenRouter is the only one, and it promotes the
// part to a real image_url), but @ai-sdk/deepseek really did — every
// get_screenshot result reached the model as megabytes of base64 "text" it
// could not use, silently. That is why the axis exists and why it is tested
// here with the axis itself mocked: the branch must stay correct for the
// next integration that behaves that way, and there is no config that can
// reach it otherwise.
vi.mock("../src/ai/modelRef.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/modelRef.js")>()),
  providerHandlesToolResultImages: () => false,
}));

vi.mock("../src/services/vision.js", () => ({
  describeImage: vi.fn(),
  peekCachedDescriptionByKey: vi.fn(() => undefined),
  peekCachedFailureByKey: vi.fn(() => undefined),
  visionCacheKey: (image: string) => `key:${image}`,
  isVisionConfigured: (config: { VISION_MODEL: string }) =>
    config.VISION_MODEL.trim().length > 0,
}));

import { describeImage } from "../src/services/vision.js";
import { applyVisionPreprocessing } from "../src/ai/vision-messages.js";

// Vision-capable, unlisted id — modelSupportsVision() assumes vision for any
// id it doesn't recognize, which isolates this test to the provider axis.
const VISION_MODEL_ID = "vendor/vision-model";

function screenshotToolMessage(): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "get_screenshot",
        output: {
          type: "content",
          value: [{ type: "image-data", data: "AAAA", mediaType: "image/png" }],
        },
      },
    ],
  };
}

afterEach(() => {
  vi.mocked(describeImage).mockReset();
});

describe("applyVisionPreprocessing with a provider that cannot carry tool-result images", () => {
  it("converts ONLY the tool-result image, leaving a user-attached image native", async () => {
    vi.mocked(describeImage).mockResolvedValue({
      ok: true,
      text: "A settings screen with three toggles.",
    });
    const config = makeConfig({
      CHAT_MODEL: VISION_MODEL_ID,
      CHAT_MODEL_SUPPORTS_VISION: undefined,
    });
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", image: "https://example.com/a.png", mediaType: "image/png" },
        ],
      },
      screenshotToolMessage(),
    ];

    const result = await applyVisionPreprocessing(messages, {
      config,
      modelId: VISION_MODEL_ID,
      chatModelRef: config.CHAT_MODEL,
    });

    // The user-attached image survives untouched — the model reads it natively.
    expect(result[0]).toEqual(messages[0]);

    const toolPart = (result[1] as { content: { output: { type: string; value: string } }[] })
      .content[0];
    expect(toolPart.output).toEqual({
      type: "text",
      value: expect.stringContaining("A settings screen with three toggles."),
    });
    expect(describeImage).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("image-data");
  });

  it("never leaks the raw image as text when no VISION_MODEL is configured", async () => {
    vi.mocked(describeImage).mockResolvedValue({
      ok: false,
      text: "Vision is not configured on this server (VISION_MODEL is empty).",
    });
    const config = makeConfig({
      CHAT_MODEL: VISION_MODEL_ID,
      CHAT_MODEL_SUPPORTS_VISION: undefined,
      VISION_MODEL: "",
    });

    const result = await applyVisionPreprocessing([screenshotToolMessage()], {
      config,
      modelId: VISION_MODEL_ID,
      chatModelRef: config.CHAT_MODEL,
    });

    const toolPart = (result[0] as { content: { output: { type: string; value: string } }[] })
      .content[0];
    expect(toolPart.output.type).toBe("text");
    expect(toolPart.output.value).toContain("Vision is not configured");
    expect(toolPart.output.value).not.toContain("AAAA");
    expect(JSON.stringify(result)).not.toContain("image-data");
  });
});
