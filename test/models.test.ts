import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_MODELS,
  envSchema,
  getModels,
  type ModelOption,
} from "../src/config.js";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";
import type { Config } from "../src/config.js";

describe("getModels", () => {
  // makeConfig()'s own CHAT_MODEL default is a bare legacy id kept for the
  // rest of the suite's OpenRouter-mocked tests (see helpers.ts) — it does
  // NOT equal the built-in model, so this exercises "exactly one model" by
  // pointing CHAT_MODEL at the built-in id explicitly. The real prefixed
  // shipped default is covered separately below.
  it("serves exactly one model when CHAT_MODEL matches the built-in id", () => {
    expect(getModels(makeConfig({ CHAT_MODEL: DEFAULT_MODELS[0].id }))).toEqual(
      DEFAULT_MODELS,
    );
  });

  it("appends an operator-pointed CHAT_MODEL labelled by id and vision-capable", () => {
    const models = getModels(makeConfig({ CHAT_MODEL: "vendor/x" }));
    const extra = models.find((m) => m.id === "vendor/x");
    expect(extra).toEqual<ModelOption>({
      id: "vendor/x",
      label: "vendor/x",
      supportsVision: true,
    });
  });

  it("does not duplicate the built-in model when CHAT_MODEL matches it", () => {
    const id = DEFAULT_MODELS[0].id;
    const models = getModels(makeConfig({ CHAT_MODEL: id }));
    expect(models).toEqual(DEFAULT_MODELS);
    // built-in metadata is preserved, not overwritten by the id-only entry
    expect(models.find((m) => m.id === id)).toEqual(DEFAULT_MODELS[0]);
  });

  // The real shipped default carries a "deepseek:" provider prefix
  // (envSchema's CHAT_MODEL default) — getModels/getDefaultModel must strip
  // it via bareModelId before comparing against DEFAULT_MODELS' bare id, or
  // this would silently duplicate the built-in entry ("deepseek:deepseek-flash"
  // !== "deepseek-flash") and leak the prefix into GET /api/models.
  it("does not duplicate the built-in model for the real prefixed shipped default", () => {
    const shippedDefault = envSchema.shape.CHAT_MODEL.parse(undefined);
    const models = getModels(makeConfig({ CHAT_MODEL: shippedDefault }));
    expect(models).toEqual(DEFAULT_MODELS);
  });

  // Fix 4, 2026-09 DeepSeek-direct review: CHAT_MODEL_SUPPORTS_VISION used to
  // be consulted ONLY in the "no built-in entry" branch above, so an
  // operator setting it for the DEFAULT model (which always has a built-in
  // entry) had zero effect — the built-in `supportsVision: true` always won.
  describe("CHAT_MODEL_SUPPORTS_VISION overriding the built-in default model", () => {
    it("leaves the built-in entry untouched when the operator never set the flag", () => {
      const models = getModels(
        makeConfig({ CHAT_MODEL: DEFAULT_MODELS[0].id, CHAT_MODEL_SUPPORTS_VISION: undefined }),
      );
      expect(models).toEqual(DEFAULT_MODELS);
    });

    it("overrides the built-in entry to false when the operator explicitly sets it", () => {
      const models = getModels(
        makeConfig({ CHAT_MODEL: DEFAULT_MODELS[0].id, CHAT_MODEL_SUPPORTS_VISION: false }),
      );
      expect(models).toEqual<ModelOption[]>([{ ...DEFAULT_MODELS[0], supportsVision: false }]);
    });

    it("overrides the built-in entry to true when the operator explicitly re-affirms it", () => {
      const models = getModels(
        makeConfig({ CHAT_MODEL: DEFAULT_MODELS[0].id, CHAT_MODEL_SUPPORTS_VISION: true }),
      );
      expect(models).toEqual(DEFAULT_MODELS);
    });
  });
});

describe("GET /api/models", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  async function start(config: Config): Promise<string> {
    app = await buildApp(config, { logger: false });
    return app.listen({ port: 0, host: "127.0.0.1" });
  }

  it("returns the model list and default model", async () => {
    const base = await start(makeConfig({ CHAT_MODEL: DEFAULT_MODELS[0].id }));
    const res = await fetch(`${base}/api/models`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      models: ModelOption[];
      default: string;
      visionFallback: boolean;
    };
    expect(body.default).toBe(DEFAULT_MODELS[0].id);
    expect(body.models).toEqual(DEFAULT_MODELS);
    // VISION_MODEL defaults to a non-empty value in makeConfig(), so the
    // server reports it can fall back to auxiliary vision for any model.
    expect(body.visionFallback).toBe(true);
  });

  it("reports visionFallback: false when VISION_MODEL is empty", async () => {
    const base = await start(makeConfig({ VISION_MODEL: "" }));
    const res = await fetch(`${base}/api/models`);
    const body = (await res.json()) as { visionFallback: boolean };
    expect(body.visionFallback).toBe(false);
  });
});
