import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

// Regression: a client disconnect aborts the model request, then cancels its
// stream. When the consumer lags (the provider's wrapper has a chunk buffered
// and is not pulling), the source errors with AbortError unnoticed. @openrouter/ai-sdk-provider@3.1.0's
// withStreamErrorHandling dropped the promise from `reader.cancel(reason)`, so
// the aborted fetch body's AbortError became an unhandled rejection and killed
// the whole server process. Fixed by patches/@openrouter+ai-sdk-provider+*.patch.

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};
let server: Server | undefined;

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  unhandled.length = 0;
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

describe("OpenRouter stream cancel after abort", () => {
  it("does not leak an unhandled rejection", async () => {
    process.on("unhandledRejection", onUnhandled);
    // An upstream that sends more chunks than the consumer reads, then keeps
    // the response open.
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < 50; i++) {
        res.write('data: {"id":"x","model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const openrouter = createOpenRouter({ apiKey: "test", baseURL: `http://127.0.0.1:${port}` });
    const abort = new AbortController();
    const { stream } = await openrouter("openai/gpt-4o").doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      abortSignal: abort.signal,
    });
    const reader = stream.getReader();
    await reader.read();
    abort.abort();
    // Let the abort reach the source before the cancel, as with a real client.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await reader.cancel(new Error("client disconnected")).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(unhandled).toEqual([]);
  });
});
