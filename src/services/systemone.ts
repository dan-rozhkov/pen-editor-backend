import { z } from "zod";
import type { Config } from "../config.js";

// Small HTTP client for TypeSafe AI's "System One" evaluation model (Jev).
// No SDK dependency — global fetch is enough. Mirrors the shape of
// src/analysis/embeddings.ts (createEmbedder): a factory that returns null
// when the feature's API key is unset, and takes an injectable `fetchFn`
// for testability. Error-class + timeout-constant style follows
// src/services/github.ts.
//
// Vendor contract (verified live 2026-09):
//   POST {TYPESAFE_BASE_URL}/systemone
//   Headers: Authorization: Bearer <key>, Content-Type: application/json
//   Body: { state, model, questions }
//   Response: { model, answers, usage: { input_tokens, output_tokens } }
// Answers are keyed by the SAME ids the caller used for `questions`.

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
// A vendor-supplied Retry-After longer than this means giving up rather than
// sleeping through it. Chat-path callers (skillRouting.ts) budget 1.5s total
// for the whole round trip, and even the 30s REQUEST_TIMEOUT_MS above is a
// ceiling on the ENTIRE call including every retry sleep — honoring an
// arbitrarily large Retry-After (a real vendor response, e.g. 60s) would blow
// through both. Deliberately well under REQUEST_TIMEOUT_MS so a capped sleep
// still leaves room for the retry's own fetch.
const MAX_RETRY_AFTER_MS = 10_000;

// --- Question types (request side) -----------------------------------

export interface SystemOneNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface SystemOneChoiceQuestion {
  type: "choice";
  instructions: string;
  // Option -> description. A null description is allowed by the vendor.
  criteria: Record<string, string | null>;
}

export interface SystemOneScoreQuestion {
  type: "score";
  instructions: string;
  // Ordered level descriptions, low to high. At least 2.
  criteria: string[];
}

export type SystemOneQuestion =
  | SystemOneNoulQuestion
  | SystemOneChoiceQuestion
  | SystemOneScoreQuestion;

// --- Answer types (response side) -------------------------------------

export interface SystemOneNoulAnswer {
  type: "noul";
  // 0..1 probability of "yes". No confidence field — the vendor never sends
  // one for this answer kind.
  noul: number;
}

export interface SystemOneChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface SystemOneScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type SystemOneAnswer =
  | SystemOneNoulAnswer
  | SystemOneChoiceAnswer
  | SystemOneScoreAnswer;

export type SystemOneAnswers = Record<string, SystemOneAnswer>;

// --- Response validation ------------------------------------------------

const answerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    noul: z.number(),
  }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
]);

const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

const errorBodySchema = z.object({
  detail: z.object({
    error_type: z.string().optional(),
    message: z.string().optional(),
  }),
});

// --- Errors --------------------------------------------------------------

export class SystemOneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemOneError";
  }
}

export class SystemOneAuthError extends SystemOneError {
  constructor(message: string) {
    super(message);
    this.name = "SystemOneAuthError";
  }
}

export class SystemOneValidationError extends SystemOneError {
  constructor(message: string) {
    super(message);
    this.name = "SystemOneValidationError";
  }
}

export class SystemOneRateLimitError extends SystemOneError {
  constructor(message: string) {
    super(message);
    this.name = "SystemOneRateLimitError";
  }
}

export class SystemOneUpstreamError extends SystemOneError {
  constructor(message: string) {
    super(message);
    this.name = "SystemOneUpstreamError";
  }
}

// --- Client ---------------------------------------------------------------

export interface SystemOneEvaluateParams<
  Q extends Record<string, SystemOneQuestion>,
> {
  state: string | Record<string, unknown> | unknown[];
  questions: Q;
  signal?: AbortSignal;
}

export interface SystemOneResult<Q extends Record<string, SystemOneQuestion>> {
  model: string;
  answers: Record<keyof Q, SystemOneAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface SystemOneClient {
  evaluate<Q extends Record<string, SystemOneQuestion>>(
    params: SystemOneEvaluateParams<Q>,
  ): Promise<SystemOneResult<Q>>;
}

async function extractDetailMessage(response: Response): Promise<string | undefined> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data.detail.message;
  } catch {
    // Not JSON, or didn't match the documented error shape — fall through
    // to returning the raw text below so the error still carries something
    // useful.
  }
  return text.slice(0, 300);
}

function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

// Takes the signal so the pending setTimeout can be cleared on abort. In the
// chat path (skillRouting.ts) an abort mid-backoff is the NORMAL case, not
// an edge case: its 1.5s budget aborts during the 500ms/1000ms backoff on
// almost every rate-limited turn. Without clearTimeout here, abortableSleep
// below still rejects promptly (it races the signal independently), but the
// underlying timer stays pending and ref'd for up to MAX_RETRY_AFTER_MS —
// one leaked live timer per aborted retry under sustained rate limiting.
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Consuming or cancelling a response body before discarding it is required
// under undici: an unread body keeps the connection checked out of the pool
// until the Response is garbage-collected, not until it goes out of scope.
// On a retryable 429/529 we read only `response.headers` and loop, so
// without this a vendor that rate-limits repeatedly makes sockets
// accumulate across retries. Wrapped in try/catch because a throw here must
// never break the retry loop — losing one body is harmless, losing the
// retry isn't. Callers must not invoke this after already consuming the
// body (e.g. via extractDetailMessage's `.text()`) — cancelling a
// already-consumed body is a no-op in practice, but the oversized
// Retry-After branch below skips this call entirely to keep that
// consumed-once invariant explicit.
async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort — see comment above.
  }
}

