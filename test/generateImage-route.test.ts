import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeConfig } from "./helpers.js";

vi.mock("../src/services/imageGen.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/imageGen.js")>();
  return { ...actual, generateImage: vi.fn() };
});
import { generateImage, ImageGenerationTimeoutError } from "../src/services/imageGen.js";
import { buildApp } from "../src/app.js";
import type { AnalyticsClient, AnalyticsEvent } from "../src/analytics/posthog.js";

let app: FastifyInstance;
let url: string;

beforeAll(async () => {
  app = await buildApp(makeConfig(), { logger: false });
  url = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
});

function post(body: unknown): Promise<Response> {
  return fetch(`${url}/api/generate-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/generate-image", () => {
  it("returns the generated image url", async () => {
    vi.mocked(generateImage).mockResolvedValue({ url: "data:image/png;base64,AAAA", mimeType: "image/png" });
    const res = await post({ prompt: "a sunset" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "data:image/png;base64,AAAA" });
    expect(generateImage).toHaveBeenCalledWith(expect.anything(), "a sunset", expect.any(AbortSignal));
  });

  it("does not abort generation after a normal request completes", async () => {
    vi.mocked(generateImage).mockImplementation(async (_config, _prompt, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal?.aborted) throw signal.reason;
      return { url: "data:image/png;base64,AAAA", mimeType: "image/png" };
    });

    const res = await post({ prompt: "a sunset" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "data:image/png;base64,AAAA" });
  });

  it("rejects a missing prompt with 400", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
  });

  it("returns 500 with an error when generation fails", async () => {
    vi.mocked(generateImage).mockRejectedValue(new Error("openrouter down"));
    const res = await post({ prompt: "x" });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("openrouter down") });
  });

  it("returns 504 when image generation times out", async () => {
    vi.mocked(generateImage).mockRejectedValue(new ImageGenerationTimeoutError(90_000));
    const res = await post({ prompt: "x" });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("timed out") });
  });
});

// ---------------------------------------------------------------------------
// Analytics: $process_person_profile scoping + user-cancel vs provider-failure
// (findings #3 and #4). A separate app instance so a recording analytics
// client can be injected without disturbing the shared `app` above.
// ---------------------------------------------------------------------------

describe("POST /api/generate-image analytics", () => {
  let analyticsApp: FastifyInstance;
  let analyticsUrl: string;
  let events: AnalyticsEvent[];

  function recordingAnalyticsClient(): AnalyticsClient {
    return {
      capture(event) {
        events.push(event);
      },
      async shutdown() {},
    };
  }

  beforeAll(async () => {
    events = [];
    analyticsApp = await buildApp(makeConfig(), {
      logger: false,
      analytics: recordingAnalyticsClient(),
    });
    analyticsUrl = await analyticsApp.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await analyticsApp.close();
  });

  afterEach(() => {
    events.length = 0;
  });

  it("marks a successful image_generated event as not person-scoped", async () => {
    vi.mocked(generateImage).mockResolvedValue({ url: "data:image/png;base64,AAAA", mimeType: "image/png" });
    await fetch(`${analyticsUrl}/api/generate-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a sunset" }),
    });
    // The route's own `onResponse` hook also fires a generic `api_request`
    // event for this route (it's not in ANALYTICS_EXCLUDED_ROUTES) — filter
    // to `image_generated` rather than asserting the total event count.
    const imageEvents = events.filter((e) => e.event === "image_generated");
    expect(imageEvents).toHaveLength(1);
    expect(imageEvents[0].properties).toMatchObject({ ok: true, $process_person_profile: false });
  });

  it("captures a user cancel as error_kind: aborted, not a provider failure", async () => {
    vi.mocked(generateImage).mockImplementation(
      (_config, _prompt, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("provider call aborted")));
        }),
    );

    const clientAbort = new AbortController();
    const fetchPromise = fetch(`${analyticsUrl}/api/generate-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a sunset" }),
      signal: clientAbort.signal,
    }).catch(() => undefined);

    // Give the request a moment to reach the route handler before the client
    // disconnects, so reply.raw's "close" listener is already registered.
    await new Promise((resolve) => setTimeout(resolve, 20));
    clientAbort.abort();
    await fetchPromise;

    await vi.waitFor(() =>
      expect(events.some((e) => e.event === "image_generated")).toBe(true),
    );
    const imageEvent = events.find((e) => e.event === "image_generated")!;
    expect(imageEvent.properties).toMatchObject({
      ok: false,
      error_kind: "aborted",
      $process_person_profile: false,
    });
  });
});
