import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { makeConfig } from "./helpers.js";

vi.mock("../src/ai/provider.js");

import { createModel } from "../src/ai/provider.js";
import {
  describeImage,
  isVisionConfigured,
  peekCachedDescription,
  peekCachedDescriptionByKey,
  peekCachedFailure,
  visionCacheKey,
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

  // Finding #6: describeImage passes a stricter maxRetries: 1 (not the
  // DEFAULT_AGENT_RETRY 2) to withAgentRetry, because applyVisionPreprocessing
  // fans this call out up to 8x per request and blocks prepareChatTurn until
  // it settles — see the doc comment above the withAgentRetry call.
  it("retries a persistently-retryable provider error exactly once (maxRetries: 1), not the default 2", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      supportedUrls: { "image/*": [/.*/] },
      doGenerate: async () => {
        calls++;
        throw new Error("503 Service Unavailable");
      },
    });
    vi.mocked(createModel).mockReturnValue(model);

    const config = makeConfig();
    const result = await describeImage({ image: "https://example.com/f.png", config });

    expect(result.ok).toBe(false);
    // Initial attempt + exactly 1 retry = 2 calls, not 3 (which is what
    // DEFAULT_AGENT_RETRY's maxRetries: 2 would have produced).
    expect(calls).toBe(2);
  });
});

describe("peekCachedDescription", () => {
  it("returns undefined without calling the model when nothing is cached", () => {
    expect(peekCachedDescription("https://example.com/never-described.png")).toBeUndefined();
    expect(createModel).not.toHaveBeenCalled();
  });

  it("returns the cached text after describeImage has described that image+question", async () => {
    const { model } = mockModel("A green button.");
    vi.mocked(createModel).mockReturnValue(model);
    const config = makeConfig();

    await describeImage({ image: "https://example.com/f.png", question: "q", config });

    expect(peekCachedDescription("https://example.com/f.png", "q")).toBe("A green button.");
    // A different question for the same image is a different cache entry.
    expect(peekCachedDescription("https://example.com/f.png")).toBeUndefined();
  });

  it("never triggers a network call itself", () => {
    peekCachedDescription("https://example.com/g.png");
    expect(createModel).not.toHaveBeenCalled();
  });
});

describe("negative cache for failed describeImage calls", () => {
  it("does not re-call the model for a still-failing TIMEOUT, and negatively caches it", async () => {
    // A real (short) VISION_TIMEOUT_MS whose doGenerate() only settles when
    // ITS OWN abortSignal fires — this exercises describeImage's actual
    // `AbortSignal.timeout()` path (timeoutSignal.aborted), not a
    // provider-thrown error, so it is a real test of the "timeout IS
    // negatively cached" half of the A/B split in describeImage's catch
    // block. Real timers are used because AbortSignal.timeout's internal
    // timer isn't controlled by vi.useFakeTimers().
    const config = makeConfig({ VISION_TIMEOUT_MS: 30 });
    const model = new MockLanguageModelV3({
      supportedUrls: { "image/*": [/.*/] },
      doGenerate: (options: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () =>
            reject(new Error("aborted by timeout")),
          );
        }),
    });
    vi.mocked(createModel).mockReturnValue(model);

    const firstResult = await describeImage({ image: "https://example.com/flaky.png", config });
    expect(firstResult.ok).toBe(false);
    expect(firstResult.text).toMatch(/timed out/i);

    // Second call for the same image: served from the negative cache, no
    // second model call, identical failure text.
    const cached = peekCachedFailure("https://example.com/flaky.png");
    expect(cached).toBe(firstResult.text);
  });

  it("negatively caches an empty model response (deterministic-enough garbage, not a network fluke)", async () => {
    const { model } = mockModel("   ");
    vi.mocked(createModel).mockReturnValue(model);
    const config = makeConfig();

    const first = await describeImage({ image: "https://example.com/empty.png", config });
    expect(first.ok).toBe(false);
    expect(first.text).toMatch(/empty description/i);
    // describeImage() itself never reads the negative cache (only writes
    // it) — peekCachedFailure is the read path a caller like
    // vision-messages.ts uses to skip a repeat describeImage() call
    // entirely. So the entry landing here, byte-identical to the failure
    // text, is what "negatively cached" means for this failure kind.
    expect(peekCachedFailure("https://example.com/empty.png")).toBe(first.text);
  });

  it("expires a negatively-cached failure after FAILURE_CACHE_TTL_MS, allowing a retry", async () => {
    vi.useFakeTimers();
    try {
      const { model } = mockModel("");
      vi.mocked(createModel).mockReturnValue(model);
      const config = makeConfig();

      const first = await describeImage({ image: "https://example.com/expiring.png", config });
      expect(first.ok).toBe(false);
      expect(peekCachedFailure("https://example.com/expiring.png")).toBe(first.text);

      // Not yet expired at 9 minutes.
      vi.advanceTimersByTime(9 * 60 * 1000);
      expect(peekCachedFailure("https://example.com/expiring.png")).toBe(first.text);

      // Past the 10-minute TTL: the entry is gone.
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(peekCachedFailure("https://example.com/expiring.png")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT negatively cache an ordinary thrown provider error (429, 5xx, connection reset) — the next call gets a fresh shot", async () => {
    let callCount = 0;
    const model = new MockLanguageModelV3({
      supportedUrls: { "image/*": [/.*/] },
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) throw new Error("provider exploded");
        return {
          content: [{ type: "text" as const, text: "Recovered on retry." }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: USAGE,
          warnings: [],
        };
      },
    });
    vi.mocked(createModel).mockReturnValue(model);
    const config = makeConfig();

    const first = await describeImage({ image: "https://example.com/flaky-provider.png", config });
    expect(first.ok).toBe(false);
    expect(first.text).toMatch(/provider exploded/i);

    // Unlike a timeout or an empty description, a plain thrown error must
    // NOT land in the negative cache — the whole point is that a transient
    // provider blip gets to heal itself on the very next call instead of
    // being pinned to "known bad" for FAILURE_CACHE_TTL_MS with no recovery
    // path (the cache key is sha256(image), so re-uploading doesn't help).
    expect(peekCachedFailure("https://example.com/flaky-provider.png")).toBeUndefined();

    // And a second describeImage() call actually re-invokes the model and
    // can succeed, rather than replaying the first failure from cache.
    const second = await describeImage({ image: "https://example.com/flaky-provider.png", config });
    expect(second).toEqual({ ok: true, text: "Recovered on retry." });
    expect(callCount).toBe(2);
  });

  it("never lets a failure leak into the success cache", async () => {
    const model = new MockLanguageModelV3({
      supportedUrls: { "image/*": [/.*/] },
      doGenerate: async () => {
        throw new Error("boom");
      },
    });
    vi.mocked(createModel).mockReturnValue(model);
    const config = makeConfig();

    await describeImage({ image: "https://example.com/boom.png", config });

    // describeImage must still report failure on a later call for the same
    // image — the negative cache is a distinct read path (peekCachedFailure),
    // never mixed into the success cache describeImage() itself consults.
    const second = await describeImage({ image: "https://example.com/boom.png", config });
    expect(second.ok).toBe(false);
    expect(peekCachedDescription("https://example.com/boom.png")).toBeUndefined();
  });
});

