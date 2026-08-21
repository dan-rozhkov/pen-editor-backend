import { describe, expect, it, vi, afterEach } from "vitest";
import { APICallError } from "ai";
import {
  abortableSleep,
  getRetryDelayMs,
  isRetryableAgentError,
  withAgentRetry,
} from "../src/ai/retry.js";

function apiCallError(overrides: Partial<ConstructorParameters<typeof APICallError>[0]> = {}) {
  return new APICallError({
    message: overrides.message ?? "boom",
    url: "https://example.test/v1/chat",
    requestBodyValues: {},
    ...overrides,
  });
}

describe("isRetryableAgentError", () => {
  it("classifies generic transient-provider text as retryable", () => {
    expect(isRetryableAgentError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isRetryableAgentError(new Error("rate limit exceeded"))).toBe(true);
    expect(isRetryableAgentError(new Error("Provider returned error"))).toBe(true);
    expect(isRetryableAgentError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableAgentError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableAgentError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableAgentError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isRetryableAgentError(new Error("request timed out"))).toBe(true);
    expect(isRetryableAgentError(new Error("stream ended unexpectedly"))).toBe(true);
  });

  it("classifies quota/billing text as non-retryable even though it also contains retryable-looking tokens", () => {
    expect(isRetryableAgentError(new Error("insufficient_quota"))).toBe(false);
    expect(isRetryableAgentError(new Error("You have exceeded your current quota, please check your billing details"))).toBe(false);
    expect(isRetryableAgentError(new Error("out of budget"))).toBe(false);
    expect(isRetryableAgentError(new Error("Monthly usage limit reached"))).toBe(false);
  });

  it("checks non-retryable patterns before retryable ones — '429 quota exceeded' never loops forever", () => {
    // Matches both "429" (retryable) and "quota exceeded" (non-retryable);
    // non-retryable must win.
    expect(isRetryableAgentError(new Error("429 quota exceeded"))).toBe(false);
  });

  it("defaults unrecognized errors to non-retryable", () => {
    expect(isRetryableAgentError(new Error("something completely unrelated"))).toBe(false);
  });

  it("never retries an AbortError, regardless of message text", () => {
    const err = new Error("rate limit exceeded");
    err.name = "AbortError";
    expect(isRetryableAgentError(err)).toBe(false);
  });

  it("classifies an APICallError by status code when present, before falling back to text", () => {
    expect(isRetryableAgentError(apiCallError({ statusCode: 429, message: "nonsense text" }))).toBe(true);
    expect(isRetryableAgentError(apiCallError({ statusCode: 500 }))).toBe(true);
    expect(isRetryableAgentError(apiCallError({ statusCode: 503 }))).toBe(true);
    expect(isRetryableAgentError(apiCallError({ statusCode: 408 }))).toBe(true);
    expect(isRetryableAgentError(apiCallError({ statusCode: 409 }))).toBe(true);
    expect(isRetryableAgentError(apiCallError({ statusCode: 400 }))).toBe(false);
    expect(isRetryableAgentError(apiCallError({ statusCode: 401 }))).toBe(false);
    expect(isRetryableAgentError(apiCallError({ statusCode: 403 }))).toBe(false);
    expect(isRetryableAgentError(apiCallError({ statusCode: 404 }))).toBe(false);
    expect(isRetryableAgentError(apiCallError({ statusCode: 413 }))).toBe(false);
    expect(isRetryableAgentError(apiCallError({ statusCode: 422 }))).toBe(false);
  });

  it("respects an explicit x-should-retry header over the status code", () => {
    expect(
      isRetryableAgentError(
        apiCallError({ statusCode: 400, responseHeaders: { "x-should-retry": "true" } }),
      ),
    ).toBe(true);
    expect(
      isRetryableAgentError(
        apiCallError({ statusCode: 500, responseHeaders: { "x-should-retry": "false" } }),
      ),
    ).toBe(false);
  });

  it("falls back to text matching for an APICallError without a status code", () => {
    expect(isRetryableAgentError(apiCallError({ message: "socket hang up" }))).toBe(true);
    expect(isRetryableAgentError(apiCallError({ message: "insufficient_quota" }))).toBe(false);
  });

  it("classifies a 429 APICallError with quota/billing text as non-retryable, not by its status code", () => {
    // Regression: the statusCode shortcut used to run before the
    // non-retryable text check, so a 429 with `insufficient_quota` in the
    // body was (wrongly) classified retryable and burned the full retry
    // budget on every doomed quota-exhausted call.
    expect(
      isRetryableAgentError(
        apiCallError({ statusCode: 429, message: "insufficient_quota" }),
      ),
    ).toBe(false);
    expect(
      isRetryableAgentError(
        apiCallError({ statusCode: 429, message: "quota exceeded" }),
      ),
    ).toBe(false);
  });
});

