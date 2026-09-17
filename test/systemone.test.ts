import { describe, expect, it, vi } from "vitest";
import {
  createSystemOne,
  SystemOneAuthError,
  SystemOneRateLimitError,
  SystemOneValidationError,
  type SystemOneQuestion,
} from "../src/services/systemone.js";
import { makeConfig } from "./helpers.js";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers });
}

const questions: Record<string, SystemOneQuestion> = {
  isSpam: { type: "noul", instructions: "Is this spam?" },
  category: {
    type: "choice",
    instructions: "Pick a category",
    criteria: { a: "Category A", b: null },
  },
  quality: {
    type: "score",
    instructions: "Rate the quality",
    criteria: ["poor", "fair", "good"],
  },
};

const goodAnswers = {
  isSpam: { type: "noul", noul: 0.1 },
  category: {
    type: "choice",
    choice: "a",
    probabilities: { a: 0.9, b: 0.1 },
    confidence: 0.9,
  },
  quality: {
    type: "score",
    score: 2,
    legend: { "0": "poor", "1": "fair", "2": "good" },
    probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
    confidence: 0.7,
  },
};

const goodResponseBody = {
  model: "jev-latest",
  answers: goodAnswers,
  usage: { input_tokens: 10, output_tokens: 5 },
};

// A no-op sleep so retry tests don't actually wait — passed into the
// factory's injectable sleepFn param.
const noSleep = vi.fn(async () => {});

