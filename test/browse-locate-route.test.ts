import { describe, expect, it, vi, afterEach } from "vitest";
import { makeConfig } from "./helpers.js";

const { buildApp } = await import("../src/app.js");

function jevResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const validBody = {
  description: "the Continue button in the cookie banner",
  operation: "CLICK",
  url: "https://example.com",
  title: "Example",
  elements: [{ index: 3, tag: "button", label: "Continue", ops: ["CLICK"] }],
};

describe("POST /api/browse/locate", () => {
  it("503s when TYPESAFE_API_KEY is unset", async () => {
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: undefined }), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/browse/locate", payload: validBody });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("TYPESAFE_API_KEY");
    await app.close();
  });

  it("400s on an invalid body (empty description)", async () => {
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/browse/locate",
      payload: { ...validBody, description: "" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400s on a description over 300 characters", async () => {
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/browse/locate",
      payload: { ...validBody, description: "a".repeat(301) },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400s on an invalid operation", async () => {
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/browse/locate",
      payload: { ...validBody, operation: "SCROLL_DOWN" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns a found outcome on the happy path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jevResponse({
          model: "jev-latest",
          answers: {
            locate: { type: "choice", choice: "3", probabilities: { "3": 0.9 }, confidence: 0.9 },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/browse/locate", payload: validBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("found");
    expect(json.index).toBe(3);
    expect(json.label).toBe("Continue");
    expect(json.confidence).toBeCloseTo(0.9);
    expect(json.model).toBe("jev-latest");
    await app.close();
  });

  it("returns not_found for a peak below the threshold", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jevResponse({
          model: "jev-latest",
          answers: {
            locate: { type: "choice", choice: "3", probabilities: { "3": 0.2 }, confidence: 0.2 },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/browse/locate", payload: validBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("not_found");
    await app.close();
  });

  it("returns not_found with zero candidates for the requested operation, without hitting the vendor", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/browse/locate",
      payload: {
        ...validBody,
        operation: "SELECT",
        elements: [{ index: 3, tag: "button", label: "Continue", ops: ["CLICK"] }],
      },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("not_found");
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses to resolve a TYPE_TEXT description onto a password field end to end", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jevResponse({
          model: "jev-latest",
          answers: {
            locate: { type: "choice", choice: "9", probabilities: { "9": 0.9 }, confidence: 0.9 },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/browse/locate",
      payload: {
        description: "the password field",
        operation: "TYPE_TEXT",
        url: "https://example.com",
        title: "Example",
        elements: [
          { index: 9, tag: "input", label: "Password", isPassword: true, ops: ["TYPE_TEXT"] },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("not_found");
    expect(json.reason).toContain("password");
    await app.close();
  });

  it("accepts operation FOCUS", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jevResponse({
          model: "jev-latest",
          answers: {
            locate: { type: "choice", choice: "3", probabilities: { "3": 0.9 }, confidence: 0.9 },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/browse/locate",
      payload: { ...validBody, operation: "FOCUS" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("found");
    await app.close();
  });

  it("reports a Jev transport failure as outcome 'retry'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/browse/locate", payload: validBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("retry");
    await app.close();
  });
});
