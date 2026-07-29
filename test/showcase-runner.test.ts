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

const imageGenMock = vi.hoisted(() => ({ generateImage: vi.fn() }));
vi.mock("../src/services/imageGen.js", () => imageGenMock);

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
  let MAX_GENERATED_IMAGES: number;
  let SHOWCASE_MODEL_ID: string;

  beforeAll(async () => {
    await loadSkills();
    ({ runShowcaseGeneration, MAX_GENERATED_IMAGES, SHOWCASE_MODEL_ID } = await import(
      "../src/showcase/runner.js"
    ));
  });

  beforeEach(() => {
    holders.model = mockModel([textResult("ok")]);
    imageGenMock.generateImage.mockReset();
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

    const result = await runShowcaseGeneration(makeConfig(), "fitness tracker");

    expect(result.theme).toBe("fitness tracker");
    expect(result.model).toBe(SHOWCASE_MODEL_ID);
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


  it("puts a generated image URL in front of the model instead of a placeholder", async () => {
    imageGenMock.generateImage.mockResolvedValue({
      url: "https://s3.test/generated.png",
      mimeType: "image/png",
    });
    holders.model = mockModel([
      toolCallResult("generate_image", { prompt: "hero shot of a running trail at dawn" }),
      textResult("done"),
    ]);

    await runShowcaseGeneration(makeConfig(), "fitness tracker");

    expect(imageGenMock.generateImage).toHaveBeenCalledOnce();
    const [, prompt] = imageGenMock.generateImage.mock.calls[0];
    expect(prompt).toContain("running trail");
  });

  // A timed-out image must not take the run down with it, and must not leave a
  // hole in the design — the agent needs a usable URL back either way.
  it("answers with a placeholder URL when image generation fails", async () => {
    imageGenMock.generateImage.mockRejectedValue(new Error("timed out"));
    holders.model = mockModel([
      toolCallResult("generate_image", { prompt: "hero shot" }),
      toolCallResult("batch_design", {
        operations: 's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>x</div>"})',
      }),
      textResult("done"),
    ]);

    const result = await runShowcaseGeneration(makeConfig(), "fitness tracker");

    // The run completed and still produced its screen.
    expect(result.screens).toHaveLength(1);
  });

  it("stops generating past the per-run image budget", async () => {
    imageGenMock.generateImage.mockResolvedValue({
      url: "https://s3.test/generated.png",
      mimeType: "image/png",
    });
    // Always answer with another generate_image call; the cap — not the model
    // — has to be what stops the spend.
    holders.model = mockModel([
      toolCallResult("generate_image", { prompt: "another one" }),
    ]);

    await runShowcaseGeneration(makeConfig(), "fitness tracker");

    expect(imageGenMock.generateImage.mock.calls.length).toBe(MAX_GENERATED_IMAGES);
  });

  it("returns an empty screens array without throwing when nothing was produced", async () => {
    holders.model = mockModel([textResult("I could not complete this task.")]);

    const result = await runShowcaseGeneration(makeConfig(), "трекер расходов");

    expect(result.screens).toEqual([]);
  });
});

describe("buildShowcasePrompt", () => {
  // Imported the same lazy way as runShowcaseGeneration above: runner.js pulls
  // in the skills registry at module load.
  let buildShowcasePrompt: typeof import("../src/showcase/runner.js").buildShowcasePrompt;

  beforeAll(async () => {
    await loadSkills();
    ({ buildShowcasePrompt } = await import("../src/showcase/runner.js"));
  });

  it("omits the palette clause when there is nothing to avoid", () => {
    const prompt = buildShowcasePrompt("sleep tracker");
    expect(prompt).not.toContain("Palette:");
    expect(buildShowcasePrompt("sleep tracker", { avoidHueFamilies: [] })).toBe(prompt);
  });

  it("names the hue families recent apps used and demands a different one", () => {
    const prompt = buildShowcasePrompt("sleep tracker", {
      avoidHueFamilies: ["terracotta/amber", "green/emerald"],
    });
    expect(prompt).toContain("terracotta/amber, green/emerald");
    expect(prompt).toContain("DIFFERENT family");
    // Narrowing the palette space must not read as "the banned colors are
    // back on the table" — the first rotated run answered the clause with
    // electric violet, the one accent the skill bans outright.
    expect(prompt).toContain("does NOT suspend any rule in the skill");
    expect(prompt).toMatch(/ban on purple/i);
    // The clause must not push the theme or the imagery instructions out.
    expect(prompt).toContain("/prototype mobile app — sleep tracker");
    expect(prompt).toContain("generate_image");
  });

  it("defaults to the mobile subject phrase when no platform is given", () => {
    expect(buildShowcasePrompt("sleep tracker")).toContain(
      "/prototype mobile app — sleep tracker",
    );
    expect(buildShowcasePrompt("sleep tracker", { platform: "mobile" })).toContain(
      "/prototype mobile app — sleep tracker",
    );
  });

  it("uses the desktop web app subject phrase for platform: desktop", () => {
    // This exact phrase is what routes src/skills/prototype.md into its
    // "Otherwise (default desktop)" device preset (1440x1024) instead of the
    // mobile/phone branch (375x812) — the skill matches on wording, not a
    // flag, so the literal string is load-bearing.
    const prompt = buildShowcasePrompt("sleep tracker", { platform: "desktop" });
    expect(prompt).toContain("/prototype desktop web app — sleep tracker");
    expect(prompt).not.toContain("mobile app");
    // The rest of the prompt (screen count, style, imagery) stays identical.
    expect(prompt).toContain("up to 5 screens of a single user flow");
    expect(prompt).toContain("generate_image");
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
