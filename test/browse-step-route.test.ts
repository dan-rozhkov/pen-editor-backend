import { describe, expect, it, vi, afterEach } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { makeConfig } from "./helpers.js";

// Mirrors test/prototype-link.test.ts's provider mock — the TYPE_TEXT
// happy-path test below exercises the small STRUCTURED_MODEL call.
const createModel = vi.fn(() =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
      content: [{ type: "text", text: JSON.stringify({ text: "wireless headphones" }) }],
    }),
  }),
);
vi.mock("../src/ai/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/provider.js")>();
  return { ...actual, createModel: (...args: unknown[]) => createModel(...args) };
});

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
  goal: "accept the cookie banner",
  url: "https://example.com",
  title: "Example",
  elements: [
    { index: 3, tag: "button", label: "Accept all", ops: ["CLICK"] },
  ],
  history: [],
};

describe("POST /api/browse/step", () => {
  it("503s when TYPESAFE_API_KEY is unset", async () => {
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: undefined }), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/browse/step", payload: validBody });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("400s on an invalid body", async () => {
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/browse/step", payload: { goal: "" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns a resolved CLICK decision on the happy path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jevResponse({
          model: "jev-latest",
          answers: {
            // goal_met/dead_end ride along on every fan-out now (see
            // buildBrowseStepQuestions) — the real systemone.ts response
            // schema requires an answer for every question id that was
            // sent, so a mocked response missing these would fail
            // validation and come back as a spurious "retry".
            goal_met: { type: "noul", noul: 0.1 },
            dead_end: { type: "noul", noul: 0.1 },
            op: { type: "choice", choice: "CLICK", probabilities: { CLICK: 0.9 }, confidence: 0.9 },
            target_click: { type: "choice", choice: "3", probabilities: { "3": 0.9 }, confidence: 0.9 },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/browse/step", payload: validBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("act");
    expect(json.operation).toBe("CLICK");
    expect(json.index).toBe(3);
    await app.close();
  });

  // Finding #1: a long textarea value or a big country/state/year <select>
  // used to 400 the whole request (elementSchema's value.max(500) /
  // options.max(100) rejected it outright), which burns the client loop's
  // entire step budget on identical 400s. The route must accept and
  // truncate, never reject, for realistic page content.
  it("accepts (rather than 400ing) a long textarea value and a 195-option dropdown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jevResponse({
          model: "jev-latest",
          answers: {
            goal_met: { type: "noul", noul: 0.1 },
            dead_end: { type: "noul", noul: 0.1 },
            op: { type: "choice", choice: "CLICK", probabilities: { CLICK: 0.9 }, confidence: 0.9 },
            target_click: { type: "choice", choice: "3", probabilities: { "3": 0.9 }, confidence: 0.9 },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/browse/step",
      payload: {
        ...validBody,
        elements: [
          { index: 3, tag: "button", label: "Accept all", ops: ["CLICK"] },
          {
            index: 4,
            tag: "textarea",
            label: "Message",
            ops: ["TYPE_TEXT"],
            value: "a".repeat(2_000),
          },
          {
            index: 6,
            tag: "select",
            label: "Country",
            ops: ["SELECT"],
            options: Array.from({ length: 195 }, (_, i) => `Country ${i}`),
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("refuses to type into a password field end to end", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jevResponse({
          model: "jev-latest",
          answers: {
            goal_met: { type: "noul", noul: 0.1 },
            dead_end: { type: "noul", noul: 0.1 },
            op: { type: "choice", choice: "TYPE_TEXT", probabilities: { TYPE_TEXT: 0.9 }, confidence: 0.9 },
            target_type: { type: "choice", choice: "9", probabilities: { "9": 0.9 }, confidence: 0.9 },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/browse/step",
      payload: {
        ...validBody,
        elements: [
          { index: 9, tag: "input", label: "Password", isPassword: true, ops: ["TYPE_TEXT"] },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("blocked");
    expect(json.operation).toBe("BLOCKED");
    expect(json.reason).toContain("password");
    expect(createModel).not.toHaveBeenCalled();
    await app.close();
  });

  // Finding #6: a transient Jev failure must come back as outcome "retry",
  // not the terminal "blocked" — end to end through the real route, not
  // just decideBrowseStep in isolation.
  it("reports a Jev transport failure as outcome 'retry', not 'blocked'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/browse/step", payload: validBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("retry");
    await app.close();
  });

  // New ops (2026-09-23), end to end through the real route.
  it("resolves HOVER against target_click's index end to end", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jevResponse({
          model: "jev-latest",
          answers: {
            goal_met: { type: "noul", noul: 0.1 },
            dead_end: { type: "noul", noul: 0.1 },
            op: { type: "choice", choice: "HOVER", probabilities: { HOVER: 0.9 }, confidence: 0.9 },
            target_click: { type: "choice", choice: "3", probabilities: { "3": 0.9 }, confidence: 0.9 },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/browse/step", payload: validBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("act");
    expect(json.operation).toBe("HOVER");
    expect(json.index).toBe(3);
    await app.close();
  });

  it("resolves PRESS_ENTER with no index end to end", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jevResponse({
          model: "jev-latest",
          answers: {
            goal_met: { type: "noul", noul: 0.1 },
            dead_end: { type: "noul", noul: 0.1 },
            op: {
              type: "choice",
              choice: "PRESS_ENTER",
              probabilities: { PRESS_ENTER: 0.9 },
              confidence: 0.9,
            },
            // validBody's one element supports CLICK, so the fan-out also
            // asks target_click — the response schema requires an answer
            // for every question id sent, even one PRESS_ENTER never reads.
            target_click: { type: "choice", choice: "3", probabilities: { "3": 0.9 }, confidence: 0.9 },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/browse/step", payload: validBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("act");
    expect(json.operation).toBe("PRESS_ENTER");
    expect(json.index).toBeUndefined();
    await app.close();
  });

  it("resolves PRESS_ESCAPE at a peak too low for the acting tier but high enough for the passive one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jevResponse({
          model: "jev-latest",
          answers: {
            goal_met: { type: "noul", noul: 0.1 },
            dead_end: { type: "noul", noul: 0.1 },
            op: {
              type: "choice",
              choice: "PRESS_ESCAPE",
              probabilities: { PRESS_ESCAPE: 0.5 },
              confidence: 0.5,
            },
            target_click: { type: "choice", choice: "3", probabilities: { "3": 0.9 }, confidence: 0.9 },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({ method: "POST", url: "/api/browse/step", payload: validBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("act");
    expect(json.operation).toBe("PRESS_ESCAPE");
    await app.close();
  });
});
