import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import { getMCPTools } from "../src/ai/mcp.js";
import { textResult, toolCallResult } from "./reviewFakes.js";
import { OpenRouterBlockedError, installFetchGuard } from "../src/evals/fetchGuard.js";
import type { EvalTask } from "../src/evals/types.js";

const holders = vi.hoisted(() => ({ model: undefined as unknown }));

vi.mock("../src/ai/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/provider.js")>();
  return { ...actual, createModel: vi.fn(() => holders.model) };
});

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
  attachMobbinRelease: vi.fn(),
  releaseMCPTools: vi.fn(),
}));

function scripted(results: Array<LanguageModelV4GenerateResult | (() => Promise<LanguageModelV4GenerateResult>)>) {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const r = results[Math.min(call, results.length - 1)];
      call += 1;
      return typeof r === "function" ? r() : r;
    },
  });
}

const TASK: EvalTask = {
  id: "t-harness",
  suite: "regression",
  mode: "prototype",
  prompt: "mobile app for plants",
  graders: [{ type: "asked-first" }, { type: "embeds-present", min: 1 }, { type: "box-size", platform: "mobile" }],
  source: "test",
};

const OPS =
  'h=I(document, {type: "embed", name: "Home", x: 0, y: 0, width: 390, height: 844, htmlContent: "<html><body>hi</body></html>"})';

const slide = (name: string, x: number, op = "I(document,") =>
  `${op} {type: "embed", name: "${name}", x: ${x}, y: 0, width: 1024, height: 768, htmlContent: "<html><body>${name}</body></html>"})`;
const slideOps = (names: string[]) => names.map((n, i) => `s${i}=${slide(n, i * 1100)}`).join("\n");
const SLIDES_TASK: EvalTask = {
  ...TASK,
  mode: "slides",
  graders: [{ type: "filmstrip" }, { type: "html-complete" }, { type: "embeds-present", min: 5 }],
};
const neverSettles = () => new Promise<LanguageModelV4GenerateResult>(() => {});

