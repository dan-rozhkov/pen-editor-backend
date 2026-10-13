import { aiSdkTextModel } from "@sideform/browser-agent/adapters/ai-sdk";
import type { BrowsePolicyOptions, TextModel } from "@sideform/browser-agent/policy";
import type { Config } from "../config.js";
import { createSystemOne } from "../services/systemone.js";
import { createModel } from "./provider.js";

// The one place the backend turns its Config into the browse policy's
// options (the policy itself lives in @sideform/browser-agent/policy).

// The model is built on every call, not once: createModel reads provider
// state per call (and tests swap it), so a captured instance would go stale.
function lazyTextModel(modelId: string, config: Config): TextModel {
  return {
    id: modelId,
    generateObject: (req) =>
      aiSdkTextModel(createModel(config, modelId, { reasoningEffort: "none" }), { id: modelId }).generateObject(req),
  };
}

/** null when TYPESAFE_API_KEY is unset: browsing is not configured. */
export function createBrowsePolicy(config: Config): BrowsePolicyOptions | null {
  const decisions = createSystemOne(config);
  if (!decisions) return null;
  return {
    decisions,
    models: {
      structured: lazyTextModel(config.STRUCTURED_MODEL, config),
      cascade: lazyTextModel(config.BROWSE_CASCADE_MODEL, config),
    },
    policy: config.BROWSE_STEP_POLICY,
    vision: config.BROWSE_STEP_VISION === "on",
    decisionModel: config.TYPESAFE_MODEL,
  };
}

/** What planGoal needs: only the cascade model. It never asks System One, so
 * the decision client is a stub that fails loudly if that ever changes. */
export function createBrowsePlanPolicy(config: Config): BrowsePolicyOptions | null {
  if (!config.TYPESAFE_API_KEY) return null;
  const cascade = lazyTextModel(config.BROWSE_CASCADE_MODEL, config);
  return {
    decisions: {
      evaluate: () => Promise.reject(new Error("browse plan does not use System One")),
    },
    models: { structured: cascade, cascade },
  };
}
