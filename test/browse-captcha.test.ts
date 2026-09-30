import { describe, expect, it, vi, afterEach } from "vitest";
import { detectBotWall } from "../src/ai/browseCaptcha.js";
import { makeConfig } from "./helpers.js";

const { buildApp } = await import("../src/app.js");

afterEach(() => vi.unstubAllGlobals());

const el = (label: string, extra: Record<string, unknown> = {}) => ({
  index: 1,
  tag: "div",
  label,
  ops: ["CLICK" as const],
  ...extra,
});
const page = (o: Partial<Parameters<typeof detectBotWall>[0]> = {}) => ({
  url: "https://example.com/",
  title: "Example",
  elements: [],
  pageText: "",
  ...o,
});

describe("detectBotWall", () => {
  it("flags the Google /sorry/ URL", () => {
    expect(detectBotWall(page({ url: "https://www.google.com/sorry/index?continue=x" }))).toMatch(/sorry/);
    expect(detectBotWall(page({ url: "https://www.google.co.uk/sorry/index" }))).not.toBeNull();
  });
  it("flags an 'I'm not a robot' control", () => {
    expect(detectBotWall(page({ elements: [el("I'm not a robot")] }))).not.toBeNull();
    expect(detectBotWall(page({ elements: [el("I am not a robot")] }))).not.toBeNull();
    expect(detectBotWall(page({ elements: [el("Verify you are human")] }))).not.toBeNull();
    expect(detectBotWall(page({ elements: [el("Press & Hold")] }))).not.toBeNull();
  });
  it("flags the unusual-traffic text", () => {
    expect(
      detectBotWall(page({ pageText: "Our systems have detected unusual traffic from your computer network." })),
    ).not.toBeNull();
  });
  it("flags a Cloudflare challenge", () => {
    expect(detectBotWall(page({ url: "https://x.com/cdn-cgi/challenge-platform/h/b/orchestrate" }))).not.toBeNull();
    expect(
      detectBotWall(page({ title: "Just a moment...", pageText: "Checking your browser before accessing x.com" })),
    ).not.toBeNull();
  });
  it("needs two weak signals", () => {
    expect(detectBotWall(page({ url: "https://x.com/captcha/verify" }))).toBeNull();
    expect(detectBotWall(page({ url: "https://x.com/captcha/verify", title: "Just a moment..." }))).not.toBeNull();
    expect(detectBotWall(page({ title: "Just a moment..." }))).toBeNull();
    expect(detectBotWall(page({ pageText: "Please complete the security check to continue." }))).toBeNull();
  });
  it("does not flag normal pages", () => {
    expect(
      detectBotWall(
        page({
          url: "https://www.google.com/travel/flights?q=Flights",
          title: "Google Flights",
          elements: [el("Where from?"), el("Search")],
          pageText: "Round trip 1 passenger Economy Search",
        }),
      ),
    ).toBeNull();
    expect(
      detectBotWall(
        page({
          url: "https://en.wikipedia.org/wiki/CAPTCHA",
          title: "CAPTCHA - Wikipedia",
          pageText:
            "A CAPTCHA is a type of challenge-response test used to determine whether the user is human. reCAPTCHA was acquired by Google.",
        }),
      ),
    ).toBeNull();
    expect(
      detectBotWall(
        page({
          url: "https://example.com/login",
          title: "Sign in",
          elements: [el("Email"), el("Password"), el("Sign in")],
          pageText: "Sign in to your account. Forgot password?",
        }),
      ),
    ).toBeNull();
  });
});

describe("POST /api/browse/step CAPTCHA guard", () => {
  for (const policy of ["ultrafast", "legacy"] as const) {
    it(`blocks without calling Jev (${policy})`, async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const app = await buildApp(makeConfig({ TYPESAFE_API_KEY: "key", BROWSE_STEP_POLICY: policy }), {
        logger: false,
      });
      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/browse/step",
          payload: {
            goal: "find flights",
            url: "https://www.google.com/sorry/index?continue=x",
            title: "https://www.google.com/search?q=flights",
            elements: [{ index: 2, tag: "div", label: "I'm not a robot", ops: ["CLICK"] }],
            history: [],
            pageText: "Our systems have detected unusual traffic from your computer network.",
          },
        });
        expect(res.statusCode).toBe(200);
        const json = res.json();
        expect(json.outcome).toBe("blocked");
        expect(json.operation).toBe("BLOCKED");
        expect(json.reason).toMatch(/CAPTCHA/);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });
  }
});
