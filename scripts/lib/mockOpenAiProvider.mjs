// A real local OpenAI-compatible HTTP server for the local-mode tests and the
// bundle smoke test (scripts/smoke-local-bundle.mjs): streaming
// POST /v1/chat/completions (SSE) that answers with `text`, and GET /v1/models.
// No dependency on the backend's source, so it can drive a bundle.
import { createServer } from "node:http";

/**
 * @param {string} text what the "model" says
 * @returns {Promise<{ baseUrl: string, host: string, requests: Array<{ method: string, url: string, authorization?: string, body?: any }>, close: () => Promise<void> }>}
 */
export async function startMockProvider(text) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      requests.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body });
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "mock-model", context_length: 32000 }] }));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: "mock-model" };
        const send = (choice, extra = {}) =>
          res.write(`data: ${JSON.stringify({ ...base, choices: choice ? [choice] : [], ...extra })}\n\n`);
        send({ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null });
        send({ index: 0, delta: { content: text }, finish_reason: null });
        send({ index: 0, delta: {}, finish_reason: "stop" });
        send(null, { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        res.end("data: [DONE]\n\n");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    host: `127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
