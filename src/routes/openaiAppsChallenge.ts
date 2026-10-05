import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";

// OpenAI plugin-directory domain verification: the path must return ONLY the
// token as plain text. Unset token = 404, as if the route did not exist.
export async function openaiAppsChallengeRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const token = config.OPENAI_APPS_CHALLENGE_TOKEN;
  app.get("/.well-known/openai-apps-challenge", async (_request, reply) => {
    if (!token) return reply.status(404).send({ error: "not_found" });
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("cache-control", "no-store")
      .send(token);
  });
}
