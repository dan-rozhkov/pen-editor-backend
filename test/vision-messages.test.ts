import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { makeConfig } from "./helpers.js";

vi.mock("../src/services/vision.js", () => ({
  describeImage: vi.fn(),
  isVisionConfigured: (config: { VISION_MODEL: string }) =>
    config.VISION_MODEL.trim().length > 0,
}));

import { describeImage } from "../src/services/vision.js";
import {
  applyVisionPreprocessing,
  modelSupportsVision,
  MAX_DESCRIBED_IMAGES_PER_TURN,
} from "../src/ai/vision-messages.js";

// makeConfig()'s default OPENROUTER_MODEL (deepseek/deepseek-v4-pro) is
// vision-less per DEFAULT_MODELS in src/config.ts — used throughout as the
// "blind model" fixture. gemini-2.5-flash is vision-capable.
const BLIND_MODEL = "deepseek/deepseek-v4-pro";
const SEEING_MODEL = "google/gemini-2.5-flash";

afterEach(() => {
  vi.mocked(describeImage).mockReset();
});

describe("modelSupportsVision", () => {
  it("reflects DEFAULT_MODELS metadata", () => {
    const config = makeConfig();
    expect(modelSupportsVision(config, BLIND_MODEL)).toBe(false);
    expect(modelSupportsVision(config, SEEING_MODEL)).toBe(true);
  });

  it("assumes vision-capable for an unlisted model, matching getModels' convention", () => {
    const config = makeConfig();
    expect(modelSupportsVision(config, "some/unknown-model")).toBe(true);
  });
});

describe("applyVisionPreprocessing", () => {
  it("returns the array unchanged (same content) for a vision-capable model", async () => {
    const config = makeConfig();
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", image: "https://example.com/a.png", mediaType: "image/png" },
        ],
      },
    ];

    const result = await applyVisionPreprocessing(messages, { config, modelId: SEEING_MODEL });

    expect(result).toEqual(messages);
    expect(describeImage).not.toHaveBeenCalled();
  });

  it("replaces a user image part with a text description for a vision-less model", async () => {
    vi.mocked(describeImage).mockResolvedValue({ ok: true, text: "A blue login screen." });
    const config = makeConfig();
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", image: "https://example.com/a.png", mediaType: "image/png" },
        ],
      },
    ];

    const result = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });

    const content = (result[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "look at this" });
    expect(content[1]).toMatchObject({ type: "text" });
    expect((content[1] as { text: string }).text).toContain("A blue login screen.");

    // No part anywhere in the rewritten messages may still be an image part.
    const flat = JSON.stringify(result);
    expect(flat).not.toContain('"type":"image"');
  });

  it("replaces an image-mediaType file part too — the shape the composer sends", async () => {
    // The frontend attaches images as `file` UI parts; convertToModelMessages
    // normally turns those into image parts, but a file part that survives as
    // one must not slip past this pass either.
    vi.mocked(describeImage).mockResolvedValue({ ok: true, text: "A dark dashboard." });
    const config = makeConfig();
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: "data:image/png;base64,AAAA",
            mediaType: "image/png",
          },
          { type: "file", data: "data:application/pdf;base64,AAAA", mediaType: "application/pdf" },
        ],
      },
    ];

    const result = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });

    const content = (result[0] as { content: unknown[] }).content;
    expect(content[0]).toMatchObject({ type: "text" });
    expect((content[0] as { text: string }).text).toContain("A dark dashboard.");
    // A non-image file part is none of this pass's business.
    expect(content[1]).toEqual(messages[0].content[1]);
    expect(describeImage).toHaveBeenCalledOnce();
  });

  it("replaces a get_screenshot tool result carrying imageData with a text description", async () => {
    vi.mocked(describeImage).mockResolvedValue({ ok: true, text: "A settings screen with three toggles." });
    const config = makeConfig();
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "get_screenshot",
            output: {
              type: "text",
              value: JSON.stringify({ imageData: "data:image/png;base64,AAAA" }),
            },
          },
        ],
      },
    ];

    const result = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });

    const content = (result[0] as { content: unknown[] }).content;
    const part = content[0] as { output: { type: string; value: string } };
    expect(part.output.type).toBe("text");
    expect(part.output.value).toContain("A settings screen with three toggles.");
    expect(part.output.value).not.toContain("data:image");
  });

  it("replaces the promoted image part a screenshot arrives as after toModelOutput", async () => {
    // get_screenshot's toModelOutput turns the handler's JSON string into a
    // real image part so a vision-capable model can see it. For a blind model
    // that part is exactly what must not survive.
    vi.mocked(describeImage).mockResolvedValue({ ok: true, text: "A profile screen." });
    const config = makeConfig();
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-3",
            toolName: "get_screenshot",
            output: {
              type: "content",
              value: [{ type: "image-data", data: "AAAA", mediaType: "image/png" }],
            },
          },
        ],
      },
    ];

    const result = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });

    const part = (result[0] as { content: { output: { type: string; value: string } }[] })
      .content[0];
    expect(part.output).toEqual({ type: "text", value: expect.stringContaining("A profile screen.") });
    expect(vi.mocked(describeImage).mock.calls[0][0].image).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(JSON.stringify(result)).not.toContain("image-data");
  });

  it("leaves a get_screenshot error result (no imageData) untouched", async () => {
    const config = makeConfig();
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "get_screenshot",
            output: { type: "text", value: JSON.stringify({ error: "Node not found." }) },
          },
        ],
      },
    ];

    const result = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });

    expect(result).toEqual(messages);
    expect(describeImage).not.toHaveBeenCalled();
  });

  it("caps how many images one turn describes, keeping the most recent", async () => {
    vi.mocked(describeImage).mockImplementation(async ({ image }) => ({
      ok: true,
      text: `described ${image}`,
    }));
    const config = makeConfig();
    // 10 images across 10 messages — the route's MAX_IMAGE_PARTS only bounds
    // images per message, so the history as a whole is unbounded.
    const total = MAX_DESCRIBED_IMAGES_PER_TURN + 2;
    const messages: ModelMessage[] = Array.from({ length: total }, (_, i) => ({
      role: "user" as const,
      content: [
        { type: "image" as const, image: `https://example.com/${i}.png`, mediaType: "image/png" },
      ],
    }));

    const result = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });

    expect(describeImage).toHaveBeenCalledTimes(MAX_DESCRIBED_IMAGES_PER_TURN);
    const texts = result.map((m) => ((m.content as { text: string }[])[0]).text);
    // The two oldest are omitted, the rest described — and nothing is left an image.
    expect(texts[0]).toContain("Earlier image omitted");
    expect(texts[1]).toContain("Earlier image omitted");
    expect(texts[2]).toContain("described https://example.com/2.png");
    expect(texts.at(-1)).toContain(`described https://example.com/${total - 1}.png`);
    expect(JSON.stringify(result)).not.toContain('"type":"image"');
  });

  it("yields a could-not-be-analyzed placeholder when describeImage fails", async () => {
    vi.mocked(describeImage).mockResolvedValue({
      ok: false,
      text: "Vision request timed out after 120000ms.",
    });
    const config = makeConfig();
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", image: "https://example.com/a.png", mediaType: "image/png" },
        ],
      },
    ];

    const result = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });

    const content = (result[0] as { content: unknown[] }).content;
    const text = (content[0] as { text: string }).text;
    expect(text).toBe(
      "[Image attached but could not be analyzed: Vision request timed out after 120000ms.]",
    );
  });
});