// Races `sleepFn(ms)` against `signal` so a retry wait can never outlive the
// caller's budget (the combined per-request timeout/abort signal). Without
// this, a signal-unaware `await sleepFn(...)` would block for the full
// duration regardless of an outer abort — exactly the bug this guards
// against (a 429 with a long Retry-After consuming a 1.5s chat-path budget).
// Rejects with the signal's abort reason so the caller's existing fail-open
// try/catch handles it exactly like any other SystemOne failure.
function abortableSleep(
  ms: number,
  signal: AbortSignal,
  sleepFn: (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // This outer race stays even though defaultSleep now clears its own
    // timer on abort: sleepFn is injectable, and a test/caller-supplied
    // implementation that ignores `signal` (e.g. this file's own
    // "hanging" test fixture) must still be interruptible from the
    // caller's point of view.
    sleepFn(ms, signal).then(
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export function createSystemOne(
  config: Config,
  fetchFn: typeof fetch = fetch,
  sleepFn: (ms: number, signal: AbortSignal) => Promise<void> = defaultSleep,
): SystemOneClient | null {
  const apiKey = config.TYPESAFE_API_KEY;
  if (!apiKey) return null;
  const model = config.TYPESAFE_MODEL;
  const url = `${config.TYPESAFE_BASE_URL}/systemone`;

  return {
    async evaluate<Q extends Record<string, SystemOneQuestion>>({
      state,
      questions,
      signal,
    }: SystemOneEvaluateParams<Q>): Promise<SystemOneResult<Q>> {
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const combinedSignal = signal
        ? AbortSignal.any([timeoutSignal, signal])
        : timeoutSignal;

      let lastError: SystemOneError | undefined;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const response = await fetchFn(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ state, model, questions }),
          signal: combinedSignal,
        });

        if (response.ok) {
          // A 200 with a truncated body, or an HTML error page served with
          // status 200 by a misconfigured proxy/CDN in front of the
          // vendor, makes `.json()` throw a raw SyntaxError here — without
          // this wrapper that escapes the SystemOneError hierarchy every
          // caller (and skillRouting.ts's fail-open catch) is written
          // against.
          let json: unknown;
          try {
            json = await response.json();
          } catch (err) {
            throw new SystemOneValidationError(
              `System One returned a non-JSON response: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          const parsed = responseSchema.safeParse(json);
          if (!parsed.success) {
            throw new SystemOneValidationError(
              `System One returned a malformed response: ${parsed.error.message}`,
            );
          }
          for (const id of Object.keys(questions)) {
            if (!(id in parsed.data.answers)) {
              throw new SystemOneValidationError(
                `System One response is missing an answer for question "${id}".`,
              );
            }
          }
          return {
            model: parsed.data.model,
            answers: parsed.data.answers as Record<keyof Q, SystemOneAnswer>,
            usage: parsed.data.usage,
          };
        }

        const retryable = response.status === 429 || response.status === 529;
        if (retryable && attempt < MAX_RETRIES) {
          const retryAfterMs = parseRetryAfterMs(response);
          if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
            // Give up rather than sleeping through an oversized Retry-After —
            // see MAX_RETRY_AFTER_MS's comment. Falls through to the same
            // error mapping below instead of retrying.
            const detailMessage = await extractDetailMessage(response);
            const suffix = detailMessage ? `: ${detailMessage}` : "";
            throw new SystemOneRateLimitError(
              `System One requested a Retry-After of ${retryAfterMs}ms, exceeding the ` +
                `${MAX_RETRY_AFTER_MS}ms cap; giving up rather than blocking the request${suffix}`,
            );
          }
          // Discard the body before retrying — see discardResponseBody's
          // comment. The oversized-Retry-After branch above already
          // consumed it via extractDetailMessage's `.text()`, so it
          // deliberately skips this call rather than reading twice.
          await discardResponseBody(response);
          const backoffMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
          await abortableSleep(retryAfterMs ?? backoffMs, combinedSignal, sleepFn);
          continue;
        }

        const detailMessage = await extractDetailMessage(response);
        const suffix = detailMessage ? `: ${detailMessage}` : "";
        if (response.status === 401) {
          throw new SystemOneAuthError(
            `System One authentication failed${suffix}`,
          );
        }
        if (response.status === 422) {
          throw new SystemOneValidationError(
            `System One rejected the request${suffix}`,
          );
        }
        if (response.status === 429) {
          lastError = new SystemOneRateLimitError(
            `System One rate limit exceeded after ${MAX_RETRIES} retries${suffix}`,
          );
          throw lastError;
        }
        throw new SystemOneUpstreamError(
          `System One returned ${response.status}${suffix}`,
        );
      }

      // Unreachable — the loop above always returns or throws — but kept
      // for exhaustiveness so this function's control flow type-checks.
      throw (
        lastError ??
        new SystemOneUpstreamError("System One request failed for an unknown reason.")
      );
    },
  };
}
