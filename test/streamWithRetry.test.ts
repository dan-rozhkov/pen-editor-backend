import { describe, expect, it, vi } from "vitest";
import type { UIMessageChunk } from "ai";
import {
  createRetriedUIMessageStream,
  type AttemptState,
  type StreamAttempt,
} from "../src/ai/streamWithRetry.js";

// Unit-level tests for createRetriedUIMessageStream that don't need a full
// server (see test/chat-route-retry.test.ts for the integration-level
// retry/trace/analytics coverage). These two cover findings #1 (backpressure)
// and #4 (onFinalError called at most once per turn).

function chunk(type: string, extra: Record<string, unknown> = {}): UIMessageChunk {
  return { type, ...extra } as UIMessageChunk;
}

/** A StreamAttempt whose toUIMessageStream just replays a fixed chunk list. */
function fixedAttempt(chunks: UIMessageChunk[]): StreamAttempt {
  return {
    toUIMessageStream: () => {
      async function* gen() {
        for (const c of chunks) yield c;
      }
      return gen();
    },
  };
}

describe("createRetriedUIMessageStream — backpressure (finding #1)", () => {
  it("pull() draws exactly one chunk at a time from the source, not the whole turn eagerly", async () => {
    let produced = 0;
    const TOTAL = 5;

    const attempt: StreamAttempt = {
      toUIMessageStream: () => {
        async function* gen() {
          for (let i = 0; i < TOTAL; i++) {
            produced++;
            // Every chunk here is content (data-*), so each one flushes
            // immediately and passes straight through — the simplest shape
            // for asserting the source is pulled lazily.
            yield chunk("data-x", { data: { i } });
          }
        }
        return gen();
      },
    };

    const stream = createRetriedUIMessageStream(() => attempt, {
      onError: () => "masked",
    });

    const reader = stream.getReader();

    // Nothing should be pulled from the source until the consumer actually
    // reads — `pull()` is demand-driven.
    expect(produced).toBe(0);

    const first = await reader.read();
    expect(first.done).toBe(false);
    // Exactly one chunk drawn from the source for one read() — the old
    // start(controller)-based implementation would have produced all 5
    // (and enqueued them into an unbounded internal queue) before the first
    // read() ever resolved.
    expect(produced).toBe(1);

    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(produced).toBe(2);

    // Drain the rest.
    let readCount = 2;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      readCount++;
    }
    expect(readCount).toBe(TOTAL);
    expect(produced).toBe(TOTAL);
  });

  it("cancel() stops draining the source (propagates via the generator's return())", async () => {
    let produced = 0;
    let returned = false;
    const attempt: StreamAttempt = {
      toUIMessageStream: () => {
        const inner = (async function* () {
          try {
            for (let i = 0; i < 5; i++) {
              produced++;
              yield chunk("data-x", { data: { i } });
            }
          } finally {
            returned = true;
          }
        })();
        return inner;
      },
    };

    const stream = createRetriedUIMessageStream(() => attempt, {
      onError: () => "masked",
    });

    const reader = stream.getReader();
    await reader.read();
    expect(produced).toBe(1);

    await reader.cancel();
    expect(returned).toBe(true);
  });
});

describe("createRetriedUIMessageStream — onFinalError fires at most once (finding #4)", () => {
  it("a turn with two post-flush error chunks calls onFinalError exactly once", async () => {
    const onFinalError = vi.fn();

    // First chunk is content (flushes the buffer immediately); the two
    // error chunks that follow arrive AFTER the flush, so neither is
    // retryable — both hit the post-flush "already flushed" branch, which
    // used to call onFinalError for every error chunk instead of once.
    const errorA = new Error("first error");
    const errorB = new Error("second error");
    const attempt = fixedAttempt([
      chunk("text-delta", { id: "t1", delta: "partial" }),
      chunk("error", { errorText: "masked A" }),
      chunk("error", { errorText: "masked B" }),
    ]);

    // The real toUIMessageStream calls options.onError(rawError) as it
    // produces each error chunk; simulate that by wrapping produce so the
    // capturedError inside streamWithRetry updates on each error chunk,
    // matching how chat.ts's attemptOnError closes over capturedError.
    const produce = (_attempt: number, _state: AttemptState): StreamAttempt => ({
      toUIMessageStream: (opts) => {
        async function* gen() {
          const chunks = (await attempt.toUIMessageStream(opts)) as AsyncIterable<UIMessageChunk>;
          let i = 0;
          for await (const c of chunks) {
            if (c.type === "error") {
              opts.onError(i === 0 ? errorA : errorB);
              i++;
            }
            yield c;
          }
        }
        return gen();
      },
    });

    const stream = createRetriedUIMessageStream(produce, {
      onError: (e) => (e instanceof Error ? e.message : String(e)),
      onFinalError,
    });

    const reader = stream.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(onFinalError).toHaveBeenCalledTimes(1);
    expect(onFinalError).toHaveBeenCalledWith(errorA);
  });
});
