import { describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";

// The fallback lives inside createModel's OpenRouter branch, so the
// provider factory is mocked to hand back a model we control: a primary
// that fails the way the live API actually failed, and a fallback built
// with no `reasoning` option. Asserting through createModel (rather than
// unit-testing the wrapper in isolation) is deliberate — the thing worth
// pinning is that the model createModel RETURNS recovers, since that is
// what every call site gets.
const doStream = vi.fn();
const doGenerate = vi.fn();
const fallbackStream = vi.fn();
const fallbackGenerate = vi.fn();
const openrouterFactory = vi.fn();

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: () => (modelId: string, settings?: unknown) => {
    openrouterFactory(modelId, settings);
    const withReasoning = (settings as { reasoning?: unknown } | undefined)?.reasoning !== undefined;
    return {
      specificationVersion: "v3",
      provider: "openrouter",
      modelId,
      supportedUrls: {},
      doStream: withReasoning ? doStream : fallbackStream,
      doGenerate: withReasoning ? doGenerate : fallbackGenerate,
    };
  },
}));

const { createModel } = await import("../src/ai/provider.js");
const { makeConfig } = await import("./helpers.js");

const CHAT_MODEL = "deepseek/deepseek-v4.1-flash";

function reasoningMandatoryError(): APICallError {
  const body =
    '{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","code":400}}';
  return new APICallError({
    message: "Reasoning is mandatory for this endpoint and cannot be disabled.",
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 400,
    responseBody: body,
  });
}

const params = { prompt: [] } as never;

describe("reasoning-mandatory fallback", () => {
  it("retries once without reasoning when the provider says reasoning is mandatory", async () => {
    vi.clearAllMocks();
    doStream.mockRejectedValueOnce(reasoningMandatoryError());
    fallbackStream.mockResolvedValueOnce({ stream: "ok" });

    // No provider order, so the settings hold the reasoning option alone.
    const model = createModel(makeConfig({ CHAT_MODEL, OPENROUTER_PROVIDER_ORDER: "" })) as unknown as {
      doStream: (p: never) => Promise<unknown>;
    };
    await expect(model.doStream(params)).resolves.toEqual({ stream: "ok" });

    // The retry must differ from the original ONLY by the reasoning option.
    expect(fallbackStream).toHaveBeenCalledWith(params);
    const [, firstSettings] = openrouterFactory.mock.calls[0];
    expect(firstSettings).toEqual({ reasoning: { effort: "none" } });
    const [, retrySettings] = openrouterFactory.mock.calls.at(-1)!;
    expect(retrySettings).toBeUndefined();
  });

  it("applies to doGenerate as well, not just streaming", async () => {
    vi.clearAllMocks();
    doGenerate.mockRejectedValueOnce(reasoningMandatoryError());
    fallbackGenerate.mockResolvedValueOnce({ content: [] });

    const model = createModel(makeConfig({ CHAT_MODEL })) as unknown as {
      doGenerate: (p: never) => Promise<unknown>;
    };
    await expect(model.doGenerate(params)).resolves.toEqual({ content: [] });
    expect(fallbackGenerate).toHaveBeenCalledWith(params);
  });

  it("retries at most once — a second failure is surfaced, not looped", async () => {
    vi.clearAllMocks();
    doStream.mockRejectedValueOnce(reasoningMandatoryError());
    fallbackStream.mockRejectedValueOnce(reasoningMandatoryError());

    const model = createModel(makeConfig({ CHAT_MODEL })) as unknown as {
      doStream: (p: never) => Promise<unknown>;
    };
    await expect(model.doStream(params)).rejects.toThrow(/Reasoning is mandatory/);
    expect(fallbackStream).toHaveBeenCalledTimes(1);
  });

  it("rethrows any other provider error untouched", async () => {
    vi.clearAllMocks();
    const other = new APICallError({
      message: "Rate limited",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 429,
    });
    doStream.mockRejectedValueOnce(other);

    const model = createModel(makeConfig({ CHAT_MODEL })) as unknown as {
      doStream: (p: never) => Promise<unknown>;
    };
    await expect(model.doStream(params)).rejects.toThrow("Rate limited");
    // A 429 must not silently drop the operator's reasoning setting.
    expect(fallbackStream).not.toHaveBeenCalled();
  });

  it("does not wrap a model family outside the reasoning allowlist", async () => {
    vi.clearAllMocks();
    createModel(makeConfig({ CHAT_MODEL: "mistralai/mistral-large" }));
    // No reasoning was sent, so there is nothing to fall back from.
    expect(openrouterFactory).toHaveBeenCalledTimes(1);
    const [, settings] = openrouterFactory.mock.calls[0];
    expect(settings).toBeUndefined();
  });

  it("keeps the configured provider order on the primary model and on the retry", async () => {
    vi.clearAllMocks();
    doStream.mockRejectedValueOnce(reasoningMandatoryError());
    fallbackStream.mockResolvedValueOnce({ stream: "ok" });

    // Default OPENROUTER_PROVIDER_ORDER: deepseek flash goes to Together first.
    const model = createModel(makeConfig({ CHAT_MODEL }), undefined, {
      chatAgent: true,
    }) as unknown as { doStream: (p: never) => Promise<unknown> };
    await expect(model.doStream(params)).resolves.toEqual({ stream: "ok" });

    const provider = { order: ["together"], allow_fallbacks: true };
    expect(openrouterFactory.mock.calls[0][1]).toEqual({ provider, reasoning: { effort: "none" } });
    expect(openrouterFactory.mock.calls.at(-1)![1]).toEqual({ provider });
  });
});

describe("providerOrderFor", () => {
  it("returns the slugs of the matching model and [] for any other model", async () => {
    const { providerOrderFor } = await import("../src/ai/provider.js");
    const spec = "deepseek/deepseek-v4.1-flash=together, fireworks;openai/gpt-6-luna=azure";
    expect(providerOrderFor(spec, "deepseek/deepseek-v4.1-flash")).toEqual(["together", "fireworks"]);
    expect(providerOrderFor(spec, "openai/gpt-6-luna")).toEqual(["azure"]);
    expect(providerOrderFor(spec, "anthropic/claude-haiku-5.5")).toEqual([]);
    expect(providerOrderFor("", "deepseek/deepseek-v4.1-flash")).toEqual([]);
  });

  it("lets an explicit providerOrder option override the config", () => {
    vi.clearAllMocks();
    createModel(makeConfig({ CHAT_MODEL }), undefined, { providerOrder: [] });
    expect(openrouterFactory.mock.calls[0][1]).toEqual({ reasoning: { effort: "none" } });
  });
});
