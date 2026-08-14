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
  it("returns the built-in models with metadata first", () => {
    const models = getModels(makeConfig());
    expect(models.slice(0, DEFAULT_MODELS.length)).toEqual(DEFAULT_MODELS);
  });

  it("appends extra allowed models labelled by id and vision-capable", () => {
    const models = getModels(
      makeConfig({ OPENROUTER_ALLOWED_MODELS: "custom/model-a" }),
    );
    const extra = models.find((m) => m.id === "custom/model-a");
    expect(extra).toEqual<ModelOption>({
      id: "custom/model-a",
      label: "custom/model-a",
      supportsVision: true,
    });
  });

  it("includes the active OPENROUTER_MODEL even if not built in", () => {
    const models = getModels(makeConfig({ OPENROUTER_MODEL: "vendor/x" }));
    expect(models.some((m) => m.id === "vendor/x")).toBe(true);
  });

  it("does not duplicate a built-in model requested as an extra", () => {
    const id = DEFAULT_MODELS[0].id;
    const models = getModels(
      makeConfig({ OPENROUTER_MODEL: id, OPENROUTER_ALLOWED_MODELS: id }),
    );
    expect(models.filter((m) => m.id === id)).toHaveLength(1);
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
    const base = await start(
      makeConfig({
        OPENROUTER_MODEL: DEFAULT_MODELS[0].id,
        OPENROUTER_ALLOWED_MODELS: "custom/extra",
      }),
    );
    const res = await fetch(`${base}/api/models`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      models: ModelOption[];
      default: string;
      visionFallback: boolean;
    };
    expect(body.default).toBe(DEFAULT_MODELS[0].id);
    expect(body.models).toEqual(getModels(makeConfig({
      OPENROUTER_MODEL: DEFAULT_MODELS[0].id,
      OPENROUTER_ALLOWED_MODELS: "custom/extra",
    })));
    expect(body.models.some((m) => m.id === "custom/extra")).toBe(true);
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
