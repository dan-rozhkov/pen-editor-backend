import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { makeConfig } from "./helpers.js";

vi.mock("../src/services/vision.js", () => ({
  describeImage: vi.fn(),
  peekCachedDescriptionByKey: vi.fn(),
  peekCachedFailureByKey: vi.fn(),
  // Not the real sha256 — vision-messages.ts only ever needs this to be a
  // stable, injective-enough function of `image` so slots that share an
  // image string end up with the same key and slots with different image
  // strings don't collide. A trivial passthrough keeps the tests below easy
  // to reason about (key === image) without pulling in node:crypto.
  visionCacheKey: (image: string) => `key:${image}`,
  isVisionConfigured: (config: { VISION_MODEL: string }) =>
    config.VISION_MODEL.trim().length > 0,
}));

import {
  describeImage,
  peekCachedDescriptionByKey,
  peekCachedFailureByKey,
} from "../src/services/vision.js";
import {
  applyVisionPreprocessing,
  modelSupportsVision,
  MAX_DESCRIBED_IMAGES_PER_TURN,
  MAX_RENDERED_DESCRIPTIONS,
} from "../src/ai/vision-messages.js";

// makeConfig()'s default OPENROUTER_MODEL (deepseek/deepseek-v4-pro) is
// vision-less per DEFAULT_MODELS in src/config.ts — used throughout as the
// "blind model" fixture. gemini-2.5-flash is vision-capable.
const BLIND_MODEL = "deepseek/deepseek-v4-pro";
const SEEING_MODEL = "google/gemini-2.5-flash";

