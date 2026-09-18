import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(),
}));

import { createMCPClient } from "@ai-sdk/mcp";
import { closeAllMCPClients, getMCPTools } from "../src/ai/mcp.js";
import { makeConfig } from "./helpers.js";

describe("getMCPTools timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await closeAllMCPClients();
    vi.useRealTimers();
    vi.mocked(createMCPClient).mockReset();
  });

  it("gives up on a hung MCP server after the timeout and returns no tools", async () => {
    // A connection that never settles:
    vi.mocked(createMCPClient).mockImplementation(
      () => new Promise(() => {}) as never,
    );
    const config = makeConfig();

    const pending = getMCPTools(config, { mobbinAccessToken: "test-token" });
    await vi.advanceTimersByTimeAsync(10_001);
    const tools = await pending;

    expect(tools).toEqual({});

    // The failed entry must be evicted so the next call retries — give the
    // eviction-on-failure microtask a chance to run first.
    await Promise.resolve();
    await Promise.resolve();

    const second = getMCPTools(config, { mobbinAccessToken: "test-token" });
    await vi.advanceTimersByTimeAsync(10_001);
    await second;
    expect(vi.mocked(createMCPClient)).toHaveBeenCalledTimes(2);
  });

  // Finding 7: a connect that eventually succeeds AFTER withTimeout already
  // gave up must not leak its transport. Nobody is waiting on it anymore
  // (the caller already got {} back, and any cache entry for it was
  // evicted on the timeout's rejection) — without closing it here, that
  // client's transport stays open forever.
  it("closes a client that connects successfully AFTER its own connect timeout already gave up on it", async () => {
    let resolveConnect!: (client: unknown) => void;
    vi.mocked(createMCPClient).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }) as never,
    );
    const config = makeConfig();

    const pending = getMCPTools(config, { mobbinAccessToken: "test-token-late" });
    await vi.advanceTimersByTimeAsync(10_001);
    const tools = await pending;
    expect(tools).toEqual({});

    // The connect finally resolves, well after the 10s deadline gave up.
    const lateClient = {
      tools: vi.fn(async () => ({ search_screens: { execute: vi.fn() } })),
      close: vi.fn(async () => {}),
    };
    resolveConnect(lateClient);
    // Several microtask hops: createMCPClient resolving -> client.tools() ->
    // sanitize/wrap -> withTimeout's onLateResolve -> client.close().
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    expect(lateClient.close).toHaveBeenCalledTimes(1);
  });
});
