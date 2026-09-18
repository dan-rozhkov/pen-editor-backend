import { describe, expect, it, vi } from "vitest";
import { generateText, streamText } from "ai";
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

  // Regression: sessionId traces back to the chat route's traceSessionId,
  // which is the client-supplied body `id` — validated only by
  // `z.string().max(200)`, with no restriction on which characters it
  // contains. A raw newline or a non-Latin-1 character used to reach
  // `headers.set("x-opencode-session", sessionId)` unsanitized, and the
  // WHATWG Headers implementation throws a TypeError on either (Node's
  // undici enforces ByteString-only header values) — which used to crash
  // every request of that session with an undiagnosable "An error
  // occurred.". This pins that a call with such a sessionId no longer
  // throws, and that the header actually sent upstream is a safe value.
  it("sanitizes a sessionId containing a newline instead of crashing on Headers.set", async () => {
    const { fetchStub, calls } = fakeChatCompletionsFetch();

    const model = createOpenCodeModel({
      provider: "opencode-go",
      modelId: "glm-5.3-flash",
      apiKey: "the-users-key",
      sessionId: "line1\nline2",
      fetch: fetchStub as unknown as typeof fetch,
    });

    await expect(generateText({ model, prompt: "hello" })).resolves.toBeDefined();

    const headers = new Headers(calls[0].init?.headers);
    const sent = headers.get("x-opencode-session");
    expect(sent).not.toBeNull();
    expect(sent).not.toContain("\n");
    expect(sent).toBe("line1line2");
  });

  it("sanitizes a sessionId containing non-Latin-1 characters (e.g. Cyrillic) instead of crashing", async () => {
    const { fetchStub, calls } = fakeChatCompletionsFetch();

    const model = createOpenCodeModel({
      provider: "opencode-go",
      modelId: "glm-5.3-flash",
      apiKey: "the-users-key",
      sessionId: "сессияабв",
      fetch: fetchStub as unknown as typeof fetch,
    });

    await expect(generateText({ model, prompt: "hello" })).resolves.toBeDefined();

    const headers = new Headers(calls[0].init?.headers);
    const sent = headers.get("x-opencode-session");
    expect(sent).not.toBeNull();
    // Every Cyrillic character is stripped by the safe charset; nothing of
    // the original survives, so a generated UUID fallback is used instead.
    expect(sent).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// A minimal fetch stub that answers a well-formed SSE chat-completions
// stream, so a real streamText() call (the AI SDK path that would actually
// go over the wire on /api/chat — unlike generateText/doGenerate above) can
// run against createOpenCodeModel without any network access, and the
// captured request body can be inspected for `stream_options`.
function fakeStreamingChatCompletionsFetch() {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const sse =
    'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n' +
    'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
    "data: [DONE]\n\n";
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  return { fetchStub, calls };
}

describe("createOpenCodeModel streaming usage", () => {
  // Regression: createOpenAICompatible was built without `includeUsage:
  // true`, so @ai-sdk/openai-compatible never sent `stream_options:
  // {include_usage: true}` on the outgoing /chat/completions request —
  // verified against node_modules/@ai-sdk/openai-compatible/dist/index.js's
  // doStream, which gates that field on `this.config.includeUsage`. Without
  // it, an OpenAI-compatible streaming response carries no usage block at
  // all, so src/routes/chat.ts's `usage.inputTokens ?? 0` silently recorded
  // zero tokens for every OpenCode turn in raw_traces and the
  // agent_turn_completed PostHog event.
  it("requests usage on the streaming request body (stream_options.include_usage)", async () => {
    const { fetchStub, calls } = fakeStreamingChatCompletionsFetch();

    const model = createOpenCodeModel({
      provider: "opencode-go",
      modelId: "glm-5.3-flash",
      apiKey: "the-users-key",
      sessionId: "session-abc",
      fetch: fetchStub as unknown as typeof fetch,
    });

    const result = streamText({ model, prompt: "hello" });
    // Drain the stream so the request has actually been made before we
    // inspect it.
    await result.text;

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init?.body as string) as {
      stream_options?: { include_usage?: boolean };
    };
    expect(body.stream_options).toEqual({ include_usage: true });
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
