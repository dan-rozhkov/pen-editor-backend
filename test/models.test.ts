import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_MODELS,
  getModels,
  type ModelOption,
} from "../src/config.js";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";
import type { Config } from "../src/config.js";

describe("getModels", () => {
  it("serves exactly one model by default", () => {
    expect(getModels(makeConfig())).toEqual(DEFAULT_MODELS);
  });

  it("appends an operator-pointed OPENROUTER_MODEL labelled by id and vision-capable", () => {
    const models = getModels(makeConfig({ OPENROUTER_MODEL: "vendor/x" }));
    const extra = models.find((m) => m.id === "vendor/x");
    expect(extra).toEqual<ModelOption>({
      id: "vendor/x",
      label: "vendor/x",
      supportsVision: true,
    });
  });

  it("does not duplicate the built-in model when OPENROUTER_MODEL matches it", () => {
    const id = DEFAULT_MODELS[0].id;
    const models = getModels(makeConfig({ OPENROUTER_MODEL: id }));
    expect(models).toEqual(DEFAULT_MODELS);
    // built-in metadata is preserved, not overwritten by the id-only entry
    expect(models.find((m) => m.id === id)).toEqual(DEFAULT_MODELS[0]);
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
    const base = await start(makeConfig({ OPENROUTER_MODEL: DEFAULT_MODELS[0].id }));
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
