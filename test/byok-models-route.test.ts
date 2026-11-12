import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { byokRoutes } from "../src/routes/byok.js";
import { makeConfig } from "./helpers.js";

const HEADERS = {
  "x-byok-base-url": "https://api.example.com/v1/",
  "x-byok-key": "sk-secret-canary",
};

let app: FastifyInstance;
const upstream = vi.fn<typeof fetch>();

beforeEach(async () => {
  upstream.mockReset();
  app = Fastify();
  await byokRoutes(app, makeConfig(), { fetchImpl: upstream });
});

afterEach(async () => {
  await app.close();
});

const call = (headers: Record<string, string> = HEADERS) =>
  app.inject({ method: "POST", url: "/api/byok/models", headers });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("POST /api/byok/models", () => {
  it("returns sorted, deduped models with contextWindow and calls <base>/models with the bearer key", async () => {
    upstream.mockResolvedValue(
      json({
        data: [
          { id: "b-model", context_length: 8192 },
          { id: "a-model", context_window: 1000 },
          { id: "b-model", context_length: 1 },
          { id: "c-model", context_length: "nope" },
          { nope: true },
        ],
      }),
    );
    const res = await call();
    expect(res.json()).toEqual({
      ok: true,
      models: [
        { id: "a-model", contextWindow: 1000 },
        { id: "b-model", contextWindow: 8192 },
        { id: "c-model" },
      ],
    });
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/models");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-secret-canary");
  });

  it("accepts a bare array", async () => {
    upstream.mockResolvedValue(json([{ id: "m1" }]));
    expect((await call()).json()).toEqual({ ok: true, models: [{ id: "m1" }] });
  });

  it("caps the list at 2000 entries", async () => {
    const data = Array.from({ length: 2500 }, (_, i) => ({ id: `m${String(i).padStart(5, "0")}` }));
    upstream.mockResolvedValue(json({ data }));
    const body = (await call()).json() as { models: unknown[] };
    expect(body.models).toHaveLength(2000);
  });

  it.each([
    [401, "invalid_key"],
    [403, "invalid_key"],
    [404, "no_model_list"],
    [405, "no_model_list"],
    [500, "upstream_error"],
    [429, "upstream_error"],
  ])("maps upstream %i to %s", async (status, reason) => {
    upstream.mockResolvedValue(new Response("x", { status }));
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, reason });
  });

  it("maps a network error to upstream_error without echoing the key", async () => {
    upstream.mockRejectedValue(new Error("connect failed for sk-secret-canary"));
    const res = await call();
    expect(res.json()).toEqual({ ok: false, reason: "upstream_error" });
    expect(res.body).not.toContain("canary");
  });

  it("maps a non-JSON 200 to upstream_error", async () => {
    upstream.mockResolvedValue(new Response("<html>", { status: 200 }));
    expect((await call()).json()).toEqual({ ok: false, reason: "upstream_error" });
  });

  it.each([
    [{ "x-byok-base-url": HEADERS["x-byok-base-url"] }],
    [{ "x-byok-key": HEADERS["x-byok-key"] }],
    [{}],
  ])("400s byok_key_required when a header is missing (%j)", async (headers) => {
    const res = await call(headers);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "byok_key_required" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["http://api.example.com/v1", "https://127.0.0.1/v1", "https://u:p@api.example.com/v1"])(
    "400s byok_base_url_invalid for %s",
    async (baseUrl) => {
      const res = await call({ ...HEADERS, "x-byok-base-url": baseUrl });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "byok_base_url_invalid" });
      expect(upstream).not.toHaveBeenCalled();
    },
  );
});
