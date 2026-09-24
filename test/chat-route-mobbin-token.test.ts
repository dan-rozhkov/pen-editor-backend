import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { chatMocks, mockModel, resetChatMocks, textStreamChunks, userMessage } from "./chatMocks.js";
import { postChat, recordingTraceStore, startApp, type RunningApp } from "./chatHarness.js";

// ---------------------------------------------------------------------------
// Verifies the X-Mobbin-Token contract end to end over real HTTP:
//   - the header reaches getMCPTools via prepareChatTurn
//   - no token at all yields a request that never asked getMCPTools for one
//   - the raw token text never appears anywhere `messages`/raw_traces sees
// ---------------------------------------------------------------------------

vi.mock("../src/ai/provider.js", async (importOriginal) =>
  (await import("./chatMocks.js")).mockProviderModule(await importOriginal()),
);
vi.mock("../src/ai/mcp.js", async () => (await import("./chatMocks.js")).mockMcpModule());

let server: RunningApp;

beforeEach(() => {
  resetChatMocks();
  chatMocks.model = mockModel(textStreamChunks("hi"));
});

afterAll(async () => {
  await server?.close();
});

describe("X-Mobbin-Token", () => {
  it("threads the header value into getMCPTools as mobbinAccessToken", async () => {
    server = await startApp();

    await (
      await postChat(
        server.url,
        { id: "tab-mobbin-1", messages: [userMessage("hello")] },
        { "X-Mobbin-Token": "real-secret-token-value" },
      )
    ).text();

    expect(chatMocks.mcpToolCalls.length).toBeGreaterThan(0);
    expect(chatMocks.mcpToolCalls[0]?.mobbinAccessToken).toBe("real-secret-token-value");
    await server.close();
  });

  it("calls getMCPTools with no mobbinAccessToken when the header is absent", async () => {
    server = await startApp();

    await (await postChat(server.url, { id: "tab-mobbin-2", messages: [userMessage("hello")] })).text();

    expect(chatMocks.mcpToolCalls.length).toBeGreaterThan(0);
    expect(chatMocks.mcpToolCalls[0]?.mobbinAccessToken).toBeUndefined();
    await server.close();
  });

  it("ignores an absurdly long header value rather than passing it through", async () => {
    server = await startApp();

    await (
      await postChat(
        server.url,
        { id: "tab-mobbin-3", messages: [userMessage("hello")] },
        { "X-Mobbin-Token": "x".repeat(8193) },
      )
    ).text();

    expect(chatMocks.mcpToolCalls[0]?.mobbinAccessToken).toBeUndefined();
    await server.close();
  });

  it("never writes the token into the raw_traces row, even though the request carried one", async () => {
    const store = recordingTraceStore();
    server = await startApp(makeConfig(), { traceStore: store });
    const secretToken = "do-not-leak-this-mobbin-token-9f3e";

    await (
      await postChat(
        server.url,
        { id: "tab-mobbin-4", messages: [userMessage("hello")] },
        { "X-Mobbin-Token": secretToken },
      )
    ).text();

    await vi.waitFor(() => expect(store.rows).toHaveLength(1));
    // The whole point: nothing about this request's trace row — not the
    // stored messages, not any other field — ever contains the token text.
    expect(JSON.stringify(store.rows[0])).not.toContain(secretToken);
    await server.close();
  });
});
