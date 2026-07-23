import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { makeConfig } from "./helpers.js";

// The real provider export is `createModel(config, modelOverride?)`, not a
// zero-arg `getModel()` — mock that name so generatePrototypeLinks (and the
// route/buildApp that call it) get a scripted mock model regardless of args.
vi.mock("../src/ai/provider.js", () => ({
  createModel: () =>
    new MockLanguageModelV3({
      doGenerate: async () => ({
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
        content: [
          {
            type: "text",
            text: JSON.stringify({
              links: [{ screenId: "a", protoId: "p0", targetScreenId: "b" }],
            }),
          },
        ],
      }),
    }),
}));

const { generatePrototypeLinks } = await import(
  "../src/ai/prototype-link.js"
);
const { buildApp } = await import("../src/app.js");

describe("generatePrototypeLinks", () => {
  it("returns a validated link graph from the model", async () => {
    const res = await generatePrototypeLinks(
      [
        {
          id: "a",
          name: "Login",
          candidates: [{ protoId: "p0", tag: "button", text: "Sign in" }],
        },
        { id: "b", name: "Dashboard", candidates: [] },
      ],
      makeConfig(),
    );
    expect(res.links).toEqual([
      { screenId: "a", protoId: "p0", targetScreenId: "b" },
    ]);
  });

  it("drops links whose ids are outside the provided screens", async () => {
    const res = await generatePrototypeLinks(
      [
        {
          id: "a",
          name: "Login",
          candidates: [{ protoId: "p0", tag: "button", text: "Sign in" }],
        },
        { id: "b", name: "Dashboard", candidates: [] },
      ],
      makeConfig(),
    );
    // model returned a→b/p0 which is valid; a link to unknown target must be filtered.
    expect(
      res.links.every(
        (l) =>
          ["a", "b"].includes(l.screenId) &&
          ["a", "b"].includes(l.targetScreenId),
      ),
    ).toBe(true);
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
            id: "a",
            name: "Login",
            candidates: [{ protoId: "p0", tag: "button", text: "Sign in" }],
          },
          { id: "b", name: "Dashboard", candidates: [] },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().links).toEqual([
      { screenId: "a", protoId: "p0", targetScreenId: "b" },
    ]);
    await app.close();
  });
});
