import type { FastifyInstance } from "fastify";
import { getDefaultModel, getModels, type Config } from "../config.js";
import { isVisionConfigured } from "../services/vision.js";

// Exposes the chat model list (with UI metadata) so the frontend has a single
// source of truth instead of mirroring the list. The shape is derived from the
// same config helpers used to validate model overrides in the chat route.
export async function modelsRoutes(app: FastifyInstance, config: Config) {
  const models = getModels(config);
  const defaultModel = getDefaultModel(config);
  // Whether the server can accept an image for ANY model — even one whose
  // own metadata says supportsVision: false — because an auxiliary vision
  // model is configured to describe it as text (see src/services/vision.ts).
  const visionFallback = isVisionConfigured(config);

  app.get("/api/models", async () => ({
    models,
    default: defaultModel,
    visionFallback,
  }));
}