describe("eval harness", () => {
  let runTrial: typeof import("../src/evals/harness.js").runTrial;
  const run = (task: EvalTask = TASK) =>
    runTrial({ task, trial: 1, config: makeConfig(), model: "opencode-go/deepseek-v4-pro", opencodeApiKey: "k" });

  beforeAll(async () => {
    await loadSkills();
    ({ runTrial } = await import("../src/evals/harness.js"));
  });

  beforeEach(() => {
    holders.model = scripted([textResult("ok")]);
  });

  let restore = () => {};
  afterEach(() => restore());

  it("records ask_user then batch_design in order and harvests the embed", async () => {
    holders.model = scripted([
      toolCallResult("ask_user", { questions: [{ id: "tone", label: "Tone?", type: "text" }] }),
      toolCallResult("batch_design", { operations: OPS }),
      textResult("done"),
    ]);
    const result = await run();
    expect(result.status).toBe("completed");
    expect(result.transcript.toolCalls.map((c) => c.name)).toEqual(["ask_user", "batch_design"]);
    expect(result.transcript.toolCalls[0].result).toContain("Decide for me");
    expect(result.transcript.finalText).toBe("done");
    expect(result.transcript.steps).toBe(3);
    expect(result.outcome.embeds).toMatchObject([{ name: "Home", width: 390, height: 844, x: 0, y: 0 }]);
    expect(result.outcome.batchOperations).toEqual([OPS]);
    expect(result.graders.map((g) => g.status)).toEqual(["pass", "pass", "pass"]);
    expect(result.passed).toBe(true);
  });

  it("does not retry: a thrown agent error is a failed trial", async () => {
    const model = scripted([() => Promise.reject(new Error("model exploded"))]);
    holders.model = model;
    const result = await run();
    expect(result.status).toBe("completed");
    expect(result.passed).toBe(false);
    expect(result.error).toContain("model exploded");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("skips a research task without MCP tools and never calls the model", async () => {
    const model = scripted([textResult("x")]);
    holders.model = model;
    const result = await run({ ...TASK, mode: "research", graders: [{ type: "grounded-refs" }] });
    expect(result).toMatchObject({ status: "skipped", reason: "no_mcp_tools" });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("research task: sends the /research prompt and the Mobbin token, skips without MCP tools", async () => {
    const model = scripted([textResult("x")]);
    holders.model = model;
    const researchTask: EvalTask = { ...TASK, mode: "research", prompt: "/research find refs", graders: [{ type: "grounded-refs" }] };
    const result = await runTrial({
      task: researchTask,
      trial: 1,
      config: makeConfig(),
      model: "opencode-go/deepseek-v4-pro",
      opencodeApiKey: "k",
      mobbinAccessToken: "mob-token",
    });
    expect(vi.mocked(getMCPTools).mock.calls.at(-1)?.[1]).toMatchObject({ mobbinAccessToken: "mob-token" });
    expect(result).toMatchObject({ status: "skipped", reason: "no_mcp_tools" });
    expect(result.outcome.injectedSkill).toBe("research");
  });

  it("research task: Mobbin tool names count as MCP tools and the trial runs", async () => {
    const search = tool({ description: "search", inputSchema: z.object({}), execute: async () => "https://m.example/s/1" });
    vi.mocked(getMCPTools).mockResolvedValueOnce({ search_screens: search });
    holders.model = scripted([toolCallResult("search_screens", {}), textResult("see https://m.example/s/1")]);
    const result = await runTrial({
      task: { ...TASK, mode: "research", prompt: "/research find refs", graders: [{ type: "grounded-refs" }] },
      trial: 1,
      config: makeConfig(),
      model: "opencode-go/deepseek-v4-pro",
      opencodeApiKey: "k",
      mobbinAccessToken: "mob-token",
    });
    expect(result.status).toBe("completed");
    expect(result.passed).toBe(true);
  });

  it("deletes OpenRouter-backed tools from the offered tool set", async () => {
    const model = scripted([textResult("ok")]);
    holders.model = model;
    await run();
    const offered = (model.doGenerateCalls[0].tools ?? []).map((t) => t.name);
    expect(offered).toContain("batch_design");
    expect(offered).not.toContain("analyze_image");
    expect(offered).not.toContain("get_screenshot");
  });

  it("records the skill prepareChatTurn injected itself", async () => {
    const result = await run();
    expect(result.outcome).toMatchObject({ injectedSkill: "prototype", skillSource: "slash" });
  });

  it("turns a stalled provider into infra_error timeout", async () => {
    holders.model = scripted([neverSettles]);
    const result = await runTrial({
      task: TASK,
      trial: 1,
      config: makeConfig(),
      model: "opencode-go/deepseek-v4-pro",
      opencodeApiKey: "k",
      timeoutMs: 25,
    });
    expect(result).toMatchObject({ status: "infra_error", reason: "timeout", passed: false });
  });

  it("replaces a re-emitted screen by name instead of appending", async () => {
    holders.model = scripted([
      toolCallResult("batch_design", { operations: slideOps(["S1", "S2", "S3", "S4", "S5"]) }),
      toolCallResult("batch_design", { operations: `r=${slide("S2", 1100, 'R("s1",')}`.replace("<body>S2", "<body>S2 fixed") }),
      textResult("done"),
    ]);
    const result = await run(SLIDES_TASK);
    expect(result.outcome.embeds.map((e) => e.name)).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    expect(result.outcome.embeds[1].htmlContent).toContain("S2 fixed");
    expect(result.graders.map((g) => g.status)).toEqual(["pass", "pass", "pass"]);
  });

  it("reports an openrouter.ai request as infra_error openrouter_blocked", async () => {
    restore = installFetchGuard();
    holders.model = scripted([
      async () => {
        await fetch("https://openrouter.ai/api/v1/chat/completions");
        return textResult("unreachable");
      },
    ]);
    const result = await run();
    expect(result.status).toBe("infra_error");
    expect(result.reason).toBe("openrouter_blocked");
    expect(result.blockedUrls).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
  });
});

describe("classifyInfraError", () => {
  it.each([
    [new DOMException("timed out", "TimeoutError")],
    [new DOMException("aborted", "AbortError")],
    [Object.assign(new Error("wrapped"), { cause: new DOMException("t", "TimeoutError") })],
  ])("recognises abort/timeout errors", async (err) => {
    const { classifyInfraError } = await import("../src/evals/harness.js");
    expect(classifyInfraError(err, [])).toBe("timeout");
  });
});

describe("fetch guard", () => {
  let restore = () => {};
  afterEach(() => restore());

  it("rejects openrouter.ai hosts and subdomains", async () => {
    restore = installFetchGuard();
    await expect(fetch("https://openrouter.ai/api/v1/models")).rejects.toBeInstanceOf(OpenRouterBlockedError);
    await expect(fetch(new URL("https://api.openrouter.ai/x"))).rejects.toBeInstanceOf(OpenRouterBlockedError);
  });

  it("lets other hosts through to the original fetch", async () => {
    const original = vi.fn(async () => new Response("ok"));
    globalThis.fetch = original as unknown as typeof fetch;
    const prev = globalThis.fetch;
    restore = installFetchGuard();
    const res = await fetch("https://example.com/x");
    expect(await res.text()).toBe("ok");
    expect(original).toHaveBeenCalledTimes(1);
    restore();
    expect(globalThis.fetch).toBe(prev);
  });
});
