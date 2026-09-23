import { afterEach, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { TASTE_RULES } from "../src/ai/tasteCheck.js";

const { buildApp } = await import("../src/app.js");

function jevResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function cleanAnswers(overrides: Record<string, number> = {}) {
  const answers: Record<string, unknown> = {};
  for (const rule of TASTE_RULES) {
    answers[rule.id] = { type: "noul", noul: overrides[rule.id] ?? 0 };
  }
  return answers;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const validBody = {
  screens: [{ id: "1", name: "Home", html: "<div>Home</div>" }],
};

describe("POST /api/taste-check", () => {
  it("503s when TYPESAFE_API_KEY is unset", async () => {
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: undefined }), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/taste-check", payload: validBody });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("400s on an invalid body (missing screens)", async () => {
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/taste-check", payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400s when more than 8 screens are sent", async () => {
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const screens = Array.from({ length: 9 }, (_, i) => ({
      id: String(i),
      name: `Screen ${i}`,
      html: "<div>x</div>",
    }));
    const res = await app.inject({ method: "POST", url: "/api/taste-check", payload: { screens } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400s on an empty screens array", async () => {
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/taste-check", payload: { screens: [] } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns a checked result with findings on the happy path (enforce mode)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jevResponse({
          model: "jev-latest",
          answers: cleanAnswers({ gradient_text: 0.9 }),
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );
    const app = await buildApp(
      makeConfig({ TYPESAFE_API_KEY: "key", TASTE_CHECK_MODE: "enforce" }),
      { logger: false },
    );
    const res = await app.inject({ method: "POST", url: "/api/taste-check", payload: validBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("checked");
    expect(json.screens[0].findings[0].rule).toBe("gradient_text");
    expect(json.feedback).toContain("Home");
    await app.close();
  });

  it("returns null feedback in shadow mode even with findings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jevResponse({
          model: "jev-latest",
          answers: cleanAnswers({ emoji_icons: 0.95 }),
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );
    const app = await buildApp(
      makeConfig({ TYPESAFE_API_KEY: "key", TASTE_CHECK_MODE: "shadow" }),
      { logger: false },
    );
    const res = await app.inject({ method: "POST", url: "/api/taste-check", payload: validBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("checked");
    expect(json.screens[0].findings.length).toBeGreaterThan(0);
    expect(json.feedback).toBeNull();
    await app.close();
  });

  it("reports a Jev transport failure as outcome 'failed', not a 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    const app = await buildApp(
      makeConfig({ TYPESAFE_API_KEY: "key", TASTE_CHECK_MODE: "enforce" }),
      { logger: false },
    );
    const res = await app.inject({ method: "POST", url: "/api/taste-check", payload: validBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("failed");
    await app.close();
  });
});
