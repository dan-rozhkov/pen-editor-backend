import type { FastifyInstance } from "fastify";
import { getDefaultModel, getModels, type Config } from "../config.js";

// Exposes the chat model list (with UI metadata) so the frontend has a single
// source of truth instead of mirroring the list. The shape is derived from the
// same config helpers used to validate model overrides in the chat route.
export async function modelsRoutes(app: FastifyInstance, config: Config) {
  const models = getModels(config);
  const defaultModel = getDefaultModel(config);

  app.get("/api/models", async () => ({
    models,
    default: defaultModel,
  }));
}