describe("visionCacheKey / *ByKey helpers", () => {
  it("visionCacheKey matches what describeImage/peekCachedDescription derive internally", async () => {
    const { model } = mockModel("A precomputed-key description.");
    vi.mocked(createModel).mockReturnValue(model);
    const config = makeConfig();

    const key = visionCacheKey("https://example.com/keyed.png");
    await describeImage({ image: "https://example.com/keyed.png", config, key });

    expect(peekCachedDescriptionByKey(key)).toBe("A precomputed-key description.");
    // The image-derived peek must resolve the exact same entry — a
    // precomputed key populates the same cache slot as the image string
    // would on its own, it's just a shortcut for looking it up again.
    expect(peekCachedDescription("https://example.com/keyed.png")).toBe(
      "A precomputed-key description.",
    );
  });

  it("describeImage accepts a precomputed key and still resolves/populates the same cache entry as the image-derived key", async () => {
    const { model, doGenerate } = mockModel("Same entry either way.");
    vi.mocked(createModel).mockReturnValue(model);
    const config = makeConfig();
    const image = "https://example.com/either-way.png";
    const key = visionCacheKey(image);

    const first = await describeImage({ image, config, key });
    expect(first).toEqual({ ok: true, text: "Same entry either way." });

    // A second call using the image-derived key path (no `key` passed) must
    // hit the very same cache entry.
    const second = await describeImage({ image, config });
    expect(second).toEqual(first);
    expect(doGenerate).toHaveBeenCalledTimes(1);
  });
});

describe("LRU eviction is by recency of USE, not of insertion", () => {
  it("a re-read entry survives eviction that would otherwise drop it", async () => {
    const { model, doGenerate } = mockModel("some description");
    vi.mocked(createModel).mockReturnValue(model);
    const config = makeConfig();
    const CACHE_MAX_ENTRIES = 64;

    // Fill the cache to exactly its cap: "old" plus (CACHE_MAX_ENTRIES - 1)
    // fillers — no eviction has happened yet at this point.
    await describeImage({ image: "https://example.com/old.png", config });
    for (let i = 0; i < CACHE_MAX_ENTRIES - 1; i++) {
      await describeImage({ image: `https://example.com/filler-${i}.png`, config });
    }

    // Touch "old" again, right before pushing the cache over its cap. If
    // eviction went by insertion order (the old bug), "old" — inserted
    // first — would be exactly what gets dropped next. Re-reading it here
    // must save it, at the expense of "filler-0", which has not been
    // touched since its own insertion.
    expect(peekCachedDescription("https://example.com/old.png")).toBe("some description");
    await describeImage({ image: "https://example.com/one-more.png", config });

    expect(peekCachedDescription("https://example.com/old.png")).toBe("some description");
    expect(peekCachedDescription("https://example.com/filler-0.png")).toBeUndefined();
    // Confirm "old" really did come from the cache both times, not a fresh call.
    expect(doGenerate).toHaveBeenCalledTimes(CACHE_MAX_ENTRIES + 1);
  });
});
