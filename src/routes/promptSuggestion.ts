import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { abortOnClientDisconnect } from "./clientDisconnect.js";
import { generatePromptSuggestion } from "../ai/prompt-suggestion.js";

const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(2000),
      }),
    )
    .min(1)
    .max(20),
});

export async function promptSuggestionRoutes(
  app: FastifyInstance,
  config: Config,
): Promise<void> {
  app.post(
    "/api/prompt-suggestion",
    {
      config: {
        // Unauthenticated and each request is an LLM call, like
        // prototype-link. The client fires one request per finished turn of
        // the visible chat, so 20/min/IP is ample for a real session and
        // still bounds a script hammering the endpoint.
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      if (!parsed.data.messages.some((m) => m.role === "user")) {
        return reply
          .status(400)
          .send({ error: "at least one user message is required" });
      }
      const controller = abortOnClientDisconnect(reply);
      try {
        const suggestion = await generatePromptSuggestion(
          parsed.data.messages,
          config,
          controller.signal,
        );
        return reply.send({ suggestion });
      } catch (err) {
        // Best-effort: the UI must never surface an error for a suggestion.
        app.log.warn({ err }, "prompt-suggestion failed");
        return reply.send({ suggestion: null });
      }
    },
  );
}
