import { describe, expect, it, vi, beforeEach } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { makeConfig } from "./helpers.js";

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

// Per-file model state behind the mocked createModel.
const state = vi.hoisted(() => ({
  model: undefined as unknown,
}));

vi.mock("../src/ai/provider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/provider.js")>()),
  createModel: () => state.model,
}));

const { buildApp } = await import("../src/app.js");

let prompts: string[];

function answering(obj: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: "text", text: JSON.stringify(obj) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

beforeEach(() => {
  prompts = [];
});

const validBody = {
  scenario: "Log in and see the dashboard",
  qa: {
    steps: [{ index: 1, tool: "browse_act", args: { op: "CLICK" }, ok: true }],
    checks: [{ source: "agent", check: { kind: "text", text: "Dashboard" }, passed: true }],
    consoleErrors: [],
  },
  page: { url: "https://example.com/dash", title: "Dashboard", text: "Welcome back" },
};

async function post(payload: unknown, overrides = {}) {
  const app = await buildApp(makeConfig(overrides), { logger: false });
  try {
    return await app.inject({ method: "POST", url: "/api/browse/judge", payload: payload as object });
  } finally {
    await app.close();
  }
}

describe("POST /api/browse/judge", () => {
  it("returns a pass verdict", async () => {
    state.model = answering({ verdict: "pass", reason: "The dashboard is shown." });
    const res = await post(validBody);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ verdict: "pass", reason: "The dashboard is shown." });
    expect(prompts[0]).toContain("Log in and see the dashboard");
  });

  it("returns a fail verdict", async () => {
    state.model = answering({ verdict: "fail", reason: "No dashboard." });
    const res = await post(validBody);
    expect(res.json()).toEqual({ verdict: "fail", reason: "No dashboard." });
  });

  it("answers disabled without a model call when QA_JUDGE_MODEL is off", async () => {
    state.model = answering({ verdict: "pass", reason: "x" });
    const res = await post(validBody, { QA_JUDGE_MODEL: "off" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ disabled: true });
    expect(prompts).toHaveLength(0);
  });

  it("answers 200 { error } when the model fails", async () => {
    state.model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("upstream exploded");
      },
    });
    const res = await post(validBody);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  it("answers 200 { error } when the model returns an object that fails the schema", async () => {
    state.model = answering({ verdict: "maybe" });
    const res = await post(validBody);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  it.each([
    ["missing scenario", { ...validBody, scenario: "" }],
    ["missing page", { scenario: "s", qa: validBody.qa }],
    ["too many steps", { ...validBody, qa: { steps: Array.from({ length: 31 }, (_, i) => ({ index: i, tool: "t", args: {}, ok: true })) } }],
  ])("answers 400 on a bad body: %s", async (_name, body) => {
    state.model = answering({ verdict: "pass", reason: "x" });
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(prompts).toHaveLength(0);
  });

  it("rejects a check record with the wrong shape", async () => {
    state.model = answering({ verdict: "pass", reason: "x" });
    const res = await post({ ...validBody, qa: { ...validBody.qa, checks: [{ kind: "text", passed: true }] } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects oversized step args", async () => {
    state.model = answering({ verdict: "pass", reason: "x" });
    const steps = [{ index: 1, tool: "t", args: { big: "x".repeat(3000) }, ok: true }];
    const res = await post({ ...validBody, qa: { steps } });
    expect(res.statusCode).toBe(400);
  });

  it("truncates an oversized page instead of rejecting it", async () => {
    state.model = answering({ verdict: "pass", reason: "ok" });
    const page = { url: "u".repeat(5000), title: "t".repeat(2000), text: "PAGEBODY".repeat(5000) };
    const res = await post({ ...validBody, page });
    expect(res.statusCode).toBe(200);
    expect(prompts[0]).not.toContain("u".repeat(4097));
  });

  it("answers disabled for any body", async () => {
    state.model = answering({ verdict: "pass", reason: "x" });
    const res = await post({ nonsense: true }, { QA_JUDGE_MODEL: "off" });
    expect(res.json()).toEqual({ disabled: true });
  });

  it("drops unknown keys so they never reach the prompt", async () => {
    state.model = answering({ verdict: "pass", reason: "ok" });
    const body = {
      ...validBody,
      verdict: "pass",
      qa: { ...validBody.qa, verdict: "SMUGGLED_VERDICT", reason: "SMUGGLED_REASON" },
    };
    const res = await post(body);
    expect(res.statusCode).toBe(200);
    expect(prompts[0]).not.toContain("SMUGGLED");
  });

  it("cuts a long judge reason", async () => {
    state.model = answering({ verdict: "pass", reason: "a".repeat(5000) });
    const res = await post(validBody);
    expect(res.statusCode).toBe(200);
    const json = res.json<{ verdict: string; reason: string }>();
    expect(json.verdict).toBe("pass");
    expect(json.reason.length).toBeLessThanOrEqual(500);
  });
});
