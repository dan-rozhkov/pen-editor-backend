import { streamText, type Message } from "ai";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { createModel } from "../ai/provider.js";
import { penTools } from "../ai/tools.js";
import { buildSystemPrompt } from "../ai/system-prompt.js";

const chatBodySchema = z.object({
  messages: z.array(z.record(z.unknown())).min(1, "messages must not be empty"),
  canvasContext: z.string().optional(),
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

    const { messages, canvasContext } = parsed.data;
    const model = createModel(config);
    const system = buildSystemPrompt(canvasContext);

    const result = streamText({
      model,
      system,
      messages: messages as unknown as Message[],
      tools: penTools,
    });

    reply.header("Content-Type", "text/plain; charset=utf-8");
    reply.header("X-Vercel-AI-Data-Stream", "v1");

    return reply.send(result.toDataStream());
  });
}
