import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(),
}));

import { createMCPClient } from "@ai-sdk/mcp";
import { closeAllMCPClients, getMCPTools, releaseMCPTools } from "../src/ai/mcp.js";
import { makeConfig } from "./helpers.js";

function fakeClient(tools: Record<string, unknown> = { search_screens: { execute: vi.fn() } }) {
  return {
    tools: vi.fn(async () => tools),
    close: vi.fn(async () => {}),
  };
}

// Eviction closes a client via a `.then()` chain on an already-resolved
// promise, not a timer — under vi.useFakeTimers() that settles on real
// microtask ticks regardless, so flushing a few of them (rather than
// vi.waitFor, which polls via a faked setTimeout and would hang) is enough
// to observe it.
async function flushMicrotasks(times = 10) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe("getMCPTools — Mobbin token-keyed client cache", () => {
  const config = makeConfig();

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await closeAllMCPClients();
    vi.mocked(createMCPClient).mockReset();
    vi.useRealTimers();
  });

  it("returns no tools at all when no token is supplied", async () => {
    const tools = await getMCPTools(config, {});
    expect(tools).toEqual({});
    expect(vi.mocked(createMCPClient)).not.toHaveBeenCalled();
  });

  it("returns no tools when opts is omitted entirely", async () => {
    const tools = await getMCPTools(config);
    expect(tools).toEqual({});
  });

  it("reuses the same client for the same token across calls", async () => {
    const client = fakeClient();
    vi.mocked(createMCPClient).mockResolvedValue(client as never);

    await getMCPTools(config, { mobbinAccessToken: "token-a" });
    await getMCPTools(config, { mobbinAccessToken: "token-a" });

    expect(vi.mocked(createMCPClient)).toHaveBeenCalledTimes(1);
  });

  it("creates a distinct client per distinct token", async () => {
    const clientA = fakeClient();
    const clientB = fakeClient();
    vi.mocked(createMCPClient)
      .mockResolvedValueOnce(clientA as never)
      .mockResolvedValueOnce(clientB as never);

    await getMCPTools(config, { mobbinAccessToken: "token-a" });
    await getMCPTools(config, { mobbinAccessToken: "token-b" });

    expect(vi.mocked(createMCPClient)).toHaveBeenCalledTimes(2);
  });

  it("never sends the raw token as the cache key — connecting twice with the same token does not create a second real MCP connection using a hashed identity leak", async () => {
    const client = fakeClient();
    vi.mocked(createMCPClient).mockResolvedValue(client as never);

    await getMCPTools(config, { mobbinAccessToken: "super-secret-token" });
    // Passing the token to createMCPClient as the Authorization header is
    // expected and required — that's the one place it's allowed to appear.
    const call = vi.mocked(createMCPClient).mock.calls[0]?.[0] as {
      transport: { headers: Record<string, string> };
    };
    expect(call.transport.headers.Authorization).toBe("Bearer super-secret-token");
  });

  it("evicts and closes a client once its TTL expires, reconnecting on the next call for the same token", async () => {
    const clientA = fakeClient();
    const clientB = fakeClient();
    vi.mocked(createMCPClient)
      .mockResolvedValueOnce(clientA as never)
      .mockResolvedValueOnce(clientB as never);

    const toolsA = await getMCPTools(config, { mobbinAccessToken: "token-a" });
    expect(clientA.close).not.toHaveBeenCalled();
    // Released before the TTL check below — Finding 3's fix defers closing
    // a still-leased client, so this test's OWN lease must be released for
    // the TTL eviction to actually close it (see the dedicated
    // "does not close a leased client" test below for the deferred case).
    releaseMCPTools(toolsA);

    // Advance well past the 30-minute TTL.
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    await getMCPTools(config, { mobbinAccessToken: "token-a" });
    await flushMicrotasks();
    expect(clientA.close).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createMCPClient)).toHaveBeenCalledTimes(2);
  });

  it("evicts and closes the least-recently-used client once the cache exceeds its max size", async () => {
    const firstClient = fakeClient();
    vi.mocked(createMCPClient).mockResolvedValueOnce(firstClient as never);
    const firstTools = await getMCPTools(config, { mobbinAccessToken: "token-0" });
    releaseMCPTools(firstTools);

    // Fill the cache past its max size (200) with distinct tokens — the
    // very first token ("token-0") must be the one evicted, since it was
    // never touched again.
    for (let i = 1; i <= 200; i++) {
      vi.mocked(createMCPClient).mockResolvedValueOnce(fakeClient() as never);
      const tools = await getMCPTools(config, { mobbinAccessToken: `token-${i}` });
      releaseMCPTools(tools);
    }

    await flushMicrotasks();
    expect(firstClient.close).toHaveBeenCalledTimes(1);
  });

  // Finding 3 (the actual production bug this test class guards against): a
  // long-running request can still be mid-call on a client when its TTL/LRU
  // turn comes up. Before the fix, pruneExpired/enforceMaxSize closed the
  // underlying transport unconditionally — breaking that concurrent
  // request's stream out from under it. After the fix, eviction removes the
  // entry from the CACHE (so nobody else reuses it) but defers the actual
  // `client.close()` until every lease on it has been released.
  it("does NOT close a client that is still leased when it is evicted by TTL — only once released", async () => {
    const clientA = fakeClient();
    const clientB = fakeClient();
    vi.mocked(createMCPClient)
      .mockResolvedValueOnce(clientA as never)
      .mockResolvedValueOnce(clientB as never);

    const toolsA = await getMCPTools(config, { mobbinAccessToken: "token-a" });
    // Deliberately NOT released — simulates a request still mid-tool-loop.

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    // A second, concurrent request for the same token: since the entry is
    // now expired, this reconnects rather than reusing clientA.
    await getMCPTools(config, { mobbinAccessToken: "token-a" });
    await flushMicrotasks();

    // clientA was evicted from the cache (a reconnect happened at all) but
    // must not be closed while the first request's lease is still open.
    expect(vi.mocked(createMCPClient)).toHaveBeenCalledTimes(2);
    expect(clientA.close).not.toHaveBeenCalled();

    // Only once the original leaseholder releases does the deferred close
    // actually happen.
    releaseMCPTools(toolsA);
    await flushMicrotasks();
    expect(clientA.close).toHaveBeenCalledTimes(1);
  });

  // A second lease on the SAME still-cached entry (two concurrent requests
  // reusing one live client) must not let the first release close it out
  // from under the second.
  it("keeps a shared client open until EVERY lease on it has been released, even without any eviction", async () => {
    const client = fakeClient();
    vi.mocked(createMCPClient).mockResolvedValueOnce(client as never);

    const toolsFirst = await getMCPTools(config, { mobbinAccessToken: "token-shared" });
    const toolsSecond = await getMCPTools(config, { mobbinAccessToken: "token-shared" });
    expect(vi.mocked(createMCPClient)).toHaveBeenCalledTimes(1);

    releaseMCPTools(toolsFirst);
    await flushMicrotasks();
    // Not evicted (still within TTL/size), so nothing should have closed
    // it anyway — but this also confirms a release with an outstanding
    // second lease never triggers a close.
    expect(client.close).not.toHaveBeenCalled();

    releaseMCPTools(toolsSecond);
    await flushMicrotasks();
    // Still not evicted, so still not closed — releasing a lease alone
    // never closes a client that's still live in the cache; only eviction
    // (TTL/LRU) plus a fully-drained refCount does.
    expect(client.close).not.toHaveBeenCalled();
  });

  it("closeAllMCPClients closes every cached client", async () => {
    const clientA = fakeClient();
    const clientB = fakeClient();
    vi.mocked(createMCPClient)
      .mockResolvedValueOnce(clientA as never)
      .mockResolvedValueOnce(clientB as never);

    await getMCPTools(config, { mobbinAccessToken: "token-a" });
    await getMCPTools(config, { mobbinAccessToken: "token-b" });

    await closeAllMCPClients();

    expect(clientA.close).toHaveBeenCalledTimes(1);
    expect(clientB.close).toHaveBeenCalledTimes(1);
  });

  // Backstop for a leaseholder that never calls releaseMCPTools at all
  // (e.g. a request that crashes before its "close" handler fires): a
  // retired-but-still-leased entry must still get closed EVENTUALLY, not
  // pinned open forever.
  it("force-closes a retired client after the grace period even if it is never released", async () => {
    const clientA = fakeClient();
    vi.mocked(createMCPClient).mockResolvedValueOnce(clientA as never);
    await getMCPTools(config, { mobbinAccessToken: "token-a" });
    // Deliberately never released.

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000); // past TTL
    vi.mocked(createMCPClient).mockResolvedValueOnce(fakeClient() as never);
    await getMCPTools(config, { mobbinAccessToken: "token-a" }); // triggers eviction
    await flushMicrotasks();
    expect(clientA.close).not.toHaveBeenCalled();

    // Past the retirement grace period (10 minutes) — force-closed anyway.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    await flushMicrotasks();
    expect(clientA.close).toHaveBeenCalledTimes(1);
  });

  // Finding 6: a connect-failure's own `.catch` fires asynchronously and can
  // land well after the failing entry was already superseded by a newer,
  // successful entry for the SAME key (evicted via LRU while still
  // pending). Evicting/closing by key alone there would tear down the live
  // replacement instead of the dead original.
  it("does not let a late connect-failure tear down a newer, already-connected entry for the same key", async () => {
    let rejectFirst!: (err: unknown) => void;
    vi.mocked(createMCPClient).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }) as never,
    );
    const firstAttempt = getMCPTools(config, { mobbinAccessToken: "token-race" });

    // Evict the still-pending first entry via LRU by filling the cache past
    // its max size (200) with distinct tokens.
    for (let i = 0; i < 200; i++) {
      vi.mocked(createMCPClient).mockResolvedValueOnce(fakeClient() as never);
      const filler = await getMCPTools(config, { mobbinAccessToken: `filler-${i}` });
      releaseMCPTools(filler);
    }

    // A fresh connect for the SAME token now happens, since the pending
    // first entry was evicted from cache without ever having settled.
    const secondClient = fakeClient();
    vi.mocked(createMCPClient).mockResolvedValueOnce(secondClient as never);
    const secondTools = await getMCPTools(config, { mobbinAccessToken: "token-race" });
    expect(Object.keys(secondTools)).toContain("search_screens");

    // The original, long-pending connect finally rejects.
    rejectFirst(new Error("first attempt failed late"));
    expect(await firstAttempt).toEqual({});
    await flushMicrotasks();

    // The dead first attempt's cleanup must not have evicted/closed the
    // live second entry: reusing the token again must reuse it, not
    // reconnect a third time.
    expect(secondClient.close).not.toHaveBeenCalled();
    vi.mocked(createMCPClient).mockClear();
    const thirdTools = await getMCPTools(config, { mobbinAccessToken: "token-race" });
    expect(vi.mocked(createMCPClient)).not.toHaveBeenCalled();
    expect(thirdTools).toBe(secondTools);
    releaseMCPTools(secondTools);
    releaseMCPTools(thirdTools);
  });

  it("evicts a failed connection so the next call for the same token retries", async () => {
    vi.mocked(createMCPClient).mockRejectedValueOnce(new Error("upstream down"));
    const client = fakeClient();
    vi.mocked(createMCPClient).mockResolvedValueOnce(client as never);

    const first = await getMCPTools(config, { mobbinAccessToken: "token-a" });
    expect(first).toEqual({});
    // The eviction-on-failure `.catch` runs as its own microtask, separate
    // from the await above — give it a chance to run before the next call.
    await flushMicrotasks();

    const second = await getMCPTools(config, { mobbinAccessToken: "token-a" });
    expect(vi.mocked(createMCPClient)).toHaveBeenCalledTimes(2);
    expect(Object.keys(second)).toContain("search_screens");
  });
});

