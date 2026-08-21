import { APICallError } from "ai";

/**
 * Retry policy + error classifier, ported from pi (earendil-works/pi,
 * `packages/ai/src/utils/retry.ts` and `packages/ai/src/utils/provider-retry.ts`,
 * MIT). Kept close to the original: same non-retryable/retryable pattern
 * lists (checked in that order — non-retryable first, so e.g. a 429 that is
 * actually a billing/quota error never loops forever), the same
 * `baseDelayMs * 2 ** (attempt - 1)` backoff, the same `Retry-After` /
 * `retry-after-ms` handling with a 25% jitter shave and a 60s delay cap, and
 * the same abortable-sleep shape.
 *
 * What's different from pi:
 * - pi's two files (assistant-message-shaped retry + HTTP-header-shaped
 *   provider retry) are merged into one classifier here, because our call
 *   sites throw plain errors (AI SDK `generateText`/`streamText`), not
 *   pi's `AssistantMessage` result objects.
 * - `isRetryableAgentError` additionally classifies AI SDK `APICallError`
 *   by `statusCode`/`responseHeaders["x-should-retry"]` before falling back
 *   to text matching (pi's HTTP-level file did this against `Headers`
 *   objects and generic `ProviderError`; the AI SDK exposes the same
 *   information as a plain `Record<string, string>` on `APICallError`).
 * - An `AbortError` (or an aborted signal) is always non-retryable here,
 *   checked ahead of everything else — pi's abort handling lived in the
 *   surrounding assistant-message loop, not the classifier itself.
 * - `getRetryDelayMs` reads headers from `APICallError.responseHeaders`
 *   (`Record<string, string>`) instead of a `Headers` object, and exceeding
 *   the delay cap throws (mirrors pi's `validateServerRetryDelayMs`), which
 *   callers treat as "give up", not "wait forever".
 */

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
  return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PATTERN = buildProviderErrorPattern([
  // Generic quota/budget/billing exhaustion. `insufficient_quota` is
  // OpenAI's quota/billing error code; the other strings cover common
  // gateway wording (OpenRouter and others).
  "insufficient_quota",
  "out of budget",
  "quota exceeded",
  "usage limit",
  "billing",
]);

const RETRYABLE_PATTERN = buildProviderErrorPattern([
  // Generic provider load, HTTP status, and server-side transient failures.
  "overloaded",
  "rate.?limit",
  "too many requests",
  "429",
  "500",
  "502",
  "503",
  "504",
  "524",
  "service.?unavailable",
  "server.?error",
  "internal.?error",

  // Wrapper/provider text for transient upstream failures, including
  // OpenRouter "Provider returned error" responses.
  "provider.?returned.?error",

  // Network, proxy, and fetch transport failures.
  "network.?error",
  "connection.?error",
  "connection.?refused",
  "connection.?lost",
  "other side closed",
  "fetch failed",
  "getaddrinfo",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "socket hang up",
  "socket connection was closed",
  "timed? out",
  "timeout",
  "terminated",

  // Premature stream endings from SDKs and transports.
  "ended without",
  "premature close",
  "stream ended",
]);

