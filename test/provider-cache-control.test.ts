import { describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";

// Records the settings every openrouter(...) call receives. The primary model
// rejects with the reasoning-mandatory 400 so the fallback builder runs too.
const openrouterFactory = vi.fn();
const fallbackStream = vi.fn();

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: () => (modelId: string, settings?: { reasoning?: unknown }) => {
    openrouterFactory(modelId, settings);
    const isPrimary = settings?.reasoning !== undefined;
    return {
      specificationVersion: "v3",
      provider: "openrouter",
      modelId,
      supportedUrls: {},
      doStream: isPrimary
        ? vi.fn().mockRejectedValue(
            new APICallError({
              message: "Reasoning is mandatory for this endpoint and cannot be disabled.",
              url: "https://openrouter.ai/api/v1/chat/completions",
              requestBodyValues: {},
              statusCode: 400,
              responseBody: '{"error":{"message":"Reasoning is mandatory"}}',
            }),
          )
        : fallbackStream,
      doGenerate: vi.fn(),
    };
  },
}));

const { createModel, usesAnthropicPromptCache } = await import("../src/ai/provider.js");
const { makeConfig } = await import("./helpers.js");

const CACHE = { cache_control: { type: "ephemeral" } };

describe("Anthropic prompt caching via OpenRouter", () => {
  it("only anthropic/ ids opt in", () => {
    expect(usesAnthropicPromptCache("anthropic/claude-haiku-5.5")).toBe(true);
    expect(usesAnthropicPromptCache("deepseek/deepseek-v4.1-flash")).toBe(false);
    expect(usesAnthropicPromptCache("openai/gpt-5")).toBe(false);
  });

  it("sends cache_control alongside reasoning for an anthropic model", () => {
    vi.clearAllMocks();
    createModel(makeConfig({ CHAT_MODEL: "anthropic/claude-haiku-5.5" }));
    const [, settings] = openrouterFactory.mock.calls[0];
    expect(settings).toMatchObject(CACHE);
  });

  it("keeps cache_control on the reasoning-mandatory retry", async () => {
    vi.clearAllMocks();
    fallbackStream.mockResolvedValueOnce({ stream: "ok" });
    const model = createModel(
      makeConfig({ CHAT_MODEL: "anthropic/claude-haiku-5.5" }),
    ) as unknown as { doStream: (p: never) => Promise<unknown> };
    await expect(model.doStream({ prompt: [] } as never)).resolves.toEqual({ stream: "ok" });
    const [, retrySettings] = openrouterFactory.mock.calls.at(-1)!;
    expect(retrySettings).toEqual(CACHE);
  });

  it("sends cache_control for a picked anthropic model (chatAgent)", () => {
    vi.clearAllMocks();
    createModel(makeConfig(), "anthropic/claude-haiku-5.5", { chatAgent: true });
    const [, settings] = openrouterFactory.mock.calls[0];
    expect(settings).toMatchObject(CACHE);
  });

  it("sends no cache_control for an anthropic helper role (no chatAgent)", () => {
    vi.clearAllMocks();
    createModel(makeConfig(), "anthropic/claude-haiku-5.5");
    const [, settings] = openrouterFactory.mock.calls[0];
    expect(JSON.stringify(settings ?? {})).not.toContain("cache_control");
  });

  it.each(["deepseek/deepseek-v4.1-flash", "openai/gpt-5", "mistralai/mistral-large"])(
    "sends no cache_control for %s",
    (CHAT_MODEL) => {
      vi.clearAllMocks();
      createModel(makeConfig({ CHAT_MODEL }));
      const [, settings] = openrouterFactory.mock.calls[0];
      expect(JSON.stringify(settings ?? {})).not.toContain("cache_control");
    },
  );
});
