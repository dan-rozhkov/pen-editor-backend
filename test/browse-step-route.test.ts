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

// A Jev `choice` answer peaking at `choice` with probability `p`.
function choice(value: string, p = 0.9) {
  return { type: "choice", choice: value, probabilities: { [value]: p }, confidence: p };
}

// goal_met/dead_end ride along on every fan-out now (see
// buildBrowseStepQuestions) — the real systemone.ts response schema requires
// an answer for every question id that was sent, so a mocked response
// missing these would fail validation and come back as a spurious "retry".
const NOT_DONE = {
  goal_met: { type: "noul", noul: 0.1 },
  dead_end: { type: "noul", noul: 0.1 },
};

// Stubs global fetch so the Jev (System One) call answers with `answers`.
function stubJev(answers: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: { ...NOT_DONE, ...answers },
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
}

// One POST /api/browse/step against a fresh app.
async function postStep(payload: Record<string, unknown>, config = makeConfig({ TYPESAFE_API_KEY: "key" })) {
  const app = await buildApp(config, { logger: false });
  try {
    return await app.inject({ method: "POST", url: "/api/browse/step", payload });
  } finally {
    await app.close();
  }
}

describe("POST /api/browse/step", () => {
  it("503s when TYPESAFE_API_KEY is unset", async () => {
    const res = await postStep(validBody, makeConfig({ TYPESAFE_API_KEY: undefined }));
    expect(res.statusCode).toBe(503);
  });

  it("400s on an invalid body", async () => {
    const res = await postStep({ goal: "" });
    expect(res.statusCode).toBe(400);
  });

  it("returns a resolved CLICK decision on the happy path", async () => {
    stubJev({ op: choice("CLICK"), target_click: choice("3") });
    const res = await postStep(validBody);
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("act");
    expect(json.operation).toBe("CLICK");
    expect(json.index).toBe(3);
  });

  // Finding #1: a long textarea value or a big country/state/year <select>
  // used to 400 the whole request (elementSchema's value.max(500) /
  // options.max(100) rejected it outright), which burns the client loop's
  // entire step budget on identical 400s. The route must accept and
  // truncate, never reject, for realistic page content.
  it("accepts (rather than 400ing) a long textarea value and a 195-option dropdown", async () => {
    stubJev({ op: choice("CLICK"), target_click: choice("3") });
    const res = await postStep({
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
    });
    expect(res.statusCode).toBe(200);
  });

  // Browse-speed contract (2026-09-24) item 5: the body accepts an optional
  // top-level `scroll` plus per-element `scrollable`/`frame`/`checked`
  // without zod silently stripping any of them — 200 end to end, and the
  // resulting decision reflects the element the digest still picked out.
  it("accepts scroll and element scrollable/frame/checked fields", async () => {
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
        scroll: { y: 200, height: 900, atBottom: false },
        elements: [
          {
            index: 3,
            tag: "button",
            label: "Accept all",
            ops: ["CLICK"],
            checked: false,
            scrollable: true,
            frame: "consent-iframe",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("act");
    expect(json.index).toBe(3);
    await app.close();
  });

  // Browse-speed contract (2026-09-24), scroll containers: a scroll
  // container entry (`ops: [], scrollable: true`) must not 400 the whole
  // step just because it has no CLICK/TYPE_TEXT/SELECT of its own — the
  // request still 200s (using the other, real candidate for its decision).
  it("accepts an element with empty ops when scrollable is true, alongside a real candidate", async () => {
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
          { index: 4, tag: "div", label: "Comments list", ops: [], scrollable: true },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // Same shape, but WITHOUT `scrollable: true` — an empty `ops` on an
  // ordinary element is still rejected, not silently allowed through.
  it("400s an element with empty ops when scrollable is not set", async () => {
    const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key" }), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/browse/step",
      payload: {
        ...validBody,
        elements: [{ index: 4, tag: "div", label: "Mystery element", ops: [] }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("refuses to type into a password field end to end", async () => {
    stubJev({ op: choice("TYPE_TEXT"), target_type: choice("9") });
    const res = await postStep({
      ...validBody,
      elements: [
        { index: 9, tag: "input", label: "Password", isPassword: true, ops: ["TYPE_TEXT"] },
      ],
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("blocked");
    expect(json.operation).toBe("BLOCKED");
    expect(json.reason).toContain("password");
    expect(createModel).not.toHaveBeenCalled();
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
    const res = await postStep(validBody);
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("retry");
  });

  // New ops (2026-09-23), end to end through the real route. validBody's one
  // element supports CLICK, so the fan-out always also asks target_click —
  // the response schema requires an answer for every question id sent, even
  // one PRESS_ENTER/PRESS_ESCAPE never reads.
  it.each([
    ["HOVER against target_click's index", "HOVER", 0.9, 3],
    ["PRESS_ENTER with no index", "PRESS_ENTER", 0.9, undefined],
    // A peak too low for the acting tier but high enough for the passive one.
    ["PRESS_ESCAPE at a peak only the passive tier accepts", "PRESS_ESCAPE", 0.5, undefined],
  ] as const)("resolves %s end to end", async (_name, op, peak, index) => {
    stubJev({ op: choice(op, peak), target_click: choice("3") });
    const res = await postStep(validBody);
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.outcome).toBe("act");
    expect(json.operation).toBe(op);
    expect(json.index).toBe(index);
  });
});