describe("getRetryDelayMs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses exponential backoff with jitter when no retry header is present", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    // attempt 1: baseDelayMs * 2^0, no jitter shave at random()=0
    expect(getRetryDelayMs(new Error("503"), 1, { baseDelayMs: 1000 })).toBe(1000);
    // attempt 2: baseDelayMs * 2^1
    expect(getRetryDelayMs(new Error("503"), 2, { baseDelayMs: 1000 })).toBe(2000);
    // attempt 3: baseDelayMs * 2^2
    expect(getRetryDelayMs(new Error("503"), 3, { baseDelayMs: 1000 })).toBe(4000);
  });

  it("shaves up to 25% off the exponential delay via jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // max shave
    // jittered = exponentialDelay * (1 - 1 * 0.25) = exponentialDelay * 0.75
    expect(getRetryDelayMs(new Error("503"), 1, { baseDelayMs: 1000 })).toBe(750);
  });

  it("keeps jitter within [0.75, 1] of the exponential delay for any random() in [0,1)", () => {
    for (const r of [0, 0.1, 0.5, 0.9, 0.999]) {
      vi.spyOn(Math, "random").mockReturnValue(r);
      const delay = getRetryDelayMs(new Error("503"), 1, { baseDelayMs: 1000 });
      expect(delay).toBeGreaterThanOrEqual(750);
      expect(delay).toBeLessThanOrEqual(1000);
    }
  });

  it("prefers retry-after-ms over the exponential default", () => {
    const err = apiCallError({ responseHeaders: { "retry-after-ms": "1500" } });
    expect(getRetryDelayMs(err, 1, { baseDelayMs: 1000 })).toBe(1500);
  });

  it("parses retry-after in seconds", () => {
    const err = apiCallError({ responseHeaders: { "retry-after": "5" } });
    expect(getRetryDelayMs(err, 1)).toBe(5000);
  });

  it("parses retry-after as an HTTP-date", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const err = apiCallError({ responseHeaders: { "retry-after": future } });
    const delay = getRetryDelayMs(err, 1);
    // Allow a little slack for wall-clock time elapsed between Date.now() calls.
    expect(delay).toBeGreaterThan(8000);
    expect(delay).toBeLessThanOrEqual(10000);
  });

  it("throws when a server-requested delay exceeds the cap, instead of waiting it out", () => {
    const err = apiCallError({ responseHeaders: { "retry-after-ms": "120000" } });
    expect(() => getRetryDelayMs(err, 1, { maxDelayMs: 60_000 })).toThrow(/60s/);
  });

  it("does not throw for a server-requested delay at or under the cap", () => {
    const err = apiCallError({ responseHeaders: { "retry-after-ms": "60000" } });
    expect(() => getRetryDelayMs(err, 1, { maxDelayMs: 60_000 })).not.toThrow();
  });
});

describe("abortableSleep", () => {
  it("resolves after the delay", async () => {
    await expect(abortableSleep(5)).resolves.toBeUndefined();
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(1000, controller.signal)).rejects.toThrow();
  });

  it("rejects as soon as the signal aborts mid-sleep, without waiting out the full delay", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = abortableSleep(10_000, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(sleeping).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("withAgentRetry", () => {
  it("returns the result immediately on success, without retrying", async () => {
    const produce = vi.fn().mockResolvedValue("ok");
    const result = await withAgentRetry(produce, { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable error up to maxRetries, then succeeds", async () => {
    const produce = vi
      .fn()
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockRejectedValueOnce(new Error("502 Bad Gateway"))
      .mockResolvedValueOnce("ok");
    const onRetry = vi.fn();

    const result = await withAgentRetry(produce, {
      maxRetries: 2,
      baseDelayMs: 1,
      onRetry,
    });

    expect(result).toBe("ok");
    expect(produce).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on a non-retryable error, without retrying", async () => {
    const produce = vi.fn().mockRejectedValue(new Error("insufficient_quota"));
    await expect(withAgentRetry(produce, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow(
      "insufficient_quota",
    );
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("throws once the retry budget is exhausted", async () => {
    const produce = vi.fn().mockRejectedValue(new Error("503 Service Unavailable"));
    await expect(withAgentRetry(produce, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow(
      "503",
    );
    expect(produce).toHaveBeenCalledTimes(3);
  });

  it("never retries once the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const produce = vi.fn().mockRejectedValue(new Error("503 Service Unavailable"));
    await expect(
      withAgentRetry(produce, { maxRetries: 2, baseDelayMs: 1, signal: controller.signal }),
    ).rejects.toThrow("503");
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("rejects with the ORIGINAL provider error, not a synthetic delay-cap error, when the server-requested delay exceeds maxDelayMs", async () => {
    // apiCallError with a retry-after-ms header above maxDelayMs makes
    // getRetryDelayMs throw internally; withAgentRetry must surface the real
    // provider error to the caller, not that internal "Server requested Ns
    // retry delay" message.
    const providerError = apiCallError({
      message: "503 Service Unavailable",
      responseHeaders: { "retry-after-ms": "120000" },
    });
    const produce = vi.fn().mockRejectedValue(providerError);
    await expect(
      withAgentRetry(produce, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 60_000 }),
    ).rejects.toBe(providerError);
    expect(produce).toHaveBeenCalledTimes(1);
  });
});
