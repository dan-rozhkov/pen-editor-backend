import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(),
}));

import { createMCPClient } from "@ai-sdk/mcp";
import { getMCPTools } from "../src/ai/mcp.js";
import { makeConfig } from "./helpers.js";

describe("getMCPTools timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(createMCPClient).mockReset();
  });

  it("gives up on a hung MCP server after the timeout and returns no tools", async () => {
    // A connection that never settles:
    vi.mocked(createMCPClient).mockImplementation(
      () => new Promise(() => {}) as never,
    );
    const config = makeConfig({ REFERO_API_KEY: "test-key" });

    const pending = getMCPTools(config);
    await vi.advanceTimersByTimeAsync(10_001);
    const tools = await pending;

    expect(tools).toEqual({});

    // The failed entry must be evicted so the next call retries:
    const second = getMCPTools(config);
    await vi.advanceTimersByTimeAsync(10_001);
    await second;
    expect(vi.mocked(createMCPClient)).toHaveBeenCalledTimes(2);
  });
});
