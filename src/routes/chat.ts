import {
  streamText,
  convertToModelMessages,
  type UIMessage,
} from "ai";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { createModel } from "../ai/provider.js";
import { penTools } from "../ai/tools.js";
import { buildSystemPrompt } from "../ai/system-prompt.js";

const chatBodySchema = z.object({
  messages: z.array(z.record(z.unknown())).min(1, "messages must not be empty"),
  canvasContext: z.string().optional(),
  model: z.string().optional(),
});

export async function chatRoutes(app: FastifyInstance, config: Config) {
  app.post("/api/chat", async (request, reply) => {
    const parsed = chatBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.format(),
      });
    }

    const { messages, canvasContext, model: modelOverride } = parsed.data;
    const model = createModel(config, modelOverride);
    const system = buildSystemPrompt(canvasContext);

    const modelMessages = await convertToModelMessages(
      messages as unknown as UIMessage[]
    );

    const result = streamText({
      model,
      system,
      messages: modelMessages,
      tools: penTools,
      onFinish({ usage }) {
        console.log(
          `[tokens] input: ${usage.inputTokens}, output: ${usage.outputTokens}, cache read: ${usage.inputTokenDetails?.cacheReadTokens ?? "n/a"}`
        );
      },
    });

    // Set CORS headers manually since reply.hijack() bypasses Fastify plugins.
    const origin = request.headers.origin;
    if (origin) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
    }

    // Pipe the UI message stream directly to the raw Node.js response,
    // bypassing Fastify's send() which can't handle object streams.
    result.pipeUIMessageStreamToResponse(reply.raw);

    // Tell Fastify we already handled the response.
    reply.hijack();
  });
}
