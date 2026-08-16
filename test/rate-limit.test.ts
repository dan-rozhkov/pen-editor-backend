import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeConfig } from "./helpers.js";

// generate-image and prototype-link both call out to real services when
// their handlers actually run — mock those out so a burst of requests past
// the rate limit doesn't depend on (or wait on) real network calls. The
// point of this file is the 429 behavior, not the handler bodies, which are
// already covered by generateImage-route.test.ts / prototype-link.test.ts.
vi.mock("../src/services/imageGen.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/imageGen.js")>();
  return { ...actual, generateImage: vi.fn(async () => ({ url: "data:image/png;base64,AAAA", mimeType: "image/png" as const })) };
});

vi.mock("../src/ai/provider.js", () => ({
  createModel: vi.fn(() => {
    throw new Error("not used — prototype-link route tests mock generatePrototypeLinks instead");
  }),
}));

vi.mock("../src/ai/prototype-link.js", () => ({
  generatePrototypeLinks: vi.fn(async () => ({ links: [] })),
}));

const { buildApp } = await import("../src/app.js");

let app: FastifyInstance;
let url: string;

beforeEach(async () => {
  app = await buildApp(makeConfig(), { logger: false });
  url = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterEach(async () => {
  await app.close();
});

async function burst(path: string, body: unknown, count: number): Promise<Response[]> {
  const responses: Response[] = [];
  for (let i = 0; i < count; i++) {
    responses.push(
      await fetch(`${url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }
  return responses;
}

describe("rate limiting", () => {
  describe("POST /api/generate-image", () => {
    it("allows a request under the limit through", async () => {
      const res = await fetch(`${url}/api/generate-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "a sunset" }),
      });
      expect(res.status).toBe(200);
    });

    it("returns 429 once the per-IP limit is exceeded within the window", async () => {
      // Route limit is 10/min/IP (src/routes/generateImage.ts) — 11 requests
      // in a row must push the 11th over it.
      const responses = await burst("/api/generate-image", { prompt: "x" }, 11);
      const statuses = responses.map((r) => r.status);
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });

  describe("POST /api/prototype-link", () => {
    const validBody = {
      screens: [
        { id: "login", name: "Login", candidates: [] },
        { id: "dashboard", name: "Dashboard", candidates: [] },
      ],
    };

    it("allows a request under the limit through", async () => {
      const res = await fetch(`${url}/api/prototype-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(200);
    });

    it("returns 429 once the per-IP limit is exceeded within the window", async () => {
      // Route limit is 10/min/IP (src/routes/prototype-link.ts).
      const responses = await burst("/api/prototype-link", validBody, 11);
      const statuses = responses.map((r) => r.status);
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });

  describe("POST /api/showcase/publish", () => {
    // No showcase store/S3 configured in makeConfig() by default, so the
    // handler 503s immediately after the rate-limit check — that's fine
    // here: the point is only that the request reaches the handler at all
    // (not rate-limited) vs. gets short-circuited with a 429.
    it("allows a request under the limit through to the handler", async () => {
      const res = await fetch(`${url}/api/showcase/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).not.toBe(429);
    });

    it("returns 429 once the per-IP limit is exceeded within the window", async () => {
      // Route limit is 10/min/IP (src/routes/showcasePublish.ts).
      const responses = await burst("/api/showcase/publish", {}, 11);
      const statuses = responses.map((r) => r.status);
      expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });

  describe("POST /api/user-skills/generate", () => {
    const validBody = { prompt: "summarize the current design system" };

    it("allows a request under the limit through to the handler", async () => {
      const res = await fetch(`${url}/api/user-skills/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });
      expect(res.status).not.toBe(429);
    });

    it("returns 429 once the per-IP limit is exceeded within the window", async () => {
      // Route limit is 10/min/IP (src/routes/userSkills.ts).
      const responses = await burst("/api/user-skills/generate", validBody, 11);
      const statuses = responses.map((r) => r.status);
      expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });

  describe("unrelated routes are not rate-limited by this change", () => {
    it("GET /api/models tolerates far more than 10 requests/minute", async () => {
      const responses: Response[] = [];
      for (let i = 0; i < 15; i++) {
        responses.push(await fetch(`${url}/api/models`));
      }
      expect(responses.every((r) => r.status === 200)).toBe(true);
    });
  });
});
