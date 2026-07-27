import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import { pickTheme } from "../src/showcase/themes.js";

// ---------------------------------------------------------------------------
// Mocks: same seam as test/chat-route.test.ts — the provider and MCP layer
// are mocked so the runner never touches the network. runShowcaseGeneration
// goes through prepareChatTurn -> createModel/getMCPTools, so mocking those
// two modules is enough to control what "the LLM" does in each test.
// ---------------------------------------------------------------------------

const holders = vi.hoisted(() => ({
  model: undefined as unknown,
}));

vi.mock("../src/ai/provider.js", () => ({
  createModel: vi.fn(() => holders.model),
}));

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
}));

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function toolCallResult(
  toolName: string,
  input: Record<string, unknown>,
): LanguageModelV3GenerateResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: `call-${toolName}-${Math.random()}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: USAGE,
    warnings: [],
  };
}

function textResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: USAGE,
    warnings: [],
  };
}

// MockLanguageModelV3's array form of `doGenerate` indexes by
// `doGenerateCalls.length` *after* pushing the current call — i.e. 1-based,
// not 0-based — so passing the results array directly skips index 0 and
// eventually reads past the end. A plain counter avoids that off-by-one.
function mockModel(results: LanguageModelV3GenerateResult[]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const result = results[Math.min(call, results.length - 1)];
      call += 1;
      return result;
    },
  });
}

describe("runShowcaseGeneration", () => {
  let runShowcaseGeneration: typeof import("../src/showcase/runner.js").runShowcaseGeneration;

  beforeAll(async () => {
    await loadSkills();
    ({ runShowcaseGeneration } = await import("../src/showcase/runner.js"));
  });

  beforeEach(() => {
    holders.model = mockModel([textResult("ok")]);
  });

  it("collects embed screens produced via batch_design", async () => {
    holders.model = mockModel([
      toolCallResult("batch_design", {
        operations: [
          's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>Home</div>"})',
          's2=I(document, {type: "embed", name: "Profile", htmlContent: "<div>Profile</div>"})',
        ].join("\n"),
      }),
      textResult("done"),
    ]);

    const result = await runShowcaseGeneration(makeConfig(), "фитнес-трекер");

    expect(result.theme).toBe("фитнес-трекер");
    expect(result.model).toBe("deepseek/deepseek-v4-pro");
    expect(result.screens).toEqual([
      { name: "Home", htmlContent: "<div>Home</div>" },
      { name: "Profile", htmlContent: "<div>Profile</div>" },
    ]);
  });

  it("does not hang or throw when the model calls an unavailable tool like get_screenshot-equivalent stubs", async () => {
    holders.model = mockModel([
      toolCallResult("get_editor_state", { include_schema: false }),
      toolCallResult("batch_design", {
        operations: 's1=I(document, {type: "embed", name: "Only", htmlContent: "<div>Only</div>"})',
      }),
      textResult("done"),
    ]);

    const result = await runShowcaseGeneration(makeConfig(), "мобильный банк");

    expect(result.screens).toEqual([{ name: "Only", htmlContent: "<div>Only</div>" }]);
  });

  it("truncates to at most 5 screens when the model produces more", async () => {
    const operations = Array.from(
      { length: 7 },
      (_, i) =>
        `s${i}=I(document, {type: "embed", name: "Screen ${i}", htmlContent: "<div>${i}</div>"})`,
    ).join("\n");

    holders.model = mockModel([
      toolCallResult("batch_design", { operations }),
      textResult("done"),
    ]);

    const result = await runShowcaseGeneration(makeConfig(), "каршеринг");

    expect(result.screens).toHaveLength(5);
    expect(result.screens.map((s) => s.name)).toEqual([
      "Screen 0",
      "Screen 1",
      "Screen 2",
      "Screen 3",
      "Screen 4",
    ]);
  });

  it("returns an empty screens array without throwing when nothing was produced", async () => {
    holders.model = mockModel([textResult("I could not complete this task.")]);

    const result = await runShowcaseGeneration(makeConfig(), "трекер расходов");

    expect(result.screens).toEqual([]);
  });
});

describe("pickTheme", () => {
  const themes = ["a", "b", "c"];

  it("avoids themes in the recent list when possible", () => {
    const theme = pickTheme(themes, ["a", "b"], () => 0.4);
    expect(theme).toBe("c");
  });

  it("falls back to the full list when every theme is recent", () => {
    const theme = pickTheme(themes, ["a", "b", "c"], () => 0.4);
    expect(themes).toContain(theme);
  });

  it("is deterministic given a fixed random() value", () => {
    expect(pickTheme(themes, [], () => 0)).toBe("a");
    expect(pickTheme(themes, [], () => 0.99)).toBe("c");
  });
});
