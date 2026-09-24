import { describe, expect, it, vi, afterEach } from "vitest";
import { makeConfig } from "./helpers.js";

const { buildApp } = await import("../src/app.js");

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

// Stubs global fetch so the Jev (System One) `locate` question answers with
// element `index` at probability `p`.
function stubJevLocate(index: string, p: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: {
              locate: {
                type: "choice",
                choice: index,
                probabilities: { [index]: p },
                confidence: p,
              },
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
}

// One POST /api/browse/locate against a fresh app.
async function postLocate(payload: Record<string, unknown>, config = makeConfig({ TYPESAFE_API_KEY: "key" })) {
  const app = await buildApp(config, { logger: false });
  try {
    return await app.inject({ method: "POST", url: "/api/browse/locate", payload });
  } finally {
    await app.close();
  }
}

describe("POST /api/browse/locate", () => {
  it("503s when TYPESAFE_API_KEY is unset", async () => {
    const res = await postLocate(validBody, makeConfig({ TYPESAFE_API_KEY: undefined }));
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("TYPESAFE_API_KEY");
  });

  it.each([
    ["an invalid body (empty description)", { description: "" }],
    ["a description over 300 characters", { description: "a".repeat(301) }],
    ["an invalid operation", { operation: "SCROLL_DOWN" }],
  ])("400s on %s", async (_name, patch) => {
    const res = await postLocate({ ...validBody, ...patch });
    expect(res.statusCode).toBe(400);
  });

  it("returns a found outcome on the happy path", async () => {
    stubJevLocate("3", 0.9);
    const res = await postLocate(validBody);
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("found");
    expect(json.index).toBe(3);
    expect(json.label).toBe("Continue");
    expect(json.confidence).toBeCloseTo(0.9);
    expect(json.model).toBe("jev-latest");
  });

  // Browse-speed contract (2026-09-24), scroll containers: the same
  // elementSchema is shared with /api/browse/step (browseStep.ts), so a
  // scroll-container entry (`ops: [], scrollable: true`) must not 400 here
  // either, and a genuinely empty `ops` without `scrollable` still should.
  it("accepts an element with empty ops when scrollable is true, alongside a real candidate", async () => {
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
      payload: {
        ...validBody,
        elements: [
          { index: 3, tag: "button", label: "Continue", ops: ["CLICK"] },
          { index: 4, tag: "div", label: "Comments list", ops: [], scrollable: true },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("400s an element with empty ops when scrollable is not set", async () => {
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/browse/locate",
      payload: {
        ...validBody,
        elements: [{ index: 4, tag: "div", label: "Mystery element", ops: [] }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns not_found for a peak below the threshold", async () => {
    stubJevLocate("3", 0.2);
    const res = await postLocate(validBody);
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("not_found");
  });

  it("returns not_found with zero candidates for the requested operation, without hitting the vendor", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await postLocate({
      ...validBody,
      operation: "SELECT",
      elements: [{ index: 3, tag: "button", label: "Continue", ops: ["CLICK"] }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("not_found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to resolve a TYPE_TEXT description onto a password field end to end", async () => {
    stubJevLocate("9", 0.9);
    const res = await postLocate({
      description: "the password field",
      operation: "TYPE_TEXT",
      url: "https://example.com",
      title: "Example",
      elements: [
        { index: 9, tag: "input", label: "Password", isPassword: true, ops: ["TYPE_TEXT"] },
      ],
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("not_found");
    expect(json.reason).toContain("password");
  });

  it("accepts operation FOCUS", async () => {
    stubJevLocate("3", 0.9);
    const res = await postLocate({ ...validBody, operation: "FOCUS" });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("found");
  });

  it("reports a Jev transport failure as outcome 'retry'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    const res = await postLocate(validBody);
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("retry");
  });
});
