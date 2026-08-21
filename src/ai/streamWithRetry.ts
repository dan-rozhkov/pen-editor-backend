import { pipeUIMessageStreamToResponse, type UIMessageChunk } from "ai";
import type { ServerResponse } from "node:http";
import { abortableSleep, getRetryDelayMs, isRetryableAgentError } from "./retry.js";

/**
 * Transparent retry for the *streamed* assistant turn in `/api/chat`.
 *
 * `streamText` errors surface as an `error` chunk inside the UI message
 * stream, not as a thrown exception — by the time we see one, the client may
 * already have received earlier chunks for this turn. Retrying is only safe
 * before any real content has reached the client: once a text/tool/reasoning
 * chunk has gone out, any client-executed tool calls in it may already be
 * running in the browser, so replaying the turn would duplicate them. So:
 *
 * - Every chunk from a fresh attempt is buffered (not written to the
 *   response) until either a genuine *content* chunk appears (text/
 *   reasoning delta, a tool call, a file/source part, a `data-*` part) or
 *   the attempt ends on its own without ever erroring or aborting (a
 *   legitimate, if contentless, finish). At that point the buffer flushes
 *   to the response and every later chunk (including this one) passes
 *   straight through.
 * - An `error` chunk seen before any content flushed is retried (subject to
 *   {@link isRetryableAgentError} and the retry budget): the buffered
 *   chunks are discarded, the backoff sleeps (abortable via `signal`), and
 *   a fresh attempt is produced. An `error` chunk seen after content
 *   flushed, or one that isn't retryable, or one with no budget left,
 *   flushes and forwards as today.
 * - An `abort` chunk (client disconnect) is never retried — it flushes
 *   whatever was buffered and ends the stream, matching pre-existing
 *   behavior for a disconnected client.
 *
 * `produce(attempt, attemptState)` must build a *fresh* `streamText(...)`
 * result per attempt. `attemptState.discarded` is flipped to `true`
 * synchronously by this module the moment (and only when) an attempt's
 * error is judged retryable and about to be replayed — callers wire it into
 * that attempt's own `streamText({ onFinish, onAbort })` handlers so
 * trace/analytics side effects are skipped for a discarded attempt. This
 * flag is not defensive: AI SDK v6 *does* call `onFinish`/`onAbort` for a
 * discarded attempt (confirmed via the `[tokens] input: ...` log line
 * firing for an attempt whose stream we're about to throw away) — without
 * the `discarded` check, a retried attempt would write a second, bogus
 * `raw_traces` row and fire a false `agent_turn_completed` for a turn the
 * client never fully saw.
 *
 * Cost: silence before the first byte — a known, accepted trade-off.
 * Every chunk of a fresh attempt is buffered until content arrives (see
 * above), which includes the `start`/`start-step` chunks the AI SDK emits
 * immediately. So a turn that retries once or twice on a pre-content error
 * sends the client *nothing* — not even those bookkeeping chunks — for as
 * long as the retries take: up to the sum of every attempt's time-to-first-
 * error plus every backoff sleep between them. With the default policy
 * (`DEFAULT_AGENT_RETRY`: 2 retries, 1s base, exponential) two pre-content
 * retries alone cost ~1s + ~2s = ~3s of dead air before either the real
 * content or a final error chunk shows up, on top of however long each
 * failed attempt took to fail. This is deliberately not "fixed" by sending
 * `start` eagerly: `start` is a UI-message-stream-level chunk (one per
 * assistant message), and the client's `useChat` treats a second `start` for
 * the same turn as a protocol error / a new message, not a resumed one — so
 * an eager `start` would make a *successful* retry visibly break the client
 * instead of being invisible to it, which is the entire point of this
 * module. The bound is knowable (sum of backoffs + attempt latencies), so a
 * caller that cares can compute a worst case from its own retry policy; it
 * is not unbounded, and every chunk still arrives once one attempt commits.
 */

export interface AttemptState {
  discarded: boolean;
}

// UI message chunk types that carry no client-visible content by themselves
// (pure stream/step bookkeeping). Everything else — including `data-*` —
// counts as content and flushes the buffer.
const BOOKKEEPING_CHUNK_TYPES = new Set<string>([
  "start",
  "start-step",
  "finish-step",
  "finish",
]);

function isContentChunk(chunk: UIMessageChunk): boolean {
  if (chunk.type === "error" || chunk.type === "abort") return false;
  return !BOOKKEEPING_CHUNK_TYPES.has(chunk.type);
}

export interface StreamAttempt {
  toUIMessageStream: (options: {
    onError: (error: unknown) => string;
  }) => AsyncIterable<UIMessageChunk>;
}

export interface StreamWithRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Aborts both an in-flight attempt's backoff sleep and any further retries — e.g. client disconnect. */
  signal?: AbortSignal;
  /** Same contract as `pipeUIMessageStreamToResponse`'s `onError`: masks a thrown error into client-facing text. */
  onError: (error: unknown) => string;
  /** Fired once per retry, after a retryable pre-content error and before the backoff sleep. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Fired once, when an error is being given up on (not retried) — the same terminal failure the old `pipeUIMessageStreamToResponse` `onError` reported. */
  onFinalError?: (error: unknown) => void;
  /**
   * Fired when the client disconnects (signal aborts) while a retry's
   * backoff sleep is in progress — i.e. between attempts, so no
   * `streamText` call is active to fire its own `onAbort`. Without this,
   * that disconnect left no trace/analytics record at all, unlike every
   * other disconnect path (see `chat.ts`'s `onAbort`, which records
   * `client-aborted`).
   */
  onAbortedDuringBackoff?: () => void;
}