describe("getMCPTools — limit clamp", () => {
  afterEach(async () => {
    await closeAllMCPClients();
    vi.mocked(createMCPClient).mockReset();
  });

  it("clamps search_screens/search_sections limit down to 8, and search_flows down to 4", async () => {
    const searchScreens = vi.fn(async () => ({ ok: true }));
    const searchFlows = vi.fn(async () => ({ ok: true }));
    const searchSections = vi.fn(async () => ({ ok: true }));
    const client = {
      tools: vi.fn(async () => ({
        search_screens: { execute: searchScreens },
        search_flows: { execute: searchFlows },
        search_sections: { execute: searchSections },
      })),
      close: vi.fn(async () => {}),
    };
    vi.mocked(createMCPClient).mockResolvedValue(client as never);

    const tools = await getMCPTools(makeConfig(), { mobbinAccessToken: "token-clamp" });
    const exec = (name: string) =>
      (tools[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute;

    await exec("search_screens")({ query: "q", platform: "ios", limit: 30 }, {});
    expect(searchScreens).toHaveBeenCalledWith(
      { query: "q", platform: "ios", limit: 8 },
      {},
    );

    await exec("search_sections")({ query: "q", limit: 30 }, {});
    expect(searchSections).toHaveBeenCalledWith({ query: "q", limit: 8 }, {});

    await exec("search_flows")({ query: "q", platform: "web", limit: 10 }, {});
    expect(searchFlows).toHaveBeenCalledWith(
      { query: "q", platform: "web", limit: 4 },
      {},
    );

    // A request BELOW the cap is left alone (never raised).
    await exec("search_flows")({ query: "q", platform: "web", limit: 2 }, {});
    expect(searchFlows).toHaveBeenCalledWith(
      { query: "q", platform: "web", limit: 2 },
      {},
    );

    // Omitted limit is filled in at the cap, not left to Mobbin's own
    // (higher) default.
    await exec("search_screens")({ query: "q", platform: "ios" }, {});
    expect(searchScreens).toHaveBeenCalledWith({ query: "q", platform: "ios", limit: 8 }, {});
  });
});

// Finding 1 (the headline defect): Mobbin's inline preview images used to
// reach the model unconditionally, regardless of whether the model
// selected for the turn can read images at all — a vision-less model
// (`z-ai/glm-5.3` etc. in DEFAULT_MODELS) got a real `image_url` part on
// its very first research call, which either 400s the whole turn on
// OpenRouter or is silently dropped after we already paid to send up to
// 300KB of base64. This describes the fix: getMCPTools now takes
// `modelSupportsVision` and gates Mobbin's inline images on it, applied
// FRESH on every call rather than baked into the token-keyed client cache
// (which is what makes the third test below — same user, different model —
// meaningful: it fails if the gate were ever moved back into
// connectAndFetchTools/CachedEntry).
describe("getMCPTools — per-turn vision gate on Mobbin's inline preview images", () => {
  afterEach(async () => {
    await closeAllMCPClients();
    vi.mocked(createMCPClient).mockReset();
  });

  function mobbinSearchClient() {
    const searchScreens = vi.fn(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mobbin_url: "https://mobbin.com/screens/abc",
            image_url: "https://cdn.mobbin.com/full/abc.png",
          }),
        },
        { type: "image", data: "c".repeat(100), mimeType: "image/jpeg" },
      ],
    }));
    return {
      client: {
        tools: vi.fn(async () => ({ search_screens: { execute: searchScreens } })),
        close: vi.fn(async () => {}),
      },
      searchScreens,
    };
  }

  it("passes Mobbin's inline preview image through untouched for a vision-capable model", async () => {
    const { client } = mobbinSearchClient();
    vi.mocked(createMCPClient).mockResolvedValueOnce(client as never);

    const tools = await getMCPTools(makeConfig(), {
      mobbinAccessToken: "token-vision",
      modelSupportsVision: true,
    });
    const result = (await (
      tools.search_screens as { execute: (i: unknown, o: unknown) => Promise<{ content: unknown[] }> }
    ).execute({ query: "q" }, {})) as { content: Array<Record<string, unknown>> };

    const imagePart = result.content.find((p) => p.type === "image");
    expect(imagePart).toBeTruthy();
    expect(imagePart?.data).toBe("c".repeat(100));
    releaseMCPTools(tools);
  });

  it("replaces Mobbin's inline preview image with a text placeholder for a vision-less model, keeping mobbin_url/image_url intact", async () => {
    const { client } = mobbinSearchClient();
    vi.mocked(createMCPClient).mockResolvedValueOnce(client as never);

    const tools = await getMCPTools(makeConfig(), {
      mobbinAccessToken: "token-no-vision",
      modelSupportsVision: false,
    });
    const result = (await (
      tools.search_screens as { execute: (i: unknown, o: unknown) => Promise<{ content: unknown[] }> }
    ).execute({ query: "q" }, {})) as { content: Array<Record<string, unknown>> };

    // No image-shaped content part survives at all.
    expect(result.content.some((p) => p.type === "image")).toBe(false);
    // The dropped part became text, naming what was withheld.
    const droppedText = result.content.find(
      (p) => p.type === "text" && typeof p.text === "string" && (p.text as string).includes("Image content dropped"),
    );
    expect(droppedText).toBeTruthy();
    // Metadata — mobbin_url/image_url — survives in its own sibling text
    // part, untouched: the gate only ever touches the image content part.
    const metadataText = result.content.find(
      (p) => p.type === "text" && typeof p.text === "string" && (p.text as string).includes("mobbin_url"),
    );
    expect(metadataText?.text).toContain("https://mobbin.com/screens/abc");
    expect(metadataText?.text).toContain("https://cdn.mobbin.com/full/abc.png");
    releaseMCPTools(tools);
  });

  it("points at analyze_image when vision is configured, and admits it has no way to inspect pixels when it isn't", async () => {
    const withAnalyze = mobbinSearchClient();
    vi.mocked(createMCPClient).mockResolvedValueOnce(withAnalyze.client as never);
    const toolsWithAnalyze = await getMCPTools(makeConfig({ VISION_MODEL: "openrouter:some/vision-model" }), {
      mobbinAccessToken: "token-hint-a",
      modelSupportsVision: false,
    });
    const resultWithAnalyze = (await (
      toolsWithAnalyze.search_screens as {
        execute: (i: unknown, o: unknown) => Promise<{ content: unknown[] }>;
      }
    ).execute({ query: "q" }, {})) as { content: Array<Record<string, unknown>> };
    const droppedWithHint = resultWithAnalyze.content.find(
      (p) => p.type === "text" && typeof p.text === "string" && (p.text as string).includes("Image content dropped"),
    );
    expect(droppedWithHint?.text).toContain("analyze_image");
    releaseMCPTools(toolsWithAnalyze);

    const withoutAnalyze = mobbinSearchClient();
    vi.mocked(createMCPClient).mockResolvedValueOnce(withoutAnalyze.client as never);
    const toolsWithoutAnalyze = await getMCPTools(makeConfig({ VISION_MODEL: "" }), {
      mobbinAccessToken: "token-hint-b",
      modelSupportsVision: false,
    });
    const resultWithoutAnalyze = (await (
      toolsWithoutAnalyze.search_screens as {
        execute: (i: unknown, o: unknown) => Promise<{ content: unknown[] }>;
      }
    ).execute({ query: "q" }, {})) as { content: Array<Record<string, unknown>> };
    const droppedWithoutHint = resultWithoutAnalyze.content.find(
      (p) => p.type === "text" && typeof p.text === "string" && (p.text as string).includes("Image content dropped"),
    );
    expect(droppedWithoutHint?.text).not.toContain("analyze_image");
    releaseMCPTools(toolsWithoutAnalyze);
  });

  // The cache-staleness regression this whole finding turned on: the
  // client cache is keyed by TOKEN HASH ALONE (see mcp.ts), and its TTL
  // (30 min) far outlives a single request — so if the vision gate were
  // ever baked into connectAndFetchTools/CachedEntry (as the base
  // sanitizer's `visionConfigured` deliberately still is, since that one
  // only depends on server config), the FIRST request's model would decide
  // what every later request from the SAME user sees, for as long as that
  // cached client survives. Reusing the identical underlying cached
  // client for the same token but flipping `modelSupportsVision` between
  // calls must still produce the two different behaviors above.
  it("the SAME user reusing the SAME cached client gets DIFFERENT image behavior when the model changes between requests", async () => {
    const { client } = mobbinSearchClient();
    vi.mocked(createMCPClient).mockResolvedValueOnce(client as never);

    const toolsVisionModel = await getMCPTools(makeConfig(), {
      mobbinAccessToken: "token-same-user",
      modelSupportsVision: true,
    });
    const resultVisionModel = (await (
      toolsVisionModel.search_screens as {
        execute: (i: unknown, o: unknown) => Promise<{ content: unknown[] }>;
      }
    ).execute({ query: "q" }, {})) as { content: Array<Record<string, unknown>> };
    expect(resultVisionModel.content.some((p) => p.type === "image")).toBe(true);
    releaseMCPTools(toolsVisionModel);

    const toolsNoVisionModel = await getMCPTools(makeConfig(), {
      mobbinAccessToken: "token-same-user",
      modelSupportsVision: false,
    });
    const resultNoVisionModel = (await (
      toolsNoVisionModel.search_screens as {
        execute: (i: unknown, o: unknown) => Promise<{ content: unknown[] }>;
      }
    ).execute({ query: "q" }, {})) as { content: Array<Record<string, unknown>> };
    expect(resultNoVisionModel.content.some((p) => p.type === "image")).toBe(false);
    releaseMCPTools(toolsNoVisionModel);

    // Exactly one real MCP connection was ever made for this token — the
    // second request reused the same cached client; only the per-call
    // image gate differed.
    expect(vi.mocked(createMCPClient)).toHaveBeenCalledTimes(1);
  });

  it("defaults modelSupportsVision to true for a caller that doesn't pass it (the showcase runner, older tests)", async () => {
    const { client } = mobbinSearchClient();
    vi.mocked(createMCPClient).mockResolvedValueOnce(client as never);

    const tools = await getMCPTools(makeConfig(), { mobbinAccessToken: "token-default" });
    const result = (await (
      tools.search_screens as { execute: (i: unknown, o: unknown) => Promise<{ content: unknown[] }> }
    ).execute({ query: "q" }, {})) as { content: Array<Record<string, unknown>> };
    expect(result.content.some((p) => p.type === "image")).toBe(true);
    releaseMCPTools(tools);
  });
});