afterEach(() => {
  vi.mocked(describeImage).mockReset();
  vi.mocked(peekCachedDescriptionByKey).mockReset();
  vi.mocked(peekCachedFailureByKey).mockReset();
  // Default: no cache hits, matching this suite's pre-existing behavior for
  // every test that isn't specifically exercising the cache.
  vi.mocked(peekCachedDescriptionByKey).mockReturnValue(undefined);
  vi.mocked(peekCachedFailureByKey).mockReturnValue(undefined);
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
    expect(texts[0]).toContain("Image omitted");
    expect(texts[1]).toContain("Image omitted");
    expect(texts[2]).toContain("described https://example.com/2.png");
    expect(texts.at(-1)).toContain(`described https://example.com/${total - 1}.png`);
    expect(JSON.stringify(result)).not.toContain('"type":"image"');
  });

  it("keeps a cached image's text budget-free and identical when newer images push it out of the recent window", async () => {
    // This is the regression test for the prompt-cache-breaking bug: image
    // A gets described on turn 1. On turn 2, 8+ newer images have arrived,
    // which under the OLD (position-based) budget would push A out and
    // replace it with a placeholder — rewriting message content in the
    // middle of the history and breaking the provider's cached prefix from
    // that point on. Under the fixed (cache-based) budget, A's cached
    // description must render byte-identical on turn 2.
    vi.mocked(describeImage).mockImplementation(async ({ image }) => ({
      ok: true,
      text: `described ${image}`,
    }));
    const config = makeConfig();

    const imageA = "https://example.com/A.png";
    const turn1: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "image", image: imageA, mediaType: "image/png" }],
      },
    ];
    const result1 = await applyVisionPreprocessing(turn1, { config, modelId: BLIND_MODEL });
    const textA1 = ((result1[0].content as { text: string }[])[0]).text;
    expect(textA1).toContain("described https://example.com/A.png");

    // Now A is "cached" from the caller's point of view — simulate that by
    // having peekCachedDescription resolve it, exactly as
    // services/vision.ts's real cache would after turn 1's describeImage()
    // call populated it.
    vi.mocked(peekCachedDescriptionByKey).mockImplementation((key: string) =>
      key === `key:${imageA}` ? "described https://example.com/A.png" : undefined,
    );
    vi.mocked(describeImage).mockClear();

    const freshImages = Array.from(
      { length: MAX_DESCRIBED_IMAGES_PER_TURN + 3 },
      (_, i) => `https://example.com/fresh-${i}.png`,
    );
    const turn2: ModelMessage[] = [
      turn1[0],
      ...freshImages.map((image) => ({
        role: "user" as const,
        content: [{ type: "image" as const, image, mediaType: "image/png" }],
      })),
    ];

    const result2 = await applyVisionPreprocessing(turn2, { config, modelId: BLIND_MODEL });
    const textA2 = ((result2[0].content as { text: string }[])[0]).text;

    expect(textA2).toBe(textA1);
    // The cache hit must not have consumed a describeImage() call.
    expect(describeImage).toHaveBeenCalledTimes(MAX_DESCRIBED_IMAGES_PER_TURN);
    expect(vi.mocked(describeImage).mock.calls.map((c) => c[0].image)).not.toContain(imageA);
  });

  it("does not call describeImage for slots the cache already covers, and budgets only the rest", async () => {
    vi.mocked(describeImage).mockImplementation(async ({ image }) => ({
      ok: true,
      text: `described ${image}`,
    }));
    const config = makeConfig();

    // 12 images: 10 already cached, 2 not.
    const cachedImages = Array.from({ length: 10 }, (_, i) => `https://example.com/cached-${i}.png`);
    const uncachedImages = ["https://example.com/new-0.png", "https://example.com/new-1.png"];
    vi.mocked(peekCachedDescriptionByKey).mockImplementation((key: string) => {
      const image = cachedImages.find((img) => `key:${img}` === key);
      return image ? `cached description for ${image}` : undefined;
    });

    const messages: ModelMessage[] = [...cachedImages, ...uncachedImages].map((image) => ({
      role: "user" as const,
      content: [{ type: "image" as const, image, mediaType: "image/png" }],
    }));

    const result = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });

    // Only the 2 uncached slots should trigger a real call — well under the
    // 8-image budget, since cached slots don't consume it.
    expect(describeImage).toHaveBeenCalledTimes(uncachedImages.length);
    const texts = result.map((m) => ((m.content as { text: string }[])[0]).text);
    for (let i = 0; i < cachedImages.length; i++) {
      expect(texts[i]).toContain(`cached description for ${cachedImages[i]}`);
    }
    expect(texts.at(-2)).toContain("described https://example.com/new-0.png");
    expect(texts.at(-1)).toContain("described https://example.com/new-1.png");
    expect(JSON.stringify(result)).not.toContain('"type":"image"');
  });

  it("caps total rendered descriptions even when every slot is a cache hit, collapsing the oldest", async () => {
    const config = makeConfig();
    const total = MAX_RENDERED_DESCRIPTIONS + 5;
    const images = Array.from({ length: total }, (_, i) => `https://example.com/render-${i}.png`);
    vi.mocked(peekCachedDescriptionByKey).mockImplementation((key: string) => {
      const image = images.find((img) => `key:${img}` === key);
      return image ? `cached ${image}` : undefined;
    });
    const messages: ModelMessage[] = images.map((image) => ({
      role: "user" as const,
      content: [{ type: "image" as const, image, mediaType: "image/png" }],
    }));

    const result = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });

    expect(describeImage).not.toHaveBeenCalled();
    const texts = result.map((m) => ((m.content as { text: string }[])[0]).text);
    const overLimit = total - MAX_RENDERED_DESCRIPTIONS;
    for (let i = 0; i < overLimit; i++) {
      expect(texts[i]).toContain("Image omitted");
      expect(texts[i]).not.toContain(`cached ${images[i]}`);
    }
    for (let i = overLimit; i < total; i++) {
      expect(texts[i]).toContain(`cached ${images[i]}`);
    }
    expect(JSON.stringify(result)).not.toContain('"type":"image"');
  });

  it("renders a cached failure for free, identical to a fresh failure, without spending the budget", async () => {
    vi.mocked(peekCachedFailureByKey).mockImplementation((key: string) =>
      key === "key:https://example.com/dead.png" ? "Vision request timed out after 120000ms." : undefined,
    );
    const config = makeConfig();
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", image: "https://example.com/dead.png", mediaType: "image/png" },
        ],
      },
    ];

    const result = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });

    const text = ((result[0].content as { text: string }[])[0]).text;
    expect(text).toBe(
      "[Image attached but could not be analyzed: Vision request timed out after 120000ms.]",
    );
    expect(describeImage).not.toHaveBeenCalled();
  });

  it("deduplicates the same not-yet-cached image across slots into a single describeImage call", async () => {
    vi.mocked(describeImage).mockResolvedValue({ ok: true, text: "A pricing screen." });
    const config = makeConfig();
    const sharedImage = "https://example.com/dup.png";
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "image", image: sharedImage, mediaType: "image/png" }] },
      { role: "user", content: [{ type: "image", image: sharedImage, mediaType: "image/png" }] },
    ];

    const result = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });

    expect(describeImage).toHaveBeenCalledOnce();
    const textA = ((result[0].content as { text: string }[])[0]).text;
    const textB = ((result[1].content as { text: string }[])[0]).text;
    expect(textA).toBe(textB);
    expect(textA).toContain("A pricing screen.");
    expect(JSON.stringify(result)).not.toContain('"type":"image"');
  });

  it("formats each slot of a deduplicated image with ITS OWN label, byte-identical to what that slot gets on the next turn from cache", async () => {
    // Regression test for finding B: one image occupies both a user
    // attachment slot ("Image") and a get_screenshot result slot
    // ("Screenshot"). The dedup path must call describeImage once but
    // format each slot with its own label — never copy one slot's fully
    // formatted text (label baked in) into the other.
    const sharedImage = "data:image/png;base64,SHARED";
    vi.mocked(describeImage).mockResolvedValue({ ok: true, text: "A settings screen." });
    const config = makeConfig();
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "image", image: sharedImage, mediaType: "image/png" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "get_screenshot",
            output: {
              type: "text",
              value: JSON.stringify({ imageData: sharedImage }),
            },
          },
        ],
      },
    ];

    const result = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });

    expect(describeImage).toHaveBeenCalledOnce();
    const userText = ((result[0].content as { text: string }[])[0]).text;
    const toolPart = (result[1] as { content: { output: { value: string } }[] }).content[0];
    const screenshotText = toolPart.output.value;

    expect(userText).toBe("[Image: visual description]\nA settings screen.");
    expect(screenshotText).toBe("[Screenshot: visual description]\nA settings screen.");
    expect(userText).not.toBe(screenshotText);

    // Next turn: both slots are now cache hits (peekCachedDescriptionByKey
    // resolves for this image's key, matching what services/vision.ts would
    // really do after the describeImage() call above populated its cache).
    // The cache-hit path already formats per-slot (it always did) — this
    // asserts the fresh-render path above produced byte-identical text to
    // what the cache-hit path renders, which is the actual bug this finding
    // is about: fresh and cached renders must never diverge.
    vi.mocked(peekCachedDescriptionByKey).mockImplementation((key: string) =>
      key === `key:${sharedImage}` ? "A settings screen." : undefined,
    );
    vi.mocked(describeImage).mockClear();

    const result2 = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });
    const userText2 = ((result2[0].content as { text: string }[])[0]).text;
    const screenshotText2 = (result2[1] as { content: { output: { value: string } }[] }).content[0]
      .output.value;

    expect(describeImage).not.toHaveBeenCalled();
    expect(userText2).toBe(userText);
    expect(screenshotText2).toBe(screenshotText);
  });

  it("ranks a deduplicated unit by its NEWEST slot, not its oldest — a reattached old image beats a strictly-older never-reattached one for the budget", async () => {
    // Regression test for finding C. Layout (all distinct images except
    // oldA, which appears twice):
    //   [0] oldA   [1] oldB   [2..8] fresh-2..fresh-8 (7 images)   [9] oldA again
    // That's 9 distinct units against an 8-image budget, so exactly one
    // unit must lose. oldA's unit spans seq 0 and seq 9 (newestSeq = 9, the
    // most recent slot in the whole turn) so it must win the budget despite
    // also having the oldest occurrence in the turn. oldB's unit only ever
    // occurs at seq 1 (newestSeq = 1, the smallest of all units) so it must
    // be the one that loses.
    vi.mocked(describeImage).mockImplementation(async ({ image }) => ({
      ok: true,
      text: `described ${image}`,
    }));
    const config = makeConfig();
    const oldA = "https://example.com/old-A.png";
    const oldB = "https://example.com/old-B.png";
    const fresh = Array.from({ length: 7 }, (_, i) => `https://example.com/fresh-${i}.png`);
    const imagesInOrder = [oldA, oldB, ...fresh, oldA];
    const messages: ModelMessage[] = imagesInOrder.map((image) => ({
      role: "user" as const,
      content: [{ type: "image" as const, image, mediaType: "image/png" }],
    }));

    const result = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });
    const texts = result.map((m) => ((m.content as { text: string }[])[0]).text);

    // oldB (index 1) lost the budget.
    expect(texts[1]).toContain("used its budget");
    // oldA (index 0 AND index 9, same unit) won, on both its slots.
    expect(texts[0]).toContain(`described ${oldA}`);
    expect(texts[9]).toContain(`described ${oldA}`);
    // All 7 fresh images, being newer than oldB, also won.
    for (let i = 0; i < fresh.length; i++) {
      expect(texts[2 + i]).toContain(`described ${fresh[i]}`);
    }
    // Exactly 8 distinct describeImage calls: oldA once (deduplicated across
    // its two slots) + 7 fresh. oldB never gets a real call.
    expect(describeImage).toHaveBeenCalledTimes(MAX_DESCRIBED_IMAGES_PER_TURN);
    expect(vi.mocked(describeImage).mock.calls.map((c) => c[0].image)).not.toContain(oldB);
  });

  it("does not spend the vision-call budget on slots with no usable image data", async () => {
    // Regression test for finding D: 8 unsupported-format slots (image ===
    // null after toImageString fails to normalize the payload) plus 1 real,
    // describable image. The unsupported slots must resolve immediately
    // (deterministic "unsupported format" text, no describeImage call) and
    // must NOT consume MAX_DESCRIBED_IMAGES_PER_TURN — so the one real image
    // still gets described even though there are 9 total slots.
    vi.mocked(describeImage).mockResolvedValue({ ok: true, text: "A checkout screen." });
    const config = makeConfig();
    const unsupportedMessages: ModelMessage[] = Array.from(
      { length: MAX_DESCRIBED_IMAGES_PER_TURN },
      () => ({
        role: "user" as const,
        // An object shape toImageString() does not know how to normalize —
        // not a URL, string, Uint8Array, or ArrayBuffer.
        content: [{ type: "image" as const, image: { unsupported: true } as never, mediaType: "image/png" }],
      }),
    );
    const messages: ModelMessage[] = [
      ...unsupportedMessages,
      {
        role: "user",
        content: [
          { type: "image", image: "https://example.com/real.png", mediaType: "image/png" },
        ],
      },
    ];

    const result = await applyVisionPreprocessing(messages, { config, modelId: BLIND_MODEL });
    const texts = result.map((m) => ((m.content as { text: string }[])[0]).text);

    for (let i = 0; i < MAX_DESCRIBED_IMAGES_PER_TURN; i++) {
      expect(texts[i]).toBe(
        "[Image attached but could not be analyzed: unsupported image data format]",
      );
    }
    expect(texts.at(-1)).toContain("A checkout screen.");
    expect(describeImage).toHaveBeenCalledOnce();
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
