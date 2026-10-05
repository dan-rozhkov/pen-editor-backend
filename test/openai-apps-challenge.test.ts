import { describe, expect, it } from "vitest";
import { envSchema } from "../src/config.js";
import { startApp } from "./chatHarness.js";
import { makeConfig } from "./helpers.js";

const PATH = "/.well-known/openai-apps-challenge";

describe("OPENAI_APPS_CHALLENGE_TOKEN env", () => {
  it.each([
    ["", undefined],
    ["   ", undefined],
    ["  tok-123\n", "tok-123"],
  ])("%j -> %j", (raw, expected) => {
    const parsed = envSchema.parse({ OPENROUTER_API_KEY: "k", OPENAI_APPS_CHALLENGE_TOKEN: raw });
    expect(parsed.OPENAI_APPS_CHALLENGE_TOKEN).toBe(expected);
  });
});

describe(`GET ${PATH}`, () => {
  it("serves exactly the token as plain text, uncached; HEAD matches", async () => {
    const app = await startApp(makeConfig({ OPENAI_APPS_CHALLENGE_TOKEN: "tok-123" }));
    try {
      const res = await fetch(`${app.url}${PATH}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("tok-123");
      const head = await fetch(`${app.url}${PATH}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    } finally {
      await app.close();
    }
  });

  it("answers 404 for GET and HEAD when the token is unset", async () => {
    const app = await startApp(makeConfig());
    try {
      expect((await fetch(`${app.url}${PATH}`)).status).toBe(404);
      expect((await fetch(`${app.url}${PATH}`, { method: "HEAD" })).status).toBe(404);
    } finally {
      await app.close();
    }
  });
});
