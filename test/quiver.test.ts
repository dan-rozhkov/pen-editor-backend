import { afterEach, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { QuiverError, isQuiverConfigured, streamVectorGeneration } from "../src/services/quiver.js";
import { UnsafeSvgError } from "../src/services/fal.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Builds a fetch Response whose body streams the given raw SSE text in
// arbitrary chunks — used to test that the parser handles a record split
// across chunk boundaries, not just one chunk per record.
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

async function collect(config: ReturnType<typeof makeConfig>, prompt = "a coffee cup icon") {
  const events = [];
  for await (const event of streamVectorGeneration(config, { prompt })) {
    events.push(event);
  }
  return events;
}

describe("isQuiverConfigured", () => {
  it("is false with no API key, true with one", () => {
    expect(isQuiverConfigured(makeConfig())).toBe(false);
    expect(isQuiverConfigured(makeConfig({ QUIVER_API_KEY: "qv-test" }))).toBe(true);
  });
});

describe("streamVectorGeneration SSE parsing", () => {
  const config = makeConfig({ QUIVER_API_KEY: "qv-test" });

  it("parses a full draft+content stream, including multi-line data", () => {
    return (async () => {
      const record1 = `event: draft\ndata: {"id":"svg-1","index":0,"svg":"<svg","type":"draft","update_type":"delta"}\n\n`;
      const record2 = `event: draft\ndata: {"id":"svg-1","index":0,"svg":">","type":"draft","update_type":"delta"}\n\n`;
      const record3 = `event: content\ndata: {"id":"svg-1","index":0,"svg":"<svg></svg>","type":"content","usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30}}\n\n`;
      vi.stubGlobal("fetch", vi.fn(async () => sseResponse([record1, record2, record3])));

      const events = await collect(config);
      expect(events).toEqual([
        { type: "delta", svg: "<svg" },
        { type: "delta", svg: ">" },
        { type: "done", svg: "<svg></svg>", usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } },
      ]);
    })();
  });

  it("reassembles a record split across chunk boundaries", async () => {
    const full = `event: content\ndata: {"id":"svg-1","index":0,"svg":"<svg/>","type":"content"}\n\n`;
    // Split mid-line, mid-field, on arbitrary byte boundaries.
    const splitAt = 30;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([full.slice(0, splitAt), full.slice(splitAt)])),
    );

    const events = await collect(config);
    expect(events).toEqual([{ type: "done", svg: "<svg/>" }]);
  });

  it("ignores unknown event types (e.g. a reasoning phase) rather than throwing", async () => {
    const reasoning = `event: reasoning\ndata: {"text":"thinking..."}\n\n`;
    const content = `event: content\ndata: {"id":"svg-1","index":0,"svg":"<svg/>","type":"content"}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([reasoning, content])));

    const events = await collect(config);
    expect(events).toEqual([{ type: "done", svg: "<svg/>" }]);
  });

  it("falls back to the concatenated deltas when no content event arrives", async () => {
    const d1 = `event: draft\ndata: {"svg":"<svg>","type":"draft","update_type":"delta"}\n\n`;
    const d2 = `event: draft\ndata: {"svg":"</svg>","type":"draft","update_type":"delta"}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([d1, d2])));

    const events = await collect(config);
    expect(events).toEqual([
      { type: "delta", svg: "<svg>" },
      { type: "delta", svg: "</svg>" },
      { type: "done", svg: "<svg></svg>" },
    ]);
  });

  // Finding #1: SSE has no requirement to end on a blank line. Regression
  // for the leftover-buffer-discarded bug — before the fix, this record
  // never left `buffer` and the caller got the fallback "done" built from
  // concatenated deltas instead of the real content.
  it("still yields the final `done` when the last content record has no trailing blank line", async () => {
    const draft = `event: draft\ndata: {"svg":"<svg>","type":"draft","update_type":"delta"}\n\n`;
    // No trailing "\n\n" after this record — the stream just ends here.
    const content = `event: content\ndata: {"svg":"<svg>full</svg>","type":"content"}`;
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([draft, content])));

    const events = await collect(config);
    expect(events).toEqual([
      { type: "delta", svg: "<svg>" },
      { type: "done", svg: "<svg>full</svg>" },
    ]);
  });

  it("rejects an unsafe content-event SVG with UnsafeSvgError instead of yielding it", async () => {
    const content = `event: content\ndata: {"svg":"<svg onload=\\"alert(1)\\"></svg>","type":"content"}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([content])));

    await expect(collect(config)).rejects.toThrow(UnsafeSvgError);
  });

  it("rejects an unsafe concatenated-delta fallback document with UnsafeSvgError", async () => {
    const d1 = `event: draft\ndata: {"svg":"<svg onload=\\"alert(1)\\">","type":"draft","update_type":"delta"}\n\n`;
    const d2 = `event: draft\ndata: {"svg":"</svg>","type":"draft","update_type":"delta"}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([d1, d2])));

    await expect(collect(config)).rejects.toThrow(UnsafeSvgError);
  });

  // Finding #5: a `draft` record whose `update_type` is present and not
  // "delta" must replace the accumulator, not append to it — otherwise a
  // future full-snapshot update would corrupt the no-content-event fallback.
  it("treats a non-delta update_type as a replacement, not an append, in the fallback accumulator", async () => {
    const delta = `event: draft\ndata: {"svg":"<svg>partial","type":"draft","update_type":"delta"}\n\n`;
    const snapshot = `event: draft\ndata: {"svg":"<svg>full snapshot</svg>","type":"draft","update_type":"snapshot"}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([delta, snapshot])));

    const events = await collect(config);
    expect(events).toEqual([
      { type: "delta", svg: "<svg>partial" },
      { type: "delta", svg: "<svg>full snapshot</svg>" },
      { type: "done", svg: "<svg>full snapshot</svg>" },
    ]);
  });

  // Finding #5: after a `content` record yields `done`, the generator must
  // stop — a `delta` that somehow follows it (the ignored `index`/`n`
  // params hint multiple outputs are possible) must not be processed.
  it("stops after the first `done` and ignores any record that follows it", async () => {
    const content = `event: content\ndata: {"svg":"<svg/>","type":"content"}\n\n`;
    const strayDelta = `event: draft\ndata: {"svg":"stray","type":"draft","update_type":"delta"}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([content, strayDelta])));

    const events = await collect(config);
    expect(events).toEqual([{ type: "done", svg: "<svg/>" }]);
  });

  it("throws QuiverError when the stream ends with no deltas and no content event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([""])));
    await expect(collect(config)).rejects.toThrow(QuiverError);
  });

  it("parses an HTTP error body into a QuiverError carrying code/status/requestId", async () => {
    const body = JSON.stringify({
      code: "invalid_api_key",
      message: "Invalid API key",
      request_id: "req-123",
      status: 401,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 401, headers: { "content-type": "application/json" } })),
    );

    await expect(collect(config)).rejects.toMatchObject({
      name: "QuiverError",
      status: 401,
      code: "invalid_api_key",
      requestId: "req-123",
      message: "Invalid API key",
    });
  });

  it("sends the model/prompt/instructions/stream fields and no sampling params", async () => {
    const content = `event: content\ndata: {"svg":"<svg/>","type":"content"}\n\n`;
    const fetchMock = vi.fn(async () => sseResponse([content]));
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const event of streamVectorGeneration(config, {
      prompt: "a leaf",
      instructions: "flat style",
    })) {
      events.push(event);
    }

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${config.QUIVER_BASE_URL}/svgs/generations`);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${config.QUIVER_API_KEY}`,
    });
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toEqual({
      model: config.QUIVER_MODEL,
      prompt: "a leaf",
      instructions: "flat style",
      stream: true,
    });
    expect(sent.temperature).toBeUndefined();
    expect(sent.top_p).toBeUndefined();
  });
});
