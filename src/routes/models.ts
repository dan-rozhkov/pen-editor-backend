import type { FastifyInstance } from "fastify";
import { getDefaultModel, getModels, type Config } from "../config.js";
import { isVisionConfigured } from "../services/vision.js";

// Exposes the chat model list (with UI metadata) so the frontend has a single
// source of truth instead of mirroring the list. The shape is derived from the
// same config helpers used to validate model overrides in the chat route.
//
// Every entry's `requiresUserKey` flows straight from DEFAULT_MODELS/getModels
// (src/config.ts) with no transformation here: `true` for the OpenCode BYOK
// entries, and simply ABSENT (not `false`) for every OpenRouter entry, since
// ModelOption never sets the field for those and JSON.stringify drops an
// undefined property. The frontend's picker treats "absent" and "false" the
// same way (no lock icon, no key required) — see chatModels.ts.
export async function modelsRoutes(app: FastifyInstance, config: Config) {
  const models = getModels(config);
  const defaultModel = getDefaultModel(config);
  // Whether the server can accept an image for ANY model — even one whose
  // own metadata says supportsVision: false — because an auxiliary vision
  // model is configured to describe it as text (see src/services/vision.ts).
  const visionFallback = isVisionConfigured(config);
  // Whether the fal.ai image-op routes/tools (remove_background,
  // vectorize_image) are usable on this deployment — same gating channel as
  // visionFallback, so the frontend can hide the buttons rather than let the
  // user hit a 503.
  const imageOps = {
    removeBackground: Boolean(config.FAL_KEY),
    vectorize: Boolean(config.FAL_KEY),
  };

  app.get("/api/models", async () => ({
    models,
    default: defaultModel,
    visionFallback,
    imageOps,
  }));
}