/**
 * Runs the attempt/buffer/retry logic and yields exactly the chunks that
 * should reach the client, in order — one `yield` per chunk, so the
 * consuming `ReadableStream`'s `pull()` can hand out one chunk at a time
 * instead of draining this generator all at once into an unbounded internal
 * queue (see {@link createRetriedUIMessageStream}'s doc comment). This
 * function implements the retry/commit contract described in the module doc
 * comment above; `createRetriedUIMessageStream` just adapts it to a
 * `ReadableStream`.
 *
 * `onFinalError` is called at most once per turn (across every attempt) —
 * guarded by `reportedFinalError` below — even though a post-flush attempt
 * can emit more than one `error` chunk (AI SDK v6 does this): without the
 * guard, each such chunk re-called it with whatever error was captured most
 * recently, writing a second `raw_traces` row and firing a second
 * `agent_turn_failed` for one turn.
 */
async function* retriedChunks(
  produce: (attempt: number, attemptState: AttemptState) => StreamAttempt,
  options: StreamWithRetryOptions,
): AsyncGenerator<UIMessageChunk> {
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const {
    maxDelayMs,
    signal,
    onError,
    onRetry,
    onFinalError,
    onAbortedDuringBackoff,
  } = options;

  let attempt = 0;
  let reportedFinalError = false;
  const reportFinalError = (error: unknown) => {
    if (reportedFinalError) return;
    reportedFinalError = true;
    onFinalError?.(error);
  };

  attemptLoop: for (;;) {
    const attemptState: AttemptState = { discarded: false };
    let capturedError: unknown;
    const attemptOnError = (error: unknown): string => {
      capturedError = error;
      return onError(error);
    };

    const uiStream = produce(attempt, attemptState).toUIMessageStream({
      onError: attemptOnError,
    });

    let buffer: UIMessageChunk[] = [];
    let flushed = false;
    // Buffered chunks aren't yielded as they're pushed — only handed out
    // (via this generator) once something decides the buffer should reach
    // the client.
    const drainBuffer = function* () {
      flushed = true;
      for (const buffered of buffer) yield buffered;
      buffer = [];
    };

    for await (const chunk of uiStream) {
      if (flushed) {
        // An error arriving after content already flushed is never
        // retried (replaying would duplicate whatever the client already
        // has), but it's still the terminal failure of this turn — the
        // same one `onFinalError` reports for a pre-content error. Skip
        // this only when the chunk isn't an error at all.
        if (chunk.type === "error") {
          reportFinalError(capturedError);
        }
        yield chunk;
        continue;
      }

      if (chunk.type === "abort") {
        buffer.push(chunk);
        yield* drainBuffer();
        continue;
      }

      if (chunk.type === "error") {
        const canRetry =
          attempt < maxRetries &&
          !signal?.aborted &&
          isRetryableAgentError(capturedError);

        if (!canRetry) {
          buffer.push(chunk);
          yield* drainBuffer();
          reportFinalError(capturedError);
          continue;
        }

        let delayMs: number;
        try {
          delayMs = getRetryDelayMs(capturedError, attempt + 1, {
            baseDelayMs,
            maxDelayMs,
          });
        } catch {
          // Server requested a delay above the cap: pi treats this as a
          // non-retryable failure rather than waiting it out.
          buffer.push(chunk);
          yield* drainBuffer();
          reportFinalError(capturedError);
          continue;
        }

        attemptState.discarded = true;
        attempt++;
        onRetry?.({ attempt, delayMs, error: capturedError });
        try {
          await abortableSleep(delayMs, signal);
        } catch {
          // Cancelled (client disconnected) during backoff: no
          // `streamText` attempt is active right now to fire its own
          // onAbort, so this is the only place that can record the
          // disconnect — end the stream with nothing further to send,
          // but tell the caller first.
          onAbortedDuringBackoff?.();
          return;
        }
        continue attemptLoop;
      }

      // Bookkeeping chunk before any content: keep buffering.
      if (!isContentChunk(chunk)) {
        buffer.push(chunk);
        continue;
      }

      // First real content chunk: flush the buffer and forward it.
      buffer.push(chunk);
      yield* drainBuffer();
    }

    // Attempt's stream ended on its own (no error/abort chunk seen as
    // the terminal event) — a legitimate finish. Flush whatever is
    // still buffered (e.g. a contentless response) and stop.
    if (!flushed) yield* drainBuffer();
    return;
  }
}

/**
 * Builds the retried `ReadableStream<UIMessageChunk>` for one assistant
 * turn. See the module doc comment above for the retry/commit contract.
 *
 * Backpressure: chunks come from {@link retriedChunks}, an async generator,
 * and this stream's `pull()` draws exactly one chunk from it per call —
 * never more. `ReadableStream` only calls `pull()` again once its internal
 * queue has room (a slow/paused consumer, e.g. a stalled client socket,
 * simply stops `pull()` from being called), so backpressure now propagates
 * all the way back through the generator into the retry loop's `for await`
 * over the provider's own stream, instead of buffering an unbounded amount
 * of the turn in memory the moment it's produced — which is what the
 * previous `start(controller)` implementation did, since `enqueue()` never
 * blocks and nothing awaited the queue draining. `cancel()` (fired when the
 * consumer stops reading, e.g. a client disconnect) calls the generator's
 * `return()` so a `for await` loop still inside `retriedChunks` unwinds
 * instead of continuing to pull from the provider unobserved.
 */
export function createRetriedUIMessageStream(
  produce: (attempt: number, attemptState: AttemptState) => StreamAttempt,
  options: StreamWithRetryOptions,
): ReadableStream<UIMessageChunk> {
  const iterator = retriedChunks(produce, options);

  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}

export function pipeRetriedUIMessageStreamToResponse(
  response: ServerResponse,
  stream: ReadableStream<UIMessageChunk>,
): void {
  pipeUIMessageStreamToResponse({ response, stream });
}