describe("createSystemOne", () => {
  it("returns null without an API key", () => {
    expect(createSystemOne(makeConfig())).toBeNull();
  });

  it("returns a client when the key is set", () => {
    const client = createSystemOne(makeConfig({ TYPESAFE_API_KEY: "k" }));
    expect(client).not.toBeNull();
  });

  it("sends the exact request shape and parses a mixed response", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(goodResponseBody));
    const client = createSystemOne(
      makeConfig({ TYPESAFE_API_KEY: "k", TYPESAFE_MODEL: "jev-latest" }),
      fetchFn as unknown as typeof fetch,
      noSleep,
    );

    const result = await client!.evaluate({ state: "hello world", questions });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer k",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({
      state: "hello world",
      model: "jev-latest",
      questions,
    });

    expect(result.model).toBe("jev-latest");
    expect(result.answers.isSpam).toEqual({ type: "noul", noul: 0.1 });
    expect(result.answers.category).toEqual(goodAnswers.category);
    expect(result.answers.quality).toEqual(goodAnswers.quality);
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("throws when the response is missing an answer for a requested question", async () => {
    const { quality: _quality, ...partialAnswers } = goodAnswers;
    const fetchFn = vi.fn(async () =>
      jsonResponse({ ...goodResponseBody, answers: partialAnswers }),
    );
    const client = createSystemOne(
      makeConfig({ TYPESAFE_API_KEY: "k" }),
      fetchFn as unknown as typeof fetch,
      noSleep,
    );
    await expect(client!.evaluate({ state: "x", questions })).rejects.toThrow(
      SystemOneValidationError,
    );
  });

  it("throws a validation error for a malformed noul answer", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        ...goodResponseBody,
        answers: { ...goodAnswers, isSpam: { type: "noul" } },
      }),
    );
    const client = createSystemOne(
      makeConfig({ TYPESAFE_API_KEY: "k" }),
      fetchFn as unknown as typeof fetch,
      noSleep,
    );
    await expect(client!.evaluate({ state: "x", questions })).rejects.toThrow(
      SystemOneValidationError,
    );
  });

  it("throws a validation error for an unknown answer type", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        ...goodResponseBody,
        answers: { ...goodAnswers, isSpam: { type: "mystery", value: 1 } },
      }),
    );
    const client = createSystemOne(
      makeConfig({ TYPESAFE_API_KEY: "k" }),
      fetchFn as unknown as typeof fetch,
      noSleep,
    );
    await expect(client!.evaluate({ state: "x", questions })).rejects.toThrow(
      SystemOneValidationError,
    );
  });

  it("maps 401 to SystemOneAuthError", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        {
          detail: {
            error_type: "authentication_error",
            message:
              "Cannot authenticate with the server. Please check your API key and try again.",
          },
        },
        401,
      ),
    );
    const client = createSystemOne(
      makeConfig({ TYPESAFE_API_KEY: "bad" }),
      fetchFn as unknown as typeof fetch,
      noSleep,
    );
    await expect(client!.evaluate({ state: "x", questions })).rejects.toThrow(
      SystemOneAuthError,
    );
    await expect(client!.evaluate({ state: "x", questions })).rejects.toThrow(
      /Cannot authenticate/,
    );
  });

  it("maps 422 to SystemOneValidationError", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        { detail: { error_type: "validation_error", message: "bad questions" } },
        422,
      ),
    );
    const client = createSystemOne(
      makeConfig({ TYPESAFE_API_KEY: "k" }),
      fetchFn as unknown as typeof fetch,
      noSleep,
    );
    await expect(client!.evaluate({ state: "x", questions })).rejects.toThrow(
      SystemOneValidationError,
    );
  });

  it("retries once on 429 then succeeds", async () => {
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call++;
      if (call === 1) {
        return jsonResponse({ detail: { message: "rate limited" } }, 429);
      }
      return jsonResponse(goodResponseBody);
    });
    const sleepFn = vi.fn(async () => {});
    const client = createSystemOne(
      makeConfig({ TYPESAFE_API_KEY: "k" }),
      fetchFn as unknown as typeof fetch,
      sleepFn,
    );
    const result = await client!.evaluate({ state: "x", questions });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.model).toBe("jev-latest");
  });

  it("honors the retry-after header instead of exponential backoff", async () => {
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call++;
      if (call === 1) {
        return jsonResponse(
          { detail: { message: "rate limited" } },
          429,
          { "retry-after": "7" },
        );
      }
      return jsonResponse(goodResponseBody);
    });
    const sleepFn = vi.fn(async () => {});
    const client = createSystemOne(
      makeConfig({ TYPESAFE_API_KEY: "k" }),
      fetchFn as unknown as typeof fetch,
      sleepFn,
    );
    await client!.evaluate({ state: "x", questions });
    expect(sleepFn).toHaveBeenCalledWith(7000);
  });

  it("throws SystemOneRateLimitError after exhausting retries on repeated 429s", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ detail: { message: "rate limited" } }, 429),
    );
    const sleepFn = vi.fn(async () => {});
    const client = createSystemOne(
      makeConfig({ TYPESAFE_API_KEY: "k" }),
      fetchFn as unknown as typeof fetch,
      sleepFn,
    );
    await expect(client!.evaluate({ state: "x", questions })).rejects.toThrow(
      SystemOneRateLimitError,
    );
    // Initial attempt + MAX_RETRIES (3) retries = 4 calls.
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("retries 529s and eventually maps to SystemOneUpstreamError", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ detail: { message: "overloaded" } }, 529),
    );
    const sleepFn = vi.fn(async () => {});
    const client = createSystemOne(
      makeConfig({ TYPESAFE_API_KEY: "k" }),
      fetchFn as unknown as typeof fetch,
      sleepFn,
    );
    await expect(client!.evaluate({ state: "x", questions })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("returns promptly when the caller's signal aborts during a retry sleep", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ detail: { message: "rate limited" } }, 429),
    );
    // A sleepFn that never resolves on its own — only an abort can end the
    // wait. If the retry sleep were not abortable, this test would hang
    // (and time out) instead of rejecting promptly.
    const hangingSleep = vi.fn(() => new Promise<void>(() => {}));
    const client = createSystemOne(
      makeConfig({ TYPESAFE_API_KEY: "k" }),
      fetchFn as unknown as typeof fetch,
      hangingSleep,
    );
    const controller = new AbortController();
    const promise = client!.evaluate({ state: "x", questions, signal: controller.signal });
    controller.abort(new Error("caller gave up"));
    await expect(promise).rejects.toThrow("caller gave up");
    // Only the initial attempt fired — the abort interrupted the sleep
    // before a second fetch could happen.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("gives up instead of sleeping through a Retry-After beyond the cap", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        { detail: { message: "rate limited" } },
        429,
        // 60s — far beyond MAX_RETRY_AFTER_MS.
        { "retry-after": "60" },
      ),
    );
    const sleepFn = vi.fn(async () => {});
    const client = createSystemOne(
      makeConfig({ TYPESAFE_API_KEY: "k" }),
      fetchFn as unknown as typeof fetch,
      sleepFn,
    );
    await expect(client!.evaluate({ state: "x", questions })).rejects.toThrow(
      SystemOneRateLimitError,
    );
    expect(sleepFn).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
