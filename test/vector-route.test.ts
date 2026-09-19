import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeConfig } from "./helpers.js";
import { buildApp } from "../src/app.js";
import type { AnalyticsClient, AnalyticsEvent } from "../src/analytics/posthog.js";

// Same recording stub as test/analytics.test.ts's recordingAnalyticsClient.
function recordingAnalyticsClient(): AnalyticsClient & { events: AnalyticsEvent[] } {
  const events: AnalyticsEvent[] = [];
  return {
    events,
    capture(event) {
      events.push(event);
    },
    async shutdown() {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

// Only fake the outbound call to Quiver's API — the test's OWN `fetch()`
// calls against the local server must go through the real implementation,
// or stubbing globalThis.fetch would intercept those too.
const realFetch = globalThis.fetch;
function mockQuiverFetch(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/svgs/generations")) return response;
      return realFetch(input, init);
    }),
  );
}

// Reads the whole SSE response body as text — small fixed responses in these
// tests, so no need for incremental reading.
async function readAll(res: Response): Promise<string> {
  return res.text();
}

describe("POST /api/vector/generate — disabled (no QUIVER_API_KEY)", () => {
  let app: FastifyInstance;
  let url: string;

  beforeAll(async () => {
    app = await buildApp(makeConfig(), { logger: false });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 503 when QUIVER_API_KEY is unset", async () => {
    const res = await fetch(`${url}/api/vector/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a coffee cup" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/QUIVER_API_KEY/);
  });
});

describe("POST /api/vector/generate — configured", () => {
  let app: FastifyInstance;
  let url: string;

  beforeAll(async () => {
    app = await buildApp(makeConfig({ QUIVER_API_KEY: "qv-test" }), { logger: false });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects a missing prompt with 400", async () => {
    const res = await fetch(`${url}/api/vector/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("sets CORS headers on the hijacked stream", async () => {
    // reply.hijack() bypasses @fastify/cors, so these headers only exist if
    // the route writes them itself. In production the editor and the API are
    // on different origins, and without this the browser drops the stream.
    mockQuiverFetch(
      sseResponse([
        'event: content\ndata: {"id":"svg-1","index":0,"svg":"<svg/>","type":"content"}\n\n',
      ]),
    );

    const res = await fetch(`${url}/api/vector/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://pen.example" },
      body: JSON.stringify({ prompt: "a coffee cup" }),
    });

    expect(res.status).toBe(200);
    // makeConfig leaves CORS_ALLOWED_ORIGINS unset, which means dev mode:
    // any origin is reflected.
    expect(res.headers.get("access-control-allow-origin")).toBe("https://pen.example");
    expect(res.headers.get("vary")).toMatch(/Origin/i);
    await res.text();
  });

  it("reports a mid-stream upstream failure as an error frame, not a status code", async () => {
    // Once the first byte is out the status line is already committed, so a
    // failure that happens after streaming began can only be reported inside
    // the stream. Without this the browser would see a truncated 200 and treat
    // a failed generation as an empty one.
    const encoder = new TextEncoder();
    // Pull-based on purpose: `controller.error()` clears any queued chunks, so
    // enqueueing a delta and erroring in the same turn would mean the route
    // never sees the delta at all and correctly fails before hijacking. The
    // failure must land on a LATER pull, after the first frame was consumed.
    let pulls = 0;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(
            encoder.encode(
              'event: draft\ndata: {"id":"svg-1","index":0,"svg":"<svg viewBox=\\"0 0 8 8\\">","type":"draft","update_type":"delta"}\n\n',
            ),
          );
          return;
        }
        controller.error(new Error("upstream socket died"));
      },
    });
    mockQuiverFetch(
      new Response(failing, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const res = await fetch(`${url}/api/vector/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a coffee cup" }),
    });

    expect(res.status).toBe(200);
    const body = await readAll(res);
    const frames = body
      .split("\n\n")
      .filter((record) => record.trim().length > 0)
      .map((record) =>
        JSON.parse(
          record
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join(""),
        ),
      );

    expect(frames.some((f) => f.type === "delta")).toBe(true);
    const error = frames.find((f) => f.type === "error");
    expect(error, `no error frame in: ${body}`).toBeDefined();
    expect(frames.some((f) => f.type === "done")).toBe(false);
  });

  it("streams delta/done SSE frames from a mocked Quiver call", async () => {
    const d1 = `event: draft\ndata: {"svg":"<svg","type":"draft","update_type":"delta"}\n\n`;
    const d2 = `event: content\ndata: {"svg":"<svg></svg>","type":"content"}\n\n`;
    mockQuiverFetch(sseResponse([d1, d2]));

    const res = await fetch(`${url}/api/vector/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a coffee cup icon" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await readAll(res);
    const frames = text
      .trim()
      .split("\n\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line.replace(/^data: /, "")));

    expect(frames).toEqual([
      { type: "delta", svg: "<svg" },
      { type: "done", svg: "<svg></svg>" },
    ]);
  });

  // Finding #3: the route must not reflect Quiver's real upstream status,
  // message or code to the (unauthenticated) caller — a 404 from Quiver
  // becomes a generic 500 here, same collapsing as fal.ts/generateImage.ts.
  // Regression: this test used to assert a 404 passthrough with the
  // upstream `code` in the body.
  it("collapses an upstream failure before any bytes are streamed to a generic 500, without the upstream code", async () => {
    mockQuiverFetch(
      new Response(JSON.stringify({ code: "model_not_found", message: "model not found", status: 404 }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await fetch(`${url}/api/vector/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a coffee cup icon" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBeUndefined();
    expect(body.error).not.toMatch(/model_not_found/);
    expect(body.error).not.toMatch(/model not found/);
  });

  it("rejects an unsafe SVG from Quiver's content event with 422, instead of streaming it", async () => {
    // Same defense-in-depth check as /api/vectorize (finding #2) — Quiver's
    // output is untrusted the same way fal.ai's is.
    mockQuiverFetch(
      sseResponse([
        'event: content\ndata: {"svg":"<svg onload=\\"alert(1)\\"></svg>","type":"content"}\n\n',
      ]),
    );

    const res = await fetch(`${url}/api/vector/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a coffee cup icon" }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/onload/i);
  });

  // Finding #4: a client disconnect before the first byte is streamed must
  // not touch reply.raw (reply.hijack() was never called, so Fastify still
  // owns the reply) — that used to raise FST_ERR_PROMISE_NOT_FULFILLED.
  it("does not throw when the client disconnects before any bytes are streamed", async () => {
    // A ReadableStream that never resolves its first pull — the fetch to
    // Quiver "hangs" until the client below aborts.
    const hanging = new ReadableStream<Uint8Array>({
      pull() {
        // Never enqueue or close — simulates an in-flight upstream call.
      },
    });
    mockQuiverFetch(new Response(hanging, { status: 200, headers: { "content-type": "text/event-stream" } }));

    const controller = new AbortController();
    const pending = fetch(`${url}/api/vector/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a coffee cup icon" }),
      signal: controller.signal,
    });

    // Abort our own client request before Quiver ever produces a byte —
    // this is what fires the route's reply.raw "close" handler with
    // streamStarted still false.
    controller.abort();
    await expect(pending).rejects.toThrow();

    // The route handler must not have thrown FST_ERR_PROMISE_NOT_FULFILLED
    // internally — prove the server is still healthy by making an ordinary
    // request succeed right after.
    const health = await fetch(`${url}/api/vector/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(health.status).toBe(400);
  });
});

// Finding #7: this was the one paid-external-provider route with no
// analytics at all — same three outcomes (ok / error / aborted) as
// generateImageRoutes/falRoutes, same event shape.
describe("POST /api/vector/generate — analytics", () => {
  let app: FastifyInstance;
  let url: string;
  let analytics: ReturnType<typeof recordingAnalyticsClient>;

  beforeAll(async () => {
    analytics = recordingAnalyticsClient();
    app = await buildApp(makeConfig({ QUIVER_API_KEY: "qv-test" }), { logger: false, analytics });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
  });

  it("captures ok:true with duration_ms on a successful generation", async () => {
    mockQuiverFetch(
      sseResponse(['event: content\ndata: {"svg":"<svg/>","type":"content"}\n\n']),
    );

    const res = await fetch(`${url}/api/vector/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a coffee cup icon" }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const event = analytics.events.find((e) => e.event === "vector_generated");
    expect(event, `no vector_generated event in: ${JSON.stringify(analytics.events)}`).toBeDefined();
    expect(event!.distinctId).toBe("api");
    expect(event!.properties).toMatchObject({
      ok: true,
      duration_ms: expect.any(Number),
      $process_person_profile: false,
    });
  });

  it("captures ok:false, error_kind: unsafe_svg when Quiver's SVG is rejected", async () => {
    mockQuiverFetch(
      sseResponse([
        'event: content\ndata: {"svg":"<svg onload=\\"alert(1)\\"></svg>","type":"content"}\n\n',
      ]),
    );

    const res = await fetch(`${url}/api/vector/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a coffee cup icon" }),
    });
    expect(res.status).toBe(422);

    const event = analytics.events.findLast((e) => e.event === "vector_generated");
    expect(event).toBeDefined();
    expect(event!.properties).toMatchObject({
      ok: false,
      error_kind: "unsafe_svg",
      duration_ms: expect.any(Number),
      $process_person_profile: false,
    });
  });

  it("captures ok:false without error_kind for a generic upstream failure", async () => {
    mockQuiverFetch(
      new Response(JSON.stringify({ message: "boom", status: 500 }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await fetch(`${url}/api/vector/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a coffee cup icon" }),
    });
    expect(res.status).toBe(500);

    const event = analytics.events.findLast((e) => e.event === "vector_generated");
    expect(event).toBeDefined();
    expect(event!.properties.ok).toBe(false);
    expect(event!.properties.error_kind).toBeUndefined();
  });
});
