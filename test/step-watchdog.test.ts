import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { withStepWatchdog } from "../src/ai/stepWatchdog.js";
import { isRetryableAgentError } from "../src/ai/retry.js";

type Part = LanguageModelV4StreamPart;
const text = (id: string): Part[] => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: "hi" },
  { type: "text-end", id },
];

// A stream the test controls: push parts by hand, or never.
function controlled() {
  let ctrl!: ReadableStreamDefaultController<Part>;
  const stream = new ReadableStream<Part>({ start: (c) => void (ctrl = c) });
  return { stream, push: (p: Part) => ctrl.enqueue(p), close: () => ctrl.close() };
}

const textStream = (id: string) => new ReadableStream<Part>({ start(c) { text(id).forEach((x) => c.enqueue(x)); c.close(); } });

async function drain(stream: ReadableStream<Part>): Promise<Part[]> {
  const out: Part[] = [];
  const r = stream.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) return out;
    out.push(value);
  }
}

const params = (abortSignal?: AbortSignal) => ({ prompt: [], abortSignal }) as never;

function build(doStream: (...a: never[]) => unknown, warn = vi.fn()) {
  const base = new MockLanguageModelV4({ doStream: doStream as never });
  const model = withStepWatchdog(base, { firstChunkMs: 1000, idleMs: 2000, warn }) as unknown as MockLanguageModelV4;
  return { model, base, warn };
}

describe("withStepWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passes parts through unchanged and leaves no timers", async () => {
    const { model } = build(async () => ({ stream: textStream("a") }));
    const res = await model.doStream(params());
    expect(await drain(res.stream)).toEqual(text("a"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries once when the first attempt is silent and forwards only the second attempt", async () => {
    const signals: AbortSignal[] = [];
    const silent = controlled();
    let calls = 0;
    const { model, warn } = build(async (p: { abortSignal: AbortSignal }) => {
      signals.push(p.abortSignal);
      calls++;
      if (calls === 1) return { stream: silent.stream };
      return { stream: textStream("b") };
    });
    const pending = model.doStream(params());
    await vi.advanceTimersByTimeAsync(1000);
    const res = await pending;
    expect(calls).toBe(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(await drain(res.stream)).toEqual(text("b"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ attempt: 1, ms: 1000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("errors when both attempts are silent", async () => {
    const { model, warn } = build(async () => ({ stream: controlled().stream }));
    const pending = model.doStream(params());
    const assertion = expect(pending).rejects.toThrow("browse step timed out: no response from the model in 1000 ms (2 attempts)");
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(warn).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("errors the stream on an idle gap after the first part, without retry", async () => {
    const c = controlled();
    const { model, base, warn } = build(async () => ({ stream: c.stream }));
    c.push({ type: "text-start", id: "x" });
    const res = await model.doStream(params());
    const reader = res.stream.getReader();
    expect((await reader.read()).value).toEqual({ type: "text-start", id: "x" });
    const next = reader.read();
    const assertion = expect(next).rejects.toThrow("browse step timed out: the model stream stalled for 2000 ms");
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(base.doStreamCalls).toHaveLength(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ ms: 2000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes a caller abort through without retry or extra error text", async () => {
    const ac = new AbortController();
    const reason = new Error("caller aborted");
    const { model, base, warn } = build(async (p: { abortSignal: AbortSignal }) => ({
      stream: new ReadableStream<Part>({
        start(c) {
          p.abortSignal.addEventListener("abort", () => c.error(reason));
        },
      }),
    }));
    const pending = model.doStream(params(ac.signal));
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    await expect(pending).rejects.toBe(reason);
    expect(base.doStreamCalls).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the idle timer when the consumer cancels", async () => {
    const c = controlled();
    const { model } = build(async () => ({ stream: c.stream }));
    c.push({ type: "text-start", id: "x" });
    const res = await model.doStream(params());
    const reader = res.stream.getReader();
    await reader.read();
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(500);
    await reader.cancel();
    await next.catch(() => {});
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the first-part timer running past stream-start and retries", async () => {
    let calls = 0;
    const { model, warn } = build(async () => {
      calls++;
      if (calls === 1) {
        const c = controlled();
        c.push({ type: "stream-start", warnings: [] });
        return { stream: c.stream };
      }
      return { stream: textStream("b") };
    });
    const pending = model.doStream(params());
    await vi.advanceTimersByTimeAsync(1000);
    const res = await pending;
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await drain(res.stream)).toEqual(text("b"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards buffered leading parts in order before the first real part", async () => {
    const lead: Part[] = [
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "r1" },
    ];
    const { model } = build(async () => ({
      stream: new ReadableStream<Part>({ start(c) { [...lead, ...text("a")].forEach((p) => c.enqueue(p)); c.close(); } }),
    }));
    const res = await model.doStream(params());
    expect(await drain(res.stream)).toEqual([...lead, ...text("a")]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a stale attempt that resolves late and cancels its reader", async () => {
    let resolveFirst!: (v: unknown) => void;
    const cancelled = vi.fn();
    let calls = 0;
    const { model } = build(((): Promise<unknown> => {
      calls++;
      if (calls === 1) return new Promise((r) => void (resolveFirst = r));
      return Promise.resolve({ stream: textStream("b") });
    }) as never);
    const pending = model.doStream(params());
    await vi.advanceTimersByTimeAsync(1000);
    const res = await pending;
    resolveFirst({ stream: new ReadableStream<Part>({ cancel: cancelled }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(await drain(res.stream)).toEqual(text("b"));
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rethrows the caller abort reason at the retry boundary without a warning or retry", async () => {
    const ac = new AbortController();
    const reason = new Error("caller aborted");
    const { model, base, warn } = build(async () => ({ stream: controlled().stream }));
    const pending = model.doStream(params(ac.signal));
    const assertion = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(999);
    // Abort without the inner stream noticing: only the timeout path observes it.
    ac.abort(reason);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(base.doStreamCalls).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("produces error texts that the turn-level retry classifier treats as retryable", () => {
    expect(isRetryableAgentError(new Error("browse step timed out: no response from the model in 30000 ms (2 attempts)"))).toBe(true);
    expect(isRetryableAgentError(new Error("browse step timed out: the model stream stalled for 40000 ms"))).toBe(true);
  });

  it("is a no-op wrapper when both limits are 0", () => {
    const base = new MockLanguageModelV4({});
    expect(withStepWatchdog(base, { firstChunkMs: 0, idleMs: 0 })).toBe(base);
  });
});
