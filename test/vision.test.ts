import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { makeConfig } from "./helpers.js";

vi.mock("../src/ai/provider.js");

import { createModel } from "../src/ai/provider.js";
import {
  describeImage,
  isVisionConfigured,
  __resetVisionCache,
} from "../src/services/vision.js";

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function mockModel(text: string) {
  const doGenerate = vi.fn(async () => ({
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: USAGE,
    warnings: [],
  }));
  const model = new MockLanguageModelV3({
    // Without this, the AI SDK tries to actually download image URLs before
    // calling the model (since a mock model declares no supported URL
    // types by default) — declare image/* as natively supported so the URL
    // is passed straight through, matching how a real vision model behaves.
    supportedUrls: { "image/*": [/.*/] },
    doGenerate,
  });
  return { model, doGenerate };
}

afterEach(() => {
  __resetVisionCache();
  vi.resetAllMocks();
});

describe("isVisionConfigured", () => {
  it("true when VISION_MODEL is set", () => {
    expect(isVisionConfigured(makeConfig())).toBe(true);
  });

  it("false when VISION_MODEL is empty or whitespace", () => {
    expect(isVisionConfigured(makeConfig({ VISION_MODEL: "" }))).toBe(false);
    expect(isVisionConfigured(makeConfig({ VISION_MODEL: "   " }))).toBe(false);
  });
});

describe("describeImage", () => {
  it("returns ok:false without calling the model when vision is unconfigured", async () => {
    const config = makeConfig({ VISION_MODEL: "" });
    const result = await describeImage({ image: "https://example.com/a.png", config });

    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/not configured/i);
    expect(createModel).not.toHaveBeenCalled();
  });

  it("sends the no-question prompt with a text part and an image part", async () => {
    const { model, doGenerate } = mockModel("A red apple on a white table.");
    vi.mocked(createModel).mockReturnValue(model);

    const config = makeConfig();
    const result = await describeImage({ image: "https://example.com/a.png", config });

    expect(result).toEqual({ ok: true, text: "A red apple on a white table." });
    expect(createModel).toHaveBeenCalledWith(config, config.VISION_MODEL);

    const call = doGenerate.mock.calls[0][0];
    const messages = call.prompt;
    expect(messages).toHaveLength(1);
    const content = messages[0].content;
    expect(content[0]).toMatchObject({
      type: "text",
      text: "Describe everything visible in this image in thorough detail. Include any text, layout structure, colors, typography, spacing, imagery, UI controls and any other notable visual information.",
    });
    expect(content[1].type).toBe("file");
    expect(String(content[1].data)).toBe("https://example.com/a.png");
    expect(content[1].mediaType).toBe("image/*");
    expect(call.maxOutputTokens).toBe(config.VISION_MAX_TOKENS);
  });

  it("sends the with-question prompt when a question is given", async () => {
    const { model, doGenerate } = mockModel("It is a login screen with two fields.");
    vi.mocked(createModel).mockReturnValue(model);

    const config = makeConfig();
    const result = await describeImage({
      image: "https://example.com/b.png",
      question: "What screen is this?",
      config,
    });

    expect(result.ok).toBe(true);
    const content = doGenerate.mock.calls[0][0].prompt[0].content;
    expect(content[0]).toEqual({
      type: "text",
      text: "Fully describe and explain everything about this image, then answer the following question:\n\nWhat screen is this?",
    });
  });

  it("caches by image+question so a second identical call does not re-call the model", async () => {
    const { model, doGenerate } = mockModel("Cached description.");
    vi.mocked(createModel).mockReturnValue(model);

    const config = makeConfig();
    const first = await describeImage({ image: "https://example.com/c.png", config });
    const second = await describeImage({ image: "https://example.com/c.png", config });

    expect(first).toEqual({ ok: true, text: "Cached description." });
    expect(second).toEqual({ ok: true, text: "Cached description." });
    expect(doGenerate).toHaveBeenCalledTimes(1);
  });

  it("does not share a cache entry between different questions for the same image", async () => {
    const { model, doGenerate } = mockModel("Some description.");
    vi.mocked(createModel).mockReturnValue(model);

    const config = makeConfig();
    await describeImage({ image: "https://example.com/d.png", question: "q1", config });
    await describeImage({ image: "https://example.com/d.png", question: "q2", config });

    expect(doGenerate).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized data: URL without calling the model", async () => {
    const config = makeConfig();
    // ~8MB of base64 payload (> 6MB decoded limit).
    const big = "A".repeat(11_000_000);
    const result = await describeImage({
      image: `data:image/png;base64,${big}`,
      config,
    });

    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/too large/i);
    expect(createModel).not.toHaveBeenCalled();
  });

  it("returns ok:false when the model call throws", async () => {
    const model = new MockLanguageModelV3({
      supportedUrls: { "image/*": [/.*/] },
      doGenerate: async () => {
        throw new Error("provider exploded");
      },
    });
    vi.mocked(createModel).mockReturnValue(model);

    const config = makeConfig();
    const result = await describeImage({ image: "https://example.com/e.png", config });

    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/provider exploded/i);
  });
});
