import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { makeConfig } from "./helpers.js";

// The real provider export is `createModel(config, modelOverride?)`, not a
// zero-arg `getModel()` — mock that name so generatePrototypeLinks (and the
// route/buildApp that call it) get a scripted mock model regardless of args.
// `createModel` is a vi.fn so individual tests can script a different
// response via mockReturnValueOnce.
const createModel = vi.fn(() =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
      content: [
        {
          type: "text",
          text: JSON.stringify({
            links: [
              { screenId: "login", protoId: "p0", targetScreenId: "dashboard" },
            ],
          }),
        },
      ],
    }),
  }),
);

vi.mock("../src/ai/provider.js", () => ({
  createModel: (...args: unknown[]) => createModel(...args),
}));

function modelReturning(links: unknown[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
      content: [
        {
          type: "text",
          text: JSON.stringify({ links }),
        },
      ],
    }),
  });
}

const { generatePrototypeLinks } = await import(
  "../src/ai/prototype-link.js"
);
const { buildApp } = await import("../src/app.js");

describe("generatePrototypeLinks", () => {
  it("returns a validated link graph from the model", async () => {
    const res = await generatePrototypeLinks(
      [
        {
          id: "login",
          name: "Login",
          candidates: [{ protoId: "p0", tag: "button", text: "Sign in" }],
        },
        { id: "dashboard", name: "Dashboard", candidates: [] },
      ],
      makeConfig(),
    );
    expect(res.links).toEqual([
      { screenId: "login", protoId: "p0", targetScreenId: "dashboard" },
    ]);
  });

  it("drops links whose ids are outside the provided screens", async () => {
    const res = await generatePrototypeLinks(
      [
        {
          id: "login",
          name: "Login",
          candidates: [{ protoId: "p0", tag: "button", text: "Sign in" }],
        },
        { id: "dashboard", name: "Dashboard", candidates: [] },
      ],
      makeConfig(),
    );
    // model returned login→dashboard/p0 which is valid; a link to unknown
    // target must be filtered.
    expect(
      res.links.every(
        (l) =>
          ["login", "dashboard"].includes(l.screenId) &&
          ["login", "dashboard"].includes(l.targetScreenId),
      ),
    ).toBe(true);
  });

  it("resolves a targetScreenId returned as a screen name or wrong case to the correct slug", async () => {
    createModel.mockReturnValueOnce(
      modelReturning([
        // model echoed the screen's display NAME instead of its slug id
        { screenId: "login", protoId: "p0", targetScreenId: "Dashboard" },
        // model echoed the id with wrong case
        { screenId: "login", protoId: "p1", targetScreenId: "PRICING" },
      ]),
    );
    const res = await generatePrototypeLinks(
      [
        {
          id: "login",
          name: "Login",
          candidates: [
            { protoId: "p0", tag: "button", text: "Sign in" },
            { protoId: "p1", tag: "a", text: "Pricing" },
          ],
        },
        { id: "dashboard", name: "Dashboard", candidates: [] },
        { id: "pricing", name: "Pricing", candidates: [] },
      ],
      makeConfig(),
    );
    expect(res.links).toEqual([
      { screenId: "login", protoId: "p0", targetScreenId: "dashboard" },
      { screenId: "login", protoId: "p1", targetScreenId: "pricing" },
    ]);
  });

  it("includes each candidate's classHint in the prompt sent to the model", async () => {
    let captured = "";
    createModel.mockReturnValueOnce(
      new MockLanguageModelV3({
        doGenerate: async (opts: { prompt: unknown }) => {
          captured = JSON.stringify(opts.prompt);
          return {
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
            content: [{ type: "text", text: JSON.stringify({ links: [] }) }],
          };
        },
      }),
    );
    await generatePrototypeLinks(
      [
        {
          id: "home",
          name: "Home",
          candidates: [
            { protoId: "p0", tag: "div", text: "Monstera Deliciosa", classHint: "plant-card" },
          ],
        },
        { id: "detail", name: "Plant Detail", candidates: [] },
      ],
      makeConfig(),
    );
    // The class hint must reach the model so it can reason that a `plant-card`
    // navigates to a plant detail screen even when its text is just a name.
    expect(captured).toContain("plant-card");
  });

  it("instructs the model to wire a theme toggle to the opposite-theme screen variant", async () => {
    let captured = "";
    createModel.mockReturnValueOnce(
      new MockLanguageModelV3({
        doGenerate: async (opts: { prompt: unknown }) => {
          captured = JSON.stringify(opts.prompt);
          return {
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
            content: [{ type: "text", text: JSON.stringify({ links: [] }) }],
          };
        },
      }),
    );
    await generatePrototypeLinks(
      [
        {
          id: "settings",
          name: "Settings",
          candidates: [
            { protoId: "p0", tag: "div", text: "Dark mode", classHint: "setting-row" },
          ],
        },
        { id: "settings-dark", name: "Settings Dark", candidates: [] },
      ],
      makeConfig(),
    );
    expect(captured.toLowerCase()).toContain("dark mode");
    // The prompt must NOT tell the model to unconditionally skip theme switches.
    expect(captured.toLowerCase()).not.toContain("theme switch, and similar");
  });

  it("accepts an optional content excerpt on screens without affecting resolution", async () => {
    const res = await generatePrototypeLinks(
      [
        {
          id: "login",
          name: "Login",
          content: "Welcome back. Email, password, Sign in.",
          candidates: [{ protoId: "p0", tag: "button", text: "Sign in" }],
        },
        {
          id: "dashboard",
          name: "Dashboard",
          content: "Your projects. Recent activity.",
          candidates: [],
        },
      ],
      makeConfig(),
    );
    expect(res.links).toEqual([
      { screenId: "login", protoId: "p0", targetScreenId: "dashboard" },
    ]);
  });
});

describe("POST /api/prototype-link", () => {
  it("400s on empty screens", async () => {
    const app = await buildApp(makeConfig(), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/prototype-link",
      payload: { screens: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns links for valid screens", async () => {
    const app = await buildApp(makeConfig(), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/prototype-link",
      payload: {
        screens: [
          {
            id: "login",
            name: "Login",
            candidates: [
              { protoId: "p0", tag: "button", text: "Sign in", classHint: "btn primary" },
            ],
          },
          { id: "dashboard", name: "Dashboard", candidates: [] },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().links).toEqual([
      { screenId: "login", protoId: "p0", targetScreenId: "dashboard" },
    ]);
    await app.close();
  });
});
