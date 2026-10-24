import { wrapLanguageModel } from "ai";
import type { LanguageModel } from "ai";

type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: "v4" }>;

export interface StepWatchdogOptions {
  /** No part within this many ms: abort the attempt and retry once. 0 = off. */
  firstChunkMs: number;
  /** After the first part, no next part within this many ms: error. 0 = off. */
  idleMs: number;
  /** Structured warning sink; defaults to console.warn. */
  warn?: (message: string, fields: Record<string, unknown>) => void;
}

const wrapped = new WeakSet<object>();

/** True for a model returned by withStepWatchdog. */
export function hasStepWatchdog(model: unknown): boolean {
  return typeof model === "object" && model !== null && wrapped.has(model);
}

function defaultWarn(message: string, fields: Record<string, unknown>): void {
  console.warn(`[browseStep] ${message}`, JSON.stringify(fields));
}

class TimedOut extends Error {}

/** Rejects with TimedOut after `ms` (0 = never). The timer is always cleared. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimedOut()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Bounds one nested browse step.
 *
 * Turn-level retry (src/ai/streamWithRetry.ts, used by /api/chat for every
 * turn, nested browse turns included) replays only while no content chunk has
 * reached the client, and classifies by message via isRetryableAgentError.
 * Both error texts below contain "timed out" so that retry picks them up. This
 * is safe: the first-part error fires before any model output is forwarded, and
 * after the first part the replay guard itself refuses once content went out.
 * Wraps ONLY the browse subagent model.
 * - First-part timeout (covers doStream() and reads up to the first part that is
 *   real model output; stream-start/response-metadata/raw do not count): abort that
 *   attempt and retry once. Safe because no part is forwarded before the
 *   first one arrives.
 * - Idle timeout: after the first part, error the stream (no retry).
 * - A caller abort passes through untouched (no retry, no extra error).
 */
export function withStepWatchdog(model: LanguageModel, options: StepWatchdogOptions): LanguageModel {
  const { firstChunkMs, idleMs } = options;
  if (firstChunkMs <= 0 && idleMs <= 0) return model;
  const warn = options.warn ?? defaultWarn;

  const result = wrapLanguageModel({
    model: model as LanguageModelV4,
    middleware: {
      specificationVersion: "v4",
      wrapStream: async ({ model: inner, params }) => {
        const callerSignal = params.abortSignal;
        type Started = Awaited<ReturnType<typeof inner.doStream>>;
        type Part = Started["stream"] extends ReadableStream<infer T> ? T : never;

        type Attempt = {
          started: Started;
          reader: ReadableStreamDefaultReader<Part>;
          /** Leading bookkeeping parts (stream-start, response-metadata, raw), held back. */
          buffered: Part[];
          /** First part that is real model output, or the end of the stream. */
          first: ReadableStreamReadResult<Part>;
        };

        // Providers enqueue a synthetic `stream-start` at once and may send
        // `response-metadata` at the response headers. Neither proves the model
        // is producing output, so the first-part timer keeps running past them.
        const isLeading = (p: Part): boolean =>
          p.type === "stream-start" || p.type === "response-metadata" || p.type === "raw";

        async function run(signal: AbortSignal): Promise<Attempt> {
          // Every attempt calls the inner model with a signal this wrapper can abort.
          const started = await inner.doStream({ ...params, abortSignal: signal });
          const reader = started.stream.getReader() as ReadableStreamDefaultReader<Part>;
          // A timed-out attempt whose doStream resolved late: release it, read nothing.
          if (signal.aborted) {
            await reader.cancel().catch(() => {});
            throw signal.reason ?? new Error("attempt aborted");
          }
          const buffered: Part[] = [];
          for (;;) {
            const r = await reader.read();
            if (r.done || !isLeading(r.value)) return { started, reader, buffered, first: r };
            buffered.push(r.value);
          }
        }

        let won: Attempt | undefined;
        let liveCtl: AbortController | undefined;
        for (let n = 1; n <= 2 && !won; n++) {
          const ctl = new AbortController();
          const signal = callerSignal ? AbortSignal.any([callerSignal, ctl.signal]) : ctl.signal;
          const attempt = run(signal);
          try {
            won = await within(attempt, firstChunkMs);
            liveCtl = ctl;
          } catch (e) {
            if (!(e instanceof TimedOut)) throw e;
            ctl.abort();
            // The abandoned attempt may still resolve later: release its stream then.
            attempt.then((res) => res.reader.cancel().catch(() => {}), () => {});
            // A caller abort at the retry boundary is not a stall: no warning, no retry.
            if (callerSignal?.aborted) throw callerSignal.reason;
            warn("no response from the model", { attempt: n, ms: firstChunkMs });
            if (n === 2) throw new Error(`browse step timed out: no response from the model in ${firstChunkMs} ms (2 attempts)`, { cause: e });
          }
        }
        // The loop exits only with `won` set or by throwing.
        const { started, reader: live, buffered, first } = won!;
        const ctlLive = liveCtl!;
        const pendingParts: Part[] = [...buffered];
        let pending: ReadableStreamReadResult<Part> | undefined = first;

        const stream = new ReadableStream<Part>({
          async pull(controller) {
            try {
              const head = pendingParts.shift();
              if (head) {
                controller.enqueue(head);
                return;
              }
              let r = pending;
              pending = undefined;
              if (!r) {
                try {
                  r = await within(live.read(), idleMs);
                } catch (e) {
                  if (!(e instanceof TimedOut)) throw e;
                  warn("model stream went idle", { ms: idleMs });
                  ctlLive.abort();
                  void live.cancel().catch(() => {});
                  controller.error(new Error(`browse step timed out: the model stream stalled for ${idleMs} ms`));
                  return;
                }
              }
              if (r.done) controller.close();
              else controller.enqueue(r.value);
            } catch (e) {
              controller.error(e);
            }
          },
          cancel(reason) {
            return live.cancel(reason);
          },
        });
        return { ...started, stream };
      },
    },
  }) as LanguageModel;
  wrapped.add(result as object);
  return result;
}