/** Status codes the OpenAI/Anthropic SDKs retry on when no explicit signal is present. */
function isRetryableStatusCode(statusCode: number): boolean {
  return (
    statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 429 ||
    statusCode >= 500
  );
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function isRetryableByText(message: string): boolean {
  if (NON_RETRYABLE_PATTERN.test(message)) return false;
  return RETRYABLE_PATTERN.test(message);
}

/**
 * Classifies whether a thrown error from a model call (`generateText`,
 * `generateObject`, `streamText`) looks like a transient provider/transport
 * failure worth retrying.
 *
 * Order matters: non-retryable (quota/billing) patterns are checked before
 * retryable ones, so "429 quota exceeded" never loops forever just because
 * it also matches "429"/"rate limit" text.
 */
export function isRetryableAgentError(error: unknown): boolean {
  if (isAbortError(error)) return false;

  // Non-retryable (quota/billing) text wins over the statusCode shortcut
  // below — a 429 whose body says `insufficient_quota` must never be
  // classified retryable just because 429 is normally a retryable status.
  // Checked before the APICallError branch, not folded into the text
  // fallback at the bottom, so the statusCode shortcut can never skip it.
  const message = errorMessageOf(error);
  if (NON_RETRYABLE_PATTERN.test(message)) return false;

  if (APICallError.isInstance(error)) {
    const shouldRetry = error.responseHeaders?.["x-should-retry"];
    if (shouldRetry === "true") return true;
    if (shouldRetry === "false") return false;

    if (typeof error.statusCode === "number") {
      return isRetryableStatusCode(error.statusCode);
    }
  }

  return isRetryableByText(message);
}

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

export interface RetryDelayOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Parses an HTTP `Retry-After` header value (seconds, or an HTTP-date) into a millisecond delay. */
function parseRetryAfterMs(value: string): number | undefined {
  const seconds = Number.parseFloat(value);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return dateMs - Date.now();
  return undefined;
}

function validateServerRetryDelayMs(
  delayMs: number,
  maxDelayMs: number,
  errorMessage: string,
): number {
  if (maxDelayMs > 0 && delayMs > maxDelayMs) {
    throw new Error(
      `Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${errorMessage}`,
    );
  }
  return delayMs;
}

/**
 * Computes the backoff delay (ms) before retry attempt `attempt` (1-indexed:
 * the first retry is `attempt === 1`). Prefers a server-provided
 * `retry-after-ms`/`Retry-After` header (via `APICallError.responseHeaders`)
 * over the exponential default, and throws if a server-requested delay
 * exceeds `maxDelayMs` (default 60s) — callers should treat that as
 * non-retryable rather than waiting it out.
 */
export function getRetryDelayMs(
  error: unknown,
  attempt: number,
  options: RetryDelayOptions = {},
): number {
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const message = errorMessageOf(error);

  if (APICallError.isInstance(error)) {
    const headers = error.responseHeaders;
    const retryAfterMs = headers?.["retry-after-ms"];
    if (retryAfterMs) {
      const value = Number.parseFloat(retryAfterMs);
      if (!Number.isNaN(value)) {
        return validateServerRetryDelayMs(value, maxDelayMs, message);
      }
    }

    const retryAfter = headers?.["retry-after"];
    if (retryAfter) {
      const delayMs = parseRetryAfterMs(retryAfter);
      if (delayMs !== undefined) {
        return validateServerRetryDelayMs(delayMs, maxDelayMs, message);
      }
    }
  }

  const exponentialDelay = baseDelayMs * 2 ** (attempt - 1);
  const jittered = exponentialDelay * (1 - Math.random() * 0.25);
  return Math.min(jittered, maxDelayMs);
}

class RetrySleepAbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

/** Sleeps `ms` milliseconds, rejecting with an `AbortError` immediately if/when `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetrySleepAbortError());
      return;
    }
    const timeout = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new RetrySleepAbortError());
      },
      { once: true },
    );
  });
}

export interface AgentRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
}

/** Default policy for non-streaming model calls (`generateText`/`generateObject`). */
export const DEFAULT_AGENT_RETRY: AgentRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1000,
};

export interface WithAgentRetryOptions extends Partial<AgentRetryPolicy> {
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /**
   * Overrides the default {@link isRetryableAgentError} classification for
   * this call. When it returns a definite `true`/`false`, that decision
   * wins outright — e.g. to retry a caller-defined sentinel error that
   * carries no provider-shaped text/status for `isRetryableAgentError` to
   * recognize (like the showcase runner's `EmptyHarvestError`), or to force
   * a normally-retryable error to fail fast. Returning `undefined` defers
   * to the usual `isRetryableAgentError` check, so a caller only needs to
   * special-case the errors it actually cares about — everything else keeps
   * today's classification.
   */
  shouldRetry?: (error: unknown) => boolean | undefined;
}

/**
 * Runs `produce` with bounded retry on transient errors. `produce` receives
 * the attempt index (0 for the first, non-retry call). A non-retryable error
 * (per {@link isRetryableAgentError}, or `options.shouldRetry` when it
 * returns a definite `true`/`false` — see its doc comment) or an aborted
 * `signal` fails immediately; otherwise sleeps the backoff (interruptible
 * via `signal`) and retries, up to `maxRetries` times.
 */
export async function withAgentRetry<T>(
  produce: (attempt: number) => Promise<T>,
  options: WithAgentRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_AGENT_RETRY.maxRetries;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_AGENT_RETRY.baseDelayMs;
  const maxDelayMs = options.maxDelayMs;

  let attempt = 0;
  for (;;) {
    try {
      return await produce(attempt);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const overridden = options.shouldRetry?.(error);
      const retryable = overridden ?? isRetryableAgentError(error);
      if (attempt >= maxRetries || !retryable) throw error;

      attempt++;
      let delayMs: number;
      try {
        delayMs = getRetryDelayMs(error, attempt, { baseDelayMs, maxDelayMs });
      } catch {
        // Server requested a delay above the cap: getRetryDelayMs throws a
        // synthetic "Server requested Ns retry delay" error for this case,
        // but the caller should see the *original* provider error, not that
        // internal signal — same contract as createRetriedUIMessageStream's
        // own try/catch around this call.
        throw error;
      }
      options.onRetry?.({ attempt, delayMs, error });
      await abortableSleep(delayMs, options.signal);
    }
  }
}
