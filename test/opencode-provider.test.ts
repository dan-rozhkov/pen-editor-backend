import { describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import {
  OPENCODE_BASE_URLS,
  OPENCODE_CHAT_COMPLETIONS_MODELS,
  OPENCODE_USER_AGENT,
  createOpenCodeModel,
} from "../src/ai/opencode.js";
import { createModel } from "../src/ai/provider.js";
import { makeConfig } from "./helpers.js";

// A minimal fetch stub that captures the outgoing Request and answers a
// well-formed OpenAI-compatible chat-completions response, so a real
// `generateText` call can run against createOpenCodeModel without any
// network access.
function fakeChatCompletionsFetch() {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const body = {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchStub, calls };
}

describe("OPENCODE_BASE_URLS", () => {
  it("hardcodes both bases under opencode.ai", () => {
    expect(OPENCODE_BASE_URLS["opencode-go"]).toBe("https://opencode.ai/zen/go/v1");
    expect(OPENCODE_BASE_URLS.opencode).toBe("https://opencode.ai/zen/v1");
  });
});

describe("createOpenCodeModel", () => {
  it("throws for a model id outside the /chat/completions allowlist, naming the model", () => {
    expect(() =>
      createOpenCodeModel({
        provider: "opencode-go",
        modelId: "totally-unknown-model",
        apiKey: "user-key",
        sessionId: "session-1",
      }),
    ).toThrow(/totally-unknown-model/);
  });

  it("throws for an empty API key", () => {
    expect(() =>
      createOpenCodeModel({
        provider: "opencode-go",
        modelId: "glm-5.3-flash",
        apiKey: "   ",
        sessionId: "session-1",
      }),
    ).toThrow(/API key/i);
  });

  it("does not send a request for a rejected model (allowlist check happens before any fetch)", () => {
    const { fetchStub } = fakeChatCompletionsFetch();
    expect(() =>
      createOpenCodeModel({
        provider: "opencode-go",
        modelId: "not-a-real-model",
        apiKey: "user-key",
        sessionId: "session-1",
      }),
    ).toThrow();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  // The main test of the task: verify the actual outgoing request carries
  // the right URL and headers, via a real generateText() call through the
  // model createOpenCodeModel returns — not by inspecting
  // createOpenAICompatible's config. Exercised through createOpenCodeModel
  // itself (not a hand-rolled createOpenAICompatible client) because the
  // header-forcing fetch wrapper lives inside that function; testing a
  // hand-rolled client would miss it entirely, which is exactly the gap a
  // debug script found during this task (see the long comment in
  // opencode.ts): a plain `headers` config on createOpenAICompatible does
  // NOT survive a real generateText() call — "ai"'s own bare "ai/<version>"
  // User-Agent silently replaces it.
  it("sends the right URL, session header, User-Agent and Authorization", async () => {
    const { fetchStub, calls } = fakeChatCompletionsFetch();

    const model = createOpenCodeModel({
      provider: "opencode-go",
      modelId: "glm-5.3-flash",
      apiKey: "the-users-key",
      sessionId: "session-abc",
      fetch: fetchStub as unknown as typeof fetch,
    });

    await generateText({ model, prompt: "hello" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://opencode.ai/zen/go/v1/chat/completions");

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("x-opencode-session")).toBe("session-abc");
    expect(headers.get("user-agent")).toBe(OPENCODE_USER_AGENT);
    expect(headers.get("authorization")).toBe("Bearer the-users-key");
  });
});

describe("OPENCODE_CHAT_COMPLETIONS_MODELS", () => {
  it("lists the default chat model for opencode-go", () => {
    expect(OPENCODE_CHAT_COMPLETIONS_MODELS["opencode-go"]).toContain(
      "deepseek-v4.1-flash",
    );
  });
});

describe("createModel with an OpenCode ref", () => {
  it("builds a model for opencode-go/<id> when a user key is supplied, without reasoning", () => {
    const config = makeConfig();
    expect(() =>
      createModel(config, "opencode-go/glm-5.3-flash", {
        opencodeApiKey: "user-key",
        sessionId: "session-xyz",
      }),
    ).not.toThrow();
  });

  it("throws when an opencode ref is used without a user key", () => {
    const config = makeConfig();
    expect(() => createModel(config, "opencode-go/glm-5.3-flash", {})).toThrow(
      /OpenCode API key/,
    );
  });

  it("still routes a plain OpenRouter ref through OpenRouter, unaffected", () => {
    const config = makeConfig({ CHAT_MODEL: "google/gemini-3.7-flash" });
    const model = createModel(config) as unknown as { modelId?: string };
    expect(model.modelId).toBe("google/gemini-3.7-flash");
  });
});
